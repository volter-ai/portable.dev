/**
 * SqliteThemeStore - SQLite-backed storage for the user-theme domain.
 *
 * The `user_themes` domain lives in a SQLite database under DATA_DIR. A theme is
 * a single JSON `theme_config` object keyed by the user's identity (userEmail /
 * Clerk user id) — one row per user (UNIQUE user_id): upsert on conflict of
 * user_id.
 *
 * Single-user scoping: a PC install serves exactly ONE user. Every method
 * filters by `user_id` at the query layer, enforcing row isolation at the
 * application layer.
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   themes.sqlite   Single database file holding the `user_themes` table. The
 *                   `theme_config` JSON round-trips back to a
 *                   `Record<string, any>`.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed
 * (mirrors SqliteConnectionStore).
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_THEMES_DB_FILE = 'themes.sqlite';

/** Raw `user_themes` table row (theme_config as JSON text). */
interface DbThemeRow {
  user_id: string;
  theme_config: string;
}

export class SqliteThemeStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the themes SQLite database. Defaults to
   *                `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore and SqliteConnectionStore use.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_THEMES_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteConnectionStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteThemeStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
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
      CREATE TABLE IF NOT EXISTS user_themes (
        user_id TEXT PRIMARY KEY,
        theme_config TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db?.close();
  }

  /**
   * Get theme configuration for a user. Returns null when no theme is saved
   * or when the stored JSON is corrupt.
   */
  async getTheme(userEmail: string): Promise<Record<string, any> | null> {
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    const raw = this.db
      .prepare<DbThemeRow>('SELECT user_id, theme_config FROM user_themes WHERE user_id = ?')
      .get(userEmail);
    if (raw == null) {
      return null;
    }
    try {
      return JSON.parse(raw.theme_config) as Record<string, any>;
    } catch {
      console.warn(`[SqliteThemeStore] Skipping corrupt theme_config for user ${userEmail}`);
      return null;
    }
  }

  /**
   * Save (upsert) theme configuration for a user — one row per user_id.
   */
  async saveTheme(userEmail: string, themeConfig: Record<string, any>): Promise<boolean> {
    this.db
      .prepare(
        `INSERT INTO user_themes (user_id, theme_config) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET theme_config = excluded.theme_config`
      )
      .run(userEmail, JSON.stringify(themeConfig));
    console.log(`[SqliteThemeStore] Saved theme for user ${userEmail}`);
    return true;
  }

  /**
   * Delete theme configuration for a user.
   */
  async deleteTheme(userEmail: string): Promise<boolean> {
    this.db.prepare('DELETE FROM user_themes WHERE user_id = ?').run(userEmail);
    console.log(`[SqliteThemeStore] Deleted theme for user ${userEmail}`);
    return true;
  }
}
