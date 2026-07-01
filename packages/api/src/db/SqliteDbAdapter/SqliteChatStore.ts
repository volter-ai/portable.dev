/**
 * SqliteChatStore - SQLite-backed storage for chats and messages
 *
 * Replaces JsonChatStore's JSON files with a SQLite database on
 * the per-user workspace volume. JSON was secure (data stays in the isolated
 * user volume) but fragile: one torn write or malformed JSONL line made
 * JSON.parse throw and blocked ALL chat reads for the user. SQLite writes are
 * transactional (no torn files), and a single bad row fails in isolation —
 * row mapping below is lenient and skips corrupt rows instead of throwing.
 *
 * Layout (under `dataDir`, default `<WORKSPACE_DIR>/.chat-data`):
 *   chats.sqlite        Single database file (WAL mode) holding the `chats`
 *                       and `messages` tables. Rows use the snake_case
 *                       `chats` shape via the shared ChatRow type so reads
 *                       remain a drop-in replacement.
 *
 * Isolation: each user runs in a single backend instance, so a flat (non per-user)
 * layout is sufficient — same model as JsonChatStore. Chat rows carry `user_id`
 * and reads filter on it; messages are keyed by the globally-unique chatId.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { Database } from 'bun:sqlite';

import type { ChatRow, MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

/** Filename of the SQLite database inside the chat data directory. */
export const SQLITE_DB_FILE = 'chats.sqlite';

/** Raw `chats` table row (booleans as 0/1 integers, linked_issue as JSON text). */
interface DbChatRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  summary: string | null;
  status: string | null;
  hidden: number;
  archived: number;
  saved: number;
  pinned: number;
  last_updated: number;
  repo_path: string | null;
  repo_full_name: string | null;
  session_id: string | null;
  fork_source_session_id: string | null;
  system_prompt: string | null;
  playwright_device: string | null;
  model: string;
  permissions: string;
  effort: string | null;
  agent_setup_id: string | null;
  parent_chat_id: string | null;
  workflow_run_id: string | null;
  routine_id: string | null;
  last_read_message_id: number | null;
  linked_issue: string | null;
  created_at: number;
}

/** Raw `messages` table row (data as JSON text). */
interface DbMessageRow {
  id: number;
  type: string;
  data: string | null;
  timestamp: number;
}

const CHAT_COLUMNS =
  'id, user_id, type, title, summary, status, hidden, archived, saved, pinned, last_updated, ' +
  'repo_path, repo_full_name, session_id, fork_source_session_id, system_prompt, playwright_device, model, permissions, ' +
  'effort, agent_setup_id, parent_chat_id, workflow_run_id, routine_id, ' +
  'last_read_message_id, linked_issue, created_at';
const CHAT_PLACEHOLDERS = CHAT_COLUMNS.split(',')
  .map(() => '?')
  .join(', ');

export class SqliteChatStore {
  private readonly dbPath: string;
  private db!: Database;

