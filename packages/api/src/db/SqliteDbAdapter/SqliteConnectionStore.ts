/**
 * SqliteConnectionStore - SQLite-backed storage for service-connection METADATA.
 *
 * The `service_connections` domain lives in a SQLite database under DATA_DIR.
 * This store holds connection METADATA only — id, connectionId, displayName,
 * service, serviceType, timestamps, isActive. The credentials column is
 * preserved for shape parity but in local-first mode the real secrets are
 * encrypted at rest in the LocalSecretStore (LocalSecretsAdapter writes an
 * empty `{}` here), so the SQLite row never contains a plaintext secret.
 *
 * Single-user scoping: a PC install serves exactly ONE user. Every method
 * filters by `user_id` (the gateway-bound Clerk identity) at the query layer,
 * enforcing row isolation at the application layer.
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   connections.sqlite   Single database file holding the `service_connections`
 *                        table. Rows use the shared StoredServiceConnection
 *                        shape (snake_case) so reads map back to ServiceConnection.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed
 * (mirrors SqliteChatStore).
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

import type {
  ServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_CONNECTIONS_DB_FILE = 'connections.sqlite';

/** Raw `service_connections` table row (booleans as 0/1, credentials as JSON text). */
interface DbConnectionRow {
  id: string;
  user_id: string;
  connection_id: string;
  display_name: string;
  service: string;
  service_type: string;
  credentials: string | null;
  connected_at: string;
  last_used_at: string | null;
  is_active: number;
}

