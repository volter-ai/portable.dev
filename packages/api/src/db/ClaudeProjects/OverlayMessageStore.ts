/**
 * OverlayMessageStore (rev9 Feature 3 / D29a, Q-F3a hybrid) — the side SQLite stream
 * for portable-only UI events that have NO home in the SDK's JSONL transcript:
 * synthesized media (image/video served from `/data/media`), action chips, and any
 * other overlay block portable generates post-turn. These are merged with the
 * JSONL-derived conversation on read so the mobile UX is preserved 1:1, while the SDK
 * stays the sole writer of the actual conversation in its own clean transcript.
 *
 * One row per overlay event: `{chat_id, id, type, data, timestamp}` — the same wire
 * shape as the main messages table, so the merge produces uniform BufferedMessage rows.
 */
import { promises as fs } from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import type { MessageRow } from '../JsonDbAdapter/JsonChatStore.js';

export const OVERLAY_DB_FILE = 'overlay-messages.sqlite';

interface DbOverlayRow {
  id: number;
  type: string;
  data: string | null;
  timestamp: number;
}

export class OverlayMessageStore {
  private readonly dbPath: string;
  private db!: Database;

  constructor(private readonly dataDir: string) {
    this.dbPath = path.join(dataDir, OVERLAY_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
    } catch {
      this.db.exec('PRAGMA journal_mode = TRUNCATE');
    }
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS overlay_messages (
        chat_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_overlay_chat_ts ON overlay_messages(chat_id, timestamp);
    `);
  }

  close(): void {
    this.db?.close();
  }

  /** Append an overlay row with a per-chat sequential id; returns the assigned id. */
  async append(chatId: string, type: string, data: unknown, timestamp: number): Promise<number> {
    let id = 0;
    this.db.transaction(() => {
      const max = this.db
        .prepare<{
          m: number | null;
        }>('SELECT MAX(id) AS m FROM overlay_messages WHERE chat_id = ?')
        .get(chatId);
      id = (max?.m ?? 0) + 1;
      this.db
        .prepare(
          'INSERT INTO overlay_messages (chat_id, id, type, data, timestamp) VALUES (?, ?, ?, ?, ?)'
        )
        .run(chatId, id, type, data === undefined ? null : JSON.stringify(data), timestamp);
    })();
    return id;
  }

  /** Read a chat's overlay rows (ascending timestamp, id). A corrupt row is skipped. */
  async read(chatId: string): Promise<MessageRow[]> {
    return this.db
      .prepare<DbOverlayRow>(
        'SELECT id, type, data, timestamp FROM overlay_messages WHERE chat_id = ? ORDER BY timestamp ASC, id ASC'
      )
      .all(chatId)
      .map((raw) => {
        let data: unknown = null;
        if (raw.data !== null) {
          try {
            data = JSON.parse(raw.data);
          } catch {
            // skip corrupt payload, keep the row shape
          }
        }
        return { id: raw.id, type: raw.type, data, timestamp: raw.timestamp };
      });
  }

  async deleteChat(chatId: string): Promise<void> {
    this.db.prepare('DELETE FROM overlay_messages WHERE chat_id = ?').run(chatId);
  }
}