  constructor(private readonly dataDir: string) {
    this.dbPath = path.join(dataDir, SQLITE_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn main-db writes. This file may live on a network/FUSE-backed
    // filesystem where WAL's shared-memory
    // mmap (-shm file) may be unsupported — so probe a real write transaction
    // (forcing the shm/wal machinery NOW, not at the first user write) and fall
    // back to a TRUNCATE rollback journal instead of failing server startup.
    // TRUNCATE needs only kernel-local fcntl locks, fine for our single-writer
    // single-sandbox access model.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteChatStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
        error
      );
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No transaction was open.
      }
      this.db.exec('PRAGMA journal_mode = TRUNCATE');
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        status TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        saved INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL,
        repo_path TEXT,
        repo_full_name TEXT,
        session_id TEXT,
        fork_source_session_id TEXT,
        system_prompt TEXT,
        playwright_device TEXT,
        model TEXT NOT NULL,
        permissions TEXT NOT NULL,
        effort TEXT,
        agent_setup_id TEXT,
        parent_chat_id TEXT,
        workflow_run_id TEXT,
        routine_id TEXT,
        last_read_message_id INTEGER,
        linked_issue TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, archived, last_updated);
      CREATE INDEX IF NOT EXISTS idx_chats_workflow_run ON chats(workflow_run_id);
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);
    `);
    // Add the saved/pinned columns to a PRE-EXISTING chats table (CREATE TABLE IF NOT
    // EXISTS above is a no-op once the table exists, so a DB created before this change
    // would otherwise be missing them). ALTER throws "duplicate column" once present —
    // caught so this stays idempotent.
    for (const col of ['saved', 'pinned'] as const) {
      try {
        this.db.exec(`ALTER TABLE chats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      } catch {
        // Column already exists.
      }
    }
    // Add fork_source_session_id (fork-on-first-write) + repo_full_name + effort to a
    // PRE-EXISTING chats table the same way — nullable TEXT, idempotent (ALTER throws
    // once present, caught). repo_full_name was previously synthesized-only (never a
    // column); it is now persisted so a forked/native chat's card shows the repo name.
    // effort is unset (null) until a user explicitly picks a reasoning-effort level —
    // the SDK applies its own default when the field is omitted.
    for (const col of ['fork_source_session_id', 'repo_full_name', 'effort'] as const) {
      try {
        this.db.exec(`ALTER TABLE chats ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists.
      }
    }
    // Auto-pilot was removed entirely (Claude Code's native /loop replaces it). Drop the
    // legacy autopilot_* columns from any PRE-EXISTING chats table — idempotent (DROP throws
    // once the column is gone / never existed, caught).
    for (const col of [
      'autopilot_enabled',
      'autopilot_continue_count',
      'autopilot_max_continues',
    ] as const) {
      try {
        this.db.exec(`ALTER TABLE chats DROP COLUMN ${col}`);
      } catch {
        // Column already dropped / never existed.
      }
    }
  }

  close(): void {
    this.db?.close();
  }

  // ==========================================================================
  // Row mapping (lenient: a corrupt row is skipped, never fatal)
  // ==========================================================================

  private chatRowFromDb(raw: DbChatRow): ChatRow {
    let linkedIssue: ChatRow['linked_issue'] = null;
    if (raw.linked_issue) {
      try {
        linkedIssue = JSON.parse(raw.linked_issue);
      } catch {
        console.warn(`[SqliteChatStore] Skipping corrupt linked_issue on chat ${raw.id}`);
      }
    }
    return {
      ...raw,
      hidden: !!raw.hidden,
      archived: !!raw.archived,
      saved: !!raw.saved,
      pinned: !!raw.pinned,
      linked_issue: linkedIssue,
    };
  }

  private messageRowFromDb(raw: DbMessageRow, chatId: string): MessageRow {
    let data: any = null;
    if (raw.data !== null) {
      try {
        data = JSON.parse(raw.data);
      } catch {
        console.warn(`[SqliteChatStore] Corrupt message data (chat ${chatId}, id ${raw.id})`);
      }
    }
    return { id: raw.id, type: raw.type, data, timestamp: raw.timestamp };
  }

  private writeChatRow(row: ChatRow): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO chats (${CHAT_COLUMNS}) VALUES (${CHAT_PLACEHOLDERS})`)
      .run(
        row.id,
        row.user_id,
        row.type,
        row.title,
        row.summary,
        row.status,
        row.hidden ? 1 : 0,
        row.archived ? 1 : 0,
        row.saved ? 1 : 0,
        row.pinned ? 1 : 0,
        row.last_updated,
        row.repo_path,
        row.repo_full_name ?? null,
        row.session_id,
        row.fork_source_session_id ?? null,
        row.system_prompt,
        row.playwright_device,
        row.model,
        row.permissions,
        row.effort ?? null,
        row.agent_setup_id,
        row.parent_chat_id,
        row.workflow_run_id,
        row.routine_id,
        row.last_read_message_id,
        row.linked_issue === null ? null : JSON.stringify(row.linked_issue),
        row.created_at
      );
  }

  // ==========================================================================
  // Chats
  // ==========================================================================

  async readAllChats(): Promise<Map<string, ChatRow>> {
    const chats = new Map<string, ChatRow>();
    for (const raw of this.db.prepare<DbChatRow>('SELECT * FROM chats').all()) {
      try {
        chats.set(raw.id, this.chatRowFromDb(raw));
      } catch (error) {
        // One bad row must never block the rest of the user's chats.
        console.warn(`[SqliteChatStore] Skipping corrupt chat row ${raw?.id}:`, error);
      }
    }
    return chats;
  }

  async getChat(chatId: string): Promise<ChatRow | undefined> {
    const raw = this.db.prepare<DbChatRow>('SELECT * FROM chats WHERE id = ?').get(chatId);
    return raw ? this.chatRowFromDb(raw) : undefined;
  }

  /** Upsert a chat row produced by the caller (already merged with existing). */
  async upsertChat(
    chatId: string,
    build: (existing: ChatRow | undefined) => ChatRow
  ): Promise<void> {
    this.writeChatRow(build(await this.getChat(chatId)));
  }

  /**
   * Apply a partial patch to an existing chat (owned by userId).
   * Returns true if the chat existed and was updated, false otherwise.
   * `mutate` receives the row and returns the new value to set (allowing
   * computed updates derived from the existing row).
   */
  async patchChat(
    chatId: string,
    userId: string,
    mutate: (row: ChatRow) => Partial<ChatRow>
  ): Promise<boolean> {
    const row = await this.getChat(chatId);
    if (!row || row.user_id !== userId) {
      return false;
    }
    this.writeChatRow({ ...row, ...mutate(row), last_updated: Date.now() });
    return true;
  }

  async deleteChat(chatId: string, userId: string): Promise<boolean> {
    const row = await this.getChat(chatId);
    if (!row || row.user_id !== userId) {
      return false;
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
    })();
    return true;
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  async readMessages(chatId: string): Promise<MessageRow[]> {
    return this.db
      .prepare<DbMessageRow>(
        'SELECT id, type, data, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp ASC, id ASC'
      )
      .all(chatId)
      .map((raw) => this.messageRowFromDb(raw, chatId));
  }

  async getMessageCount(chatId: string): Promise<number> {
    const row = this.db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(chatId);
    return row?.n ?? 0;
  }

  /**
   * Append a message to the chat's stream, assigning a sequential numeric id,
   * and bump the chat's last_updated timestamp. Returns the assigned id.
   */
  async appendMessage(chatId: string, type: string, data: any, timestamp: number): Promise<number> {
    let id = 0;
    this.db.transaction(() => {
      const max = this.db
        .prepare<{ m: number | null }>('SELECT MAX(id) AS m FROM messages WHERE chat_id = ?')
        .get(chatId);
      id = (max?.m ?? 0) + 1;
      this.db
        .prepare('INSERT INTO messages (chat_id, id, type, data, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run(chatId, id, type, data === undefined ? null : JSON.stringify(data), timestamp);
      // Bump last_updated on the owning chat (best-effort, mirrors JsonChatStore).
      this.db.prepare('UPDATE chats SET last_updated = ? WHERE id = ?').run(timestamp, chatId);
    })();
    return id;
  }

  // ==========================================================================
  // Legacy JSON import (migration)
  // ==========================================================================

  /**
   * Bulk-import legacy rows in a single transaction. `INSERT OR IGNORE` makes
   * the import idempotent: if a previous attempt committed but its marker write
   * failed, re-running never duplicates or clobbers rows.
   */
  importLegacy(chats: ChatRow[], messagesByChat: Map<string, MessageRow[]>): void {
    this.db.transaction(() => {
      const insertChat = this.db.prepare(
        `INSERT OR IGNORE INTO chats (${CHAT_COLUMNS}) VALUES (${CHAT_PLACEHOLDERS})`
      );
      for (const row of chats) {
        insertChat.run(
          row.id,
          row.user_id,
          row.type,
          row.title,
          row.summary,
          row.status,
          row.hidden ? 1 : 0,
          row.archived ? 1 : 0,
          row.saved ? 1 : 0,
          row.pinned ? 1 : 0,
          row.last_updated,
          row.repo_path,
          row.repo_full_name ?? null,
          row.session_id,
          row.fork_source_session_id ?? null,
          row.system_prompt,
          row.playwright_device,
          row.model,
          row.permissions,
          row.effort ?? null,
          row.agent_setup_id,
          row.parent_chat_id,
          row.workflow_run_id,
          row.routine_id,
          row.last_read_message_id,
          row.linked_issue === null ? null : JSON.stringify(row.linked_issue),
          row.created_at
        );
      }
      const insertMessage = this.db.prepare(
        'INSERT OR IGNORE INTO messages (chat_id, id, type, data, timestamp) VALUES (?, ?, ?, ?, ?)'
      );
      for (const [chatId, rows] of messagesByChat) {
        for (const m of rows) {
          insertMessage.run(
            chatId,
            m.id,
            m.type,
            m.data === undefined ? null : JSON.stringify(m.data),
            m.timestamp
          );
        }
      }
    })();
  }
}