export class SqliteConnectionStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the connections SQLite database. Defaults to
   *                `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore uses for encrypted credentials, so a
   *                connection's metadata and its secret live side by side.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_CONNECTIONS_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteChatStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqliteConnectionStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
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
      CREATE TABLE IF NOT EXISTS service_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        service TEXT NOT NULL,
        service_type TEXT NOT NULL,
        credentials TEXT,
        connected_at TEXT NOT NULL,
        last_used_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE (user_id, connection_id)
      );
      CREATE INDEX IF NOT EXISTS idx_connections_user ON service_connections(user_id, connected_at);
      CREATE INDEX IF NOT EXISTS idx_connections_service ON service_connections(user_id, service);
    `);
  }

  close(): void {
    this.db?.close();
  }

  // ==========================================================================
  // Row mapping
  // ==========================================================================

  private toServiceConnection(raw: DbConnectionRow): ServiceConnection {
    let credentials: any = {};
    if (raw.credentials) {
      try {
        credentials = JSON.parse(raw.credentials);
      } catch {
        console.warn(
          `[SqliteConnectionStore] Skipping corrupt credentials on connection ${raw.connection_id}`
        );
      }
    }
    return {
      id: raw.id,
      userId: raw.user_id,
      connectionId: raw.connection_id,
      displayName: raw.display_name,
      service: raw.service,
      serviceType: raw.service_type as 'sdk' | 'cli',
      credentials,
      connectedAt: new Date(raw.connected_at),
      lastUsedAt: raw.last_used_at ? new Date(raw.last_used_at) : undefined,
      isActive: raw.is_active !== 0,
    };
  }

  private getRow(userId: string, connectionId: string): DbConnectionRow | undefined {
    return this.db
      .prepare<DbConnectionRow>(
        'SELECT * FROM service_connections WHERE user_id = ? AND connection_id = ?'
      )
      .get(userId, connectionId);
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]> {
    return this.db
      .prepare<DbConnectionRow>(
        'SELECT * FROM service_connections WHERE user_id = ? ORDER BY connected_at DESC'
      )
      .all(options.userId)
      .map((raw) => this.toServiceConnection(raw));
  }

  async getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null> {
    const raw = this.getRow(options.userId, options.connectionId);
    return raw ? this.toServiceConnection(raw) : null;
  }

  async getConnectionCredentials(options: GetConnectionOptions): Promise<any | null> {
    const raw = this.getRow(options.userId, options.connectionId);
    if (!raw) {
      return null;
    }
    // Touch last_used_at on a credential read.
    this.db
      .prepare(
        'UPDATE service_connections SET last_used_at = ? WHERE user_id = ? AND connection_id = ?'
      )
      .run(new Date().toISOString(), options.userId, options.connectionId);
    return this.toServiceConnection(raw).credentials;
  }

  async getConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.db
      .prepare<DbConnectionRow>(
        'SELECT * FROM service_connections WHERE user_id = ? AND service = ? ORDER BY connected_at DESC'
      )
      .all(options.userId, options.service)
      .map((raw) => this.toServiceConnection(raw));
  }

  async getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.db
      .prepare<DbConnectionRow>(
        'SELECT * FROM service_connections WHERE user_id = ? AND service = ? AND is_active = 1 ORDER BY connected_at DESC'
      )
      .all(options.userId, options.service)
      .map((raw) => this.toServiceConnection(raw));
  }

  async hasConnection(options: GetConnectionOptions): Promise<boolean> {
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    return this.getRow(options.userId, options.connectionId) != null;
  }

  // ==========================================================================
  // Writes
  // ==========================================================================

  async storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
    const { userId, connectionId, displayName, service, serviceType, credentials } = options;
    const now = new Date().toISOString();
    const existing = this.getRow(userId, connectionId);
    // Preserve the row id (and original connected_at) on update so callers that
    // cached the id stay valid; mint a fresh id on first insert.
    const id = existing?.id ?? `${userId}:${connectionId}`;
    const connectedAt = existing?.connected_at ?? now;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO service_connections
           (id, user_id, connection_id, display_name, service, service_type, credentials, connected_at, last_used_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        userId,
        connectionId,
        displayName,
        service,
        serviceType,
        credentials === undefined || credentials === null ? null : JSON.stringify(credentials),
        connectedAt,
        now,
        1
      );

    console.log(
      `[SqliteConnectionStore] Stored connection: ${connectionId} (${displayName}) for user ${userId}`
    );

    const stored = this.getRow(userId, connectionId);
    return this.toServiceConnection(stored!);
  }

  async deleteConnection(options: GetConnectionOptions): Promise<void> {
    this.db
      .prepare('DELETE FROM service_connections WHERE user_id = ? AND connection_id = ?')
      .run(options.userId, options.connectionId);
    console.log(
      `[SqliteConnectionStore] Deleted connection: ${options.connectionId} for user ${options.userId}`
    );
  }

  async renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection> {
    const { userId, oldConnectionId, newConnectionId, newDisplayName } = options;
    const existing = this.getRow(userId, oldConnectionId);
    if (!existing) {
      throw new Error(`Connection ${oldConnectionId} not found`);
    }
    this.db
      .prepare(
        'UPDATE service_connections SET connection_id = ?, display_name = ? WHERE user_id = ? AND connection_id = ?'
      )
      .run(newConnectionId, newDisplayName, userId, oldConnectionId);

    console.log(
      `[SqliteConnectionStore] Renamed connection from ${oldConnectionId} to ${newConnectionId} (${newDisplayName}) for user ${userId}`
    );

    const renamed = this.getRow(userId, newConnectionId);
    return this.toServiceConnection(renamed!);
  }

  async toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection> {
    const { userId, connectionId, isActive } = options;
    const existing = this.getRow(userId, connectionId);
    if (!existing) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    this.db.transaction(() => {
      // For exclusive services, enabling one connection disables the others.
      if (isActive) {
        this.db
          .prepare(
            'UPDATE service_connections SET is_active = 0 WHERE user_id = ? AND service = ? AND connection_id != ?'
          )
          .run(userId, existing.service, connectionId);
      }
      this.db
        .prepare(
          'UPDATE service_connections SET is_active = ? WHERE user_id = ? AND connection_id = ?'
        )
        .run(isActive ? 1 : 0, userId, connectionId);
    })();

    console.log(
      `[SqliteConnectionStore] Toggled connection ${connectionId} active status to ${isActive} for user ${userId}`
    );

    const updated = this.getRow(userId, connectionId);
    return this.toServiceConnection(updated!);
  }
}
