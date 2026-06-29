/**
 * IMessageStore (rev9 Feature 3 / D29a) — the message-stream half of the chat store,
 * extracted behind a seam so the SqliteDbAdapter can source the conversation stream
 * from the SDK's `~/.claude/projects` JSONL instead of its own SQLite `messages` table.
 *
 * The chat ROW + all metadata stay in SQLite (hybrid); only the message STREAM moves.
 * The default impl is the existing SQLite messages table; the JSONL impl is
 * `ClaudeProjectsMessageStore`. Selected by `CHAT_MESSAGE_SOURCE` at the single
 * SqliteDbAdapter construction site.
 */
import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

export interface IMessageStore {
  /** Append a message to a chat's stream, returning the assigned monotonic id. */
  appendMessage(chatId: string, type: string, data: unknown, timestamp: number): Promise<number>;
  /** Read a chat's full message stream, ordered ascending (timestamp, id). */
  readMessages(chatId: string): Promise<MessageRow[]>;
  /** Count a chat's messages. */
  getMessageCount(chatId: string): Promise<number>;
  /** Delete a chat's message stream (the rows THIS store owns). */
  deleteMessages(chatId: string): Promise<void>;
  /** Optional one-time setup (open the side db, etc.). */
  initialize?(): Promise<void>;
  /** Optional teardown. */
  close?(): void;
}
