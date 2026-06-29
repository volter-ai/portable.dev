/**
 * SqliteServiceAccountStore - SQLite-backed storage for the service-accounts +
 * service-account-audit-log domains.
 *
 * The `service_accounts` and `service_account_audit_log` tables live in a SQLite
 * database under DATA_DIR. The two tables are kept in ONE store because the audit
 * log only ever describes a service account — they are a single logical domain.
 *
 * Single-user scoping: a PC install serves exactly ONE Clerk identity.
 * Service-account methods filter by `user_id` at the query layer, enforcing
 * per-user isolation at the application layer. Audit logs are looked up by
 * `service_account_id` — the parent account is already user-scoped.
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   service-accounts.sqlite   Single database file holding both the
 *                             `service_accounts` table and the
 *                             `service_account_audit_log` table. `token_encrypted`,
 *                             `allowed_user_ids`, and audit `details` round-trip
 *                             as JSON text.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed
 * (mirrors SqliteConnectionStore / SqliteThemeStore / SqlitePushStore).
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_SERVICE_ACCOUNTS_DB_FILE = 'service-accounts.sqlite';

/** Raw `service_accounts` table row. */
interface DbServiceAccountRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  token_prefix: string;
  token_encrypted: string;
  allowed_user_ids: string;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  rate_limit_window_start: string | null;
  rate_limit_requests_count: number | null;
}

/** Raw `service_account_audit_log` table row. */
interface DbAuditRow {
  id: string;
  service_account_id: string;
  user_id: string;
  action: string;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
  success: number;
  error_message: string | null;
  created_at: string;
}

type AuditAction = 'create' | 'update' | 'delete' | 'rotate' | 'regenerate' | 'use';

