/**
 * SqliteSecretsVaultStore - SQLite-backed storage for the secrets-vault domain.
 *
 * The "secrets vault" is the password-manager-style "save and reuse" store for
 * environment variables the agent uses. It lives in a SQLite database
 * (`user_secrets_vault`) under DATA_DIR.
 *
 * Values arrive ALREADY ENCRYPTED (the caller, `SecretsService`, encrypts the
 * plaintext before it reaches the adapter), so this store only persists the
 * opaque `value_encrypted` blob — it never sees plaintext and performs no crypto.
 *
 * Single-user scoping: a PC install serves exactly ONE user. Every method
 * filters by `user_id`, enforcing row isolation at the application layer. One
 * row per (user_id, key): upsert on conflict of (user_id, key).
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   secrets-vault.sqlite   Single database file holding `user_secrets_vault`.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

import type { SavedSecret } from '../SecretsVaultAdapter.js';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_SECRETS_VAULT_DB_FILE = 'secrets-vault.sqlite';

/** Raw `user_secrets_vault` table row. */
interface DbVaultRow {
  id: string;
  user_id: string;
  key: string;
  value_encrypted: string;
  source: string;
  source_connection_id: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteSecretsVaultStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the secrets-vault SQLite database. Defaults to
   *                `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore and the other SQLite stores use.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_SECRETS_VAULT_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteThemeStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteSecretsVaultStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
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
      CREATE TABLE IF NOT EXISTS user_secrets_vault (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_encrypted TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_connection_id TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_secrets_vault_user ON user_secrets_vault(user_id)'
    );
  }

  close(): void {
    this.db?.close();
  }

  /** Get all saved secrets for a user (most-recently-updated first). */
  async getSavedSecrets(userId: string): Promise<SavedSecret[]> {
    const rows = this.db
      .prepare<DbVaultRow>(
        'SELECT * FROM user_secrets_vault WHERE user_id = ? ORDER BY updated_at DESC'
      )
      .all(userId);
    return rows.map((r) => this.mapRow(r));
  }

  /** Get a specific saved secret by key, or null when not found. */
  async getSavedSecret(userId: string, key: string): Promise<SavedSecret | null> {
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    const row = this.db
      .prepare<DbVaultRow>('SELECT * FROM user_secrets_vault WHERE user_id = ? AND key = ?')
      .get(userId, key);
    return row != null ? this.mapRow(row) : null;
  }

  /** Save or update a secret — one row per (user_id, key). */
  async saveSecret(
    userId: string,
    key: string,
    valueEncrypted: string,
    source: 'manual' | 'env_editor' | 'connection' = 'manual',
    sourceConnectionId?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    // Generate the id only on first insert; ON CONFLICT keeps the existing id +
    // created_at (excluded.id is ignored by the update clause), mirroring the
    // Postgres uuid default + created_at immutability.
    this.db
      .prepare(
        `INSERT INTO user_secrets_vault
           (id, user_id, key, value_encrypted, source, source_connection_id,
            last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           value_encrypted = excluded.value_encrypted,
           source = excluded.source,
           source_connection_id = excluded.source_connection_id,
           last_used_at = excluded.last_used_at,
           updated_at = excluded.updated_at`
      )
      .run(
        crypto.randomUUID(),
        userId,
        key,
        valueEncrypted,
        source,
        sourceConnectionId ?? null,
        now,
        now,
        now
      );
  }

  /** Delete a secret from the vault. */
  async deleteSecret(userId: string, key: string): Promise<void> {
    this.db
      .prepare('DELETE FROM user_secrets_vault WHERE user_id = ? AND key = ?')
      .run(userId, key);
  }

  /**
   * Search secrets by partial key match (for autocomplete). Case-insensitive
   * substring, most-recently-used first, top 10.
   */
  async searchSecrets(userId: string, query: string): Promise<SavedSecret[]> {
    const rows = this.db
      .prepare<DbVaultRow>(
        `SELECT * FROM user_secrets_vault
         WHERE user_id = ? AND key LIKE ? ESCAPE '\\'
         ORDER BY last_used_at DESC, updated_at DESC
         LIMIT 10`
      )
      .all(userId, `%${this.escapeLike(query)}%`);
    return rows.map((r) => this.mapRow(r));
  }

  /** Update the last-used timestamp for a secret (non-critical, never throws). */
  async updateLastUsed(userId: string, key: string): Promise<void> {
    this.db
      .prepare('UPDATE user_secrets_vault SET last_used_at = ? WHERE user_id = ? AND key = ?')
      .run(new Date().toISOString(), userId, key);
  }

  /** Escape LIKE wildcards in user-supplied search input. */
  private escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  private mapRow(row: DbVaultRow): SavedSecret {
    return {
      id: row.id,
      userId: row.user_id,
      key: row.key,
      valueEncrypted: row.value_encrypted,
      source: (row.source as SavedSecret['source']) || 'manual',
      sourceConnectionId: row.source_connection_id || undefined,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
