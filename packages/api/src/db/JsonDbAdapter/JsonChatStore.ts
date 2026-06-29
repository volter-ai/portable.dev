/**
 * JsonChatStore - Filesystem-backed storage for chats and messages
 *
 * Persists chat metadata and message event streams as JSON files on
 * the per-user workspace volume (survives sandbox restarts).
 *
 * Layout (under `dataDir`, default `<WORKSPACE_DIR>/.chat-data`):
 *   chats.json                  Map of chatId -> chat row (snake_case `chats` row
 *                               shape so reads are a drop-in replacement).
 *   messages/<chatId>.jsonl     Append-only stream of message rows, one JSON object
 *                               ({ id, type, data, timestamp }) per line. Append-only
 *                               keeps message saves O(1) instead of rewriting the file.
 *
 * Isolation: each user runs in a single backend instance, so a flat (non per-user)
 * layout is sufficient. Chat rows carry `user_id` and reads filter on it; message
 * files are keyed by the globally-unique chatId.
 *
 * Concurrency: all mutations run through a single serialized promise chain and use
 * atomic writes (temp file + rename) so concurrent readers never observe a torn file.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/** A chat row in snake_case, matching the `chats` table shape. */
export interface ChatRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  summary: string | null;
  status: string | null;
  hidden: boolean;
  archived: boolean;
  /** "Saved" category — kept for later, hidden from the active list (mutually exclusive with archived). */
  saved?: boolean;
  /** Pinned to the top of lists (orthogonal to the category). */
  pinned?: boolean;
  last_updated: number;
  repo_path: string | null;
  /**
   * GitHub full_name (owner/repo) for the chat's repo, derived from the git remote.
   * Synthesized for discovered terminal chats so the chat list can show the
   * repo NAME without parsing the raw disk `repo_path`. Optional / not a SQLite column —
   * never persisted (only set on synthesized discovered rows).
   */
  repo_full_name?: string | null;
  session_id: string | null;
  /**
   * The ORIGINAL Claude Code session id this chat was FORKED from (fork-on-first-write).
   * Set when Portable claims a discovered terminal transcript: the chat runs the SDK with
   * `{ resume: fork_source_session_id, forkSession: true }` so the SOURCE transcript is left
   * untouched and a NEW session id is minted into `session_id`. Null for every normal chat.
   * `startNewSession` forks iff `session_id == null && fork_source_session_id != null`.
   */
  fork_source_session_id?: string | null;
  system_prompt: string | null;
  playwright_device: string | null;
  model: string;
  permissions: string;
  agent_setup_id: string | null;
  parent_chat_id: string | null;
  workflow_run_id: string | null;
  routine_id: string | null;
  last_read_message_id: number | null;
  linked_issue: { owner: string; repo: string; number: number } | null;
  created_at: number;
}

/** A message row, one per line in the chat's JSONL file. */
export interface MessageRow {
  id: number;
  type: string;
  data: any;
  timestamp: number;
}

export class JsonChatStore {
  private readonly chatsFile: string;
  private readonly messagesDir: string;
  /** Serializes all write operations to avoid read-modify-write races. */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Per-chat next message id, lazily seeded from disk on first append. */
  private readonly messageIdCounters = new Map<string, number>();

  constructor(private readonly dataDir: string) {
    this.chatsFile = path.join(dataDir, 'chats.json');
    this.messagesDir = path.join(dataDir, 'messages');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.messagesDir, { recursive: true });
  }

  // ==========================================================================
  // Write serialization + atomic file IO
  // ==========================================================================

  /** Queue a mutation so writes never interleave. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.writeChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async atomicWrite(file: string, contents: string): Promise<void> {
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, contents, 'utf8');
    await fs.rename(tmp, file);
  }

  // ==========================================================================
  // Chats
  // ==========================================================================

  async readAllChats(): Promise<Map<string, ChatRow>> {
    try {
      const raw = await fs.readFile(this.chatsFile, 'utf8');
      const obj = JSON.parse(raw) as Record<string, ChatRow>;
      return new Map(Object.entries(obj));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return new Map();
      }
      throw error;
    }
  }

  private async writeAllChats(chats: Map<string, ChatRow>): Promise<void> {
    const obj = Object.fromEntries(chats.entries());
    await this.atomicWrite(this.chatsFile, JSON.stringify(obj, null, 2));
  }

  async getChat(chatId: string): Promise<ChatRow | undefined> {
    const chats = await this.readAllChats();
    return chats.get(chatId);
  }

  /** Upsert a chat row produced by the caller (already merged with existing). */
  async upsertChat(
    chatId: string,
    build: (existing: ChatRow | undefined) => ChatRow
  ): Promise<void> {
    await this.serialize(async () => {
      const chats = await this.readAllChats();
      chats.set(chatId, build(chats.get(chatId)));
      await this.writeAllChats(chats);
    });
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
    return this.serialize(async () => {
      const chats = await this.readAllChats();
      const row = chats.get(chatId);
      if (!row || row.user_id !== userId) {
        return false;
      }
      const patch = mutate(row);
      chats.set(chatId, { ...row, ...patch, last_updated: Date.now() });
      await this.writeAllChats(chats);
      return true;
    });
  }

  async deleteChat(chatId: string, userId: string): Promise<boolean> {
    return this.serialize(async () => {
      const chats = await this.readAllChats();
      const row = chats.get(chatId);
      if (!row || row.user_id !== userId) {
        return false;
      }
      chats.delete(chatId);
      await this.writeAllChats(chats);
      await fs.rm(this.messagesPath(chatId), { force: true });
      this.messageIdCounters.delete(chatId);
      return true;
    });
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  private messagesPath(chatId: string): string {
    // chatId is application-generated; guard against path traversal defensively.
    const safe = chatId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.messagesDir, `${safe}.jsonl`);
  }

  async readMessages(chatId: string): Promise<MessageRow[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.messagesPath(chatId), 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const messages = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MessageRow);
    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  async getMessageCount(chatId: string): Promise<number> {
    const messages = await this.readMessages(chatId);
    return messages.length;
  }

  /** Seed the in-memory id counter from disk if not already known. */
  private async ensureCounter(chatId: string): Promise<number> {
    let next = this.messageIdCounters.get(chatId);
    if (next === undefined) {
      const existing = await this.readMessages(chatId);
      const maxId = existing.reduce((max, m) => (m.id > max ? m.id : max), 0);
      next = maxId + 1;
      this.messageIdCounters.set(chatId, next);
    }
    return next;
  }

  /**
   * Append a message to the chat's stream, assigning a sequential numeric id,
   * and bump the chat's last_updated timestamp. Returns the assigned id.
   */
  async appendMessage(chatId: string, type: string, data: any, timestamp: number): Promise<number> {
    return this.serialize(async () => {
      const id = await this.ensureCounter(chatId);
      const row: MessageRow = { id, type, data, timestamp };
      await fs.appendFile(this.messagesPath(chatId), `${JSON.stringify(row)}\n`, 'utf8');
      this.messageIdCounters.set(chatId, id + 1);

      // Bump last_updated on the owning chat (best-effort).
      const chats = await this.readAllChats();
      const chat = chats.get(chatId);
      if (chat) {
        chat.last_updated = timestamp;
        chats.set(chatId, chat);
        await this.writeAllChats(chats);
      }
      return id;
    });
  }
}