export class SqliteServiceAccountStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the service-accounts SQLite database. Defaults
   *                to `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore and the other Sqlite*Store domains use.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_SERVICE_ACCOUNTS_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteConnectionStore / SqliteThemeStore / SqlitePushStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteServiceAccountStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
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
      CREATE TABLE IF NOT EXISTS service_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        token_prefix TEXT NOT NULL,
        token_encrypted TEXT NOT NULL,
        allowed_user_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        rate_limit_window_start TEXT,
        rate_limit_requests_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_service_accounts_user_id ON service_accounts(user_id)'
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_service_accounts_token_prefix ON service_accounts(token_prefix)'
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_account_audit_log (
        id TEXT PRIMARY KEY,
        service_account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sa_audit_service_account_id ON service_account_audit_log(service_account_id)'
    );
  }

  close(): void {
    this.db?.close();
  }

  // ==========================================================================
  // SERVICE ACCOUNTS
  // ==========================================================================

  async createServiceAccount(
    serviceAccount: {
      id: string;
      userId: string;
      name: string;
      description?: string;
      tokenPrefix: string;
      tokenEncrypted: any;
      allowedUserIds: string[];
      expiresAt?: Date;
    },
    _authToken?: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO service_accounts
           (id, user_id, name, description, token_prefix, token_encrypted,
            allowed_user_ids, enabled, expires_at, created_at, updated_at,
            rate_limit_requests_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`
      )
      .run(
        serviceAccount.id,
        serviceAccount.userId,
        serviceAccount.name,
        serviceAccount.description ?? null,
        serviceAccount.tokenPrefix,
        JSON.stringify(serviceAccount.tokenEncrypted),
        JSON.stringify(serviceAccount.allowedUserIds ?? []),
        serviceAccount.expiresAt ? serviceAccount.expiresAt.toISOString() : null,
        now,
        now
      );
    return true;
  }

  async getServiceAccounts(
    userId: string,
    _authToken?: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      name: string;
      description?: string;
      tokenPrefix: string;
      allowedUserIds: string[];
      enabled: boolean;
      expiresAt?: Date;
      createdAt: Date;
      updatedAt: Date;
      lastUsedAt?: Date;
    }>
  > {
    const rows = this.db
      .prepare<DbServiceAccountRow>(
        `SELECT * FROM service_accounts WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(userId);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description ?? undefined,
      tokenPrefix: row.token_prefix,
      allowedUserIds: this.parseJson<string[]>(row.allowed_user_ids, []),
      enabled: row.enabled !== 0,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    }));
  }

  async getServiceAccount(
    id: string,
    userId: string,
    _authToken?: string
  ): Promise<{
    id: string;
    userId: string;
    name: string;
    description?: string;
    tokenPrefix: string;
    tokenEncrypted: any;
    allowedUserIds: string[];
    enabled: boolean;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    lastUsedAt?: Date;
  } | null> {
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    const row = this.db
      .prepare<DbServiceAccountRow>(`SELECT * FROM service_accounts WHERE id = ? AND user_id = ?`)
      .get(id, userId);
    if (row == null) {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description ?? undefined,
      tokenPrefix: row.token_prefix,
      tokenEncrypted: this.parseJson<any>(row.token_encrypted, null),
      allowedUserIds: this.parseJson<string[]>(row.allowed_user_ids, []),
      enabled: row.enabled !== 0,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    };
  }

  async getServiceAccountByPrefix(
    tokenPrefix: string,
    _authToken?: string
  ): Promise<{
    id: string;
    userId: string;
    name: string;
    tokenEncrypted: any;
    allowedUserIds: string[];
    enabled: boolean;
    expiresAt?: Date;
    rateLimitWindowStart?: Date;
    rateLimitRequestsCount: number;
  } | null> {
    const row = this.db
      .prepare<DbServiceAccountRow>(`SELECT * FROM service_accounts WHERE token_prefix = ?`)
      .get(tokenPrefix);
    if (row == null) {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      tokenEncrypted: this.parseJson<any>(row.token_encrypted, null),
      allowedUserIds: this.parseJson<string[]>(row.allowed_user_ids, []),
      enabled: row.enabled !== 0,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      rateLimitWindowStart: row.rate_limit_window_start
        ? new Date(row.rate_limit_window_start)
        : undefined,
      rateLimitRequestsCount: row.rate_limit_requests_count ?? 0,
    };
  }

  async updateServiceAccount(
    id: string,
    userId: string,
    updates: {
      name?: string;
      description?: string;
      allowedUserIds?: string[];
      enabled?: boolean;
      tokenEncrypted?: any;
    },
    _authToken?: string
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: any[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }
    if (updates.allowedUserIds !== undefined) {
      sets.push('allowed_user_ids = ?');
      params.push(JSON.stringify(updates.allowedUserIds));
    }
    if (updates.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }
    if (updates.tokenEncrypted !== undefined) {
      sets.push('token_encrypted = ?');
      params.push(JSON.stringify(updates.tokenEncrypted));
      // Update token prefix if token is being changed.
      if (updates.tokenEncrypted.encrypted) {
        sets.push('token_prefix = ?');
        params.push(updates.tokenEncrypted.encrypted.substring(0, 10));
      }
    }

    // Always bump updated_at at write time.
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());

    this.db
      .prepare(`UPDATE service_accounts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...params, id, userId);
    return true;
  }

  async deleteServiceAccount(id: string, userId: string, _authToken?: string): Promise<boolean> {
    this.db.prepare('DELETE FROM service_accounts WHERE id = ? AND user_id = ?').run(id, userId);
    return true;
  }

  async updateServiceAccountUsage(id: string, _authToken?: string): Promise<boolean> {
    this.db
      .prepare('UPDATE service_accounts SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return true;
  }

  async updateServiceAccountRateLimit(
    id: string,
    requestsCount: number,
    windowStart: Date,
    _authToken?: string
  ): Promise<boolean> {
    this.db
      .prepare(
        'UPDATE service_accounts SET rate_limit_requests_count = ?, rate_limit_window_start = ? WHERE id = ?'
      )
      .run(requestsCount, windowStart.toISOString(), id);
    return true;
  }

  // ==========================================================================
  // AUDIT LOG
  // ==========================================================================

  async createServiceAccountAuditLog(
    log: {
      serviceAccountId: string;
      userId: string;
      action: AuditAction;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      errorMessage?: string;
    },
    _authToken?: string
  ): Promise<boolean> {
    this.db
      .prepare(
        `INSERT INTO service_account_audit_log
           (id, service_account_id, user_id, action, details, ip_address,
            user_agent, success, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        log.serviceAccountId,
        log.userId,
        log.action,
        log.details !== undefined ? JSON.stringify(log.details) : null,
        log.ipAddress ?? null,
        log.userAgent ?? null,
        log.success ? 1 : 0,
        log.errorMessage ?? null,
        new Date().toISOString()
      );
    return true;
  }

  async getServiceAccountAuditLogs(
    serviceAccountId: string,
    options?: {
      limit?: number;
      offset?: number;
      action?: string;
      success?: boolean;
    },
    _authToken?: string
  ): Promise<
    Array<{
      id: string;
      serviceAccountId: string;
      userId: string;
      action: string;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      errorMessage?: string;
      createdAt: Date;
    }>
  > {
    let sql = `SELECT * FROM service_account_audit_log WHERE service_account_id = ?`;
    const params: any[] = [serviceAccountId];

    if (options?.action) {
      sql += ' AND action = ?';
      params.push(options.action);
    }
    if (options?.success !== undefined) {
      sql += ' AND success = ?';
      params.push(options.success ? 1 : 0);
    }
    sql += ' ORDER BY created_at DESC';
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const rows = this.db.prepare<DbAuditRow>(sql).all(...params);
    return rows.map((row) => ({
      id: row.id,
      serviceAccountId: row.service_account_id,
      userId: row.user_id,
      action: row.action,
      details: row.details != null ? this.parseJson<any>(row.details, null) : undefined,
      ipAddress: row.ip_address ?? undefined,
      userAgent: row.user_agent ?? undefined,
      success: row.success !== 0,
      errorMessage: row.error_message ?? undefined,
      createdAt: new Date(row.created_at),
    }));
  }

  /** Parse JSON text, returning a fallback for null/corrupt values. */
  private parseJson<T>(text: string | null, fallback: T): T {
    if (text == null) {
      return fallback;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }
}
