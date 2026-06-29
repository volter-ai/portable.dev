/**
 * JsonToSqliteMigrator - one-time, automatic JSON → SQLite chat data migration
 *
 * Users whose volume still holds JsonChatStore data (`chats.json`
 * + `messages/*.jsonl` under the chat data dir) are migrated into SQLite
 * automatically on sandbox startup — no user action.
 *
 * Guarantees:
 * - Runs exactly once: after a migration attempt completes, a marker file is
 *   written into the chat data directory itself and all later startups skip.
 * - Non-destructive: the original JSON files are NEVER modified or deleted,
 *   so data can be recovered manually if anything goes wrong.
 * - Resilient: a malformed JSONL line (or even a fully corrupt chats.json) is
 *   skipped and counted in the marker instead of aborting the migration —
 *   exactly the failure mode that motivated leaving JSON (one bad record must
 *   not take down chat storage).
 * - Idempotent under crashes: rows import in one transaction with
 *   INSERT OR IGNORE; if the process dies before the marker is written, the
 *   next startup simply re-runs the import as a no-op.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import type { SqliteChatStore } from './SqliteChatStore.js';
import type { ChatRow, MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

/** Marker file written into the chat data dir after a migration attempt. */
export const SQLITE_MIGRATION_MARKER = '.migrated-to-sqlite.json';

export interface MigrationResult {
  /** False when there was nothing to migrate (fresh volume or already done). */
  migrated: boolean;
  chatsImported: number;
  chatsSkipped: number;
  messagesImported: number;
  messagesSkipped: number;
  /** Present when chats.json existed but could not be parsed at all. */
  chatsJsonError?: string;
}

const NOTHING_TO_MIGRATE: MigrationResult = {
  migrated: false,
  chatsImported: 0,
  chatsSkipped: 0,
  messagesImported: 0,
  messagesSkipped: 0,
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a legacy chats.json entry into a full ChatRow, defaulting fields
 * that older rows may predate. Returns null for entries too broken to import.
 */
function normalizeLegacyChat(id: string, raw: any): ChatRow | null {
  if (!raw || typeof raw !== 'object' || typeof raw.user_id !== 'string') {
    return null;
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : id,
    user_id: raw.user_id,
    type: raw.type ?? 'claude_code',
    title: raw.title ?? '',
    summary: raw.summary ?? null,
    status: raw.status ?? null,
    hidden: !!raw.hidden,
    archived: !!raw.archived,
    last_updated: typeof raw.last_updated === 'number' ? raw.last_updated : Date.now(),
    repo_path: raw.repo_path ?? null,
    session_id: raw.session_id ?? null,
    system_prompt: raw.system_prompt ?? null,
    playwright_device: raw.playwright_device ?? null,
    model: raw.model ?? 'opus',
    permissions: raw.permissions ?? 'bypass_permissions',
    agent_setup_id: raw.agent_setup_id ?? null,
    parent_chat_id: raw.parent_chat_id ?? null,
    workflow_run_id: raw.workflow_run_id ?? null,
    routine_id: raw.routine_id ?? null,
    last_read_message_id: raw.last_read_message_id ?? null,
    linked_issue: raw.linked_issue ?? null,
    created_at: typeof raw.created_at === 'number' ? raw.created_at : Date.now(),
  };
}

/**
 * Check for legacy JSON chat data and import it into the SQLite store.
 * Called from SqliteDbAdapter.initialize() on every startup; cheap no-op when
 * the marker exists or the volume has no legacy files.
 */
export async function migrateJsonToSqlite(
  dataDir: string,
  store: SqliteChatStore
): Promise<MigrationResult> {
  const markerPath = path.join(dataDir, SQLITE_MIGRATION_MARKER);
  if (await exists(markerPath)) {
    return NOTHING_TO_MIGRATE;
  }

  const chatsFile = path.join(dataDir, 'chats.json');
  const messagesDir = path.join(dataDir, 'messages');

  // Discover legacy data: chats.json and/or any messages/*.jsonl stream.
  const hasChatsFile = await exists(chatsFile);
  let messageFiles: string[] = [];
  try {
    messageFiles = (await fs.readdir(messagesDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // No messages dir — fine.
  }
  if (!hasChatsFile && messageFiles.length === 0) {
    // Fresh volume: nothing to migrate. Intentionally NO marker, so data that
    // appears later (e.g. a volume restore) still gets picked up.
    return NOTHING_TO_MIGRATE;
  }

  const result: MigrationResult = { ...NOTHING_TO_MIGRATE, migrated: true };

  // --- Chats -----------------------------------------------------------------
  const chats: ChatRow[] = [];
  if (hasChatsFile) {
    try {
      const parsed = JSON.parse(await fs.readFile(chatsFile, 'utf8')) as Record<string, any>;
      for (const [id, raw] of Object.entries(parsed)) {
        const row = normalizeLegacyChat(id, raw);
        if (row) {
          chats.push(row);
        } else {
          result.chatsSkipped++;
          console.warn(`[JsonToSqliteMigrator] Skipping unimportable chat row '${id}'`);
        }
      }
    } catch (error: any) {
      // A corrupt chats.json must not abort the migration — salvage messages,
      // record the failure, and leave the original file for manual recovery.
      result.chatsJsonError = error?.message ?? String(error);
      console.error('[JsonToSqliteMigrator] chats.json is unreadable, salvaging messages:', error);
    }
  }

  // --- Messages ----------------------------------------------------------------
  const messagesByChat = new Map<string, MessageRow[]>();
  for (const file of messageFiles) {
    const chatId = file.slice(0, -'.jsonl'.length);
    const rows: MessageRow[] = [];
    const content = await fs.readFile(path.join(messagesDir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const m = JSON.parse(line);
        if (typeof m?.id !== 'number') {
          throw new Error('missing numeric id');
        }
        rows.push({
          id: m.id,
          type: m.type ?? 'unknown',
          data: m.data,
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
        });
        result.messagesImported++;
      } catch {
        // One malformed line must not lose the rest of the chat history.
        result.messagesSkipped++;
        console.warn(`[JsonToSqliteMigrator] Skipping malformed line in messages/${file}`);
      }
    }
    messagesByChat.set(chatId, rows);
  }
  result.chatsImported = chats.length;

  // --- Import + marker ---------------------------------------------------------
  store.importLegacy(chats, messagesByChat);

  // Marker written only AFTER the import transaction commits. Atomic write
  // (temp + rename) so a torn marker can never block a retry with garbage.
  const marker = JSON.stringify({ migratedAt: new Date().toISOString(), ...result }, null, 2);
  const tmp = `${markerPath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, marker, 'utf8');
  await fs.rename(tmp, markerPath);

  console.log(
    `[JsonToSqliteMigrator] Migrated legacy JSON chat data: ` +
      `${result.chatsImported} chats (${result.chatsSkipped} skipped), ` +
      `${result.messagesImported} messages (${result.messagesSkipped} skipped)` +
      (result.chatsJsonError ? ` — chats.json error: ${result.chatsJsonError}` : '') +
      `. Original JSON files preserved in ${dataDir}.`
  );
  return result;
}
