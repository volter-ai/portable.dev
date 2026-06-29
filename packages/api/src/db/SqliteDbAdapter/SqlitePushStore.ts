/**
 * SqlitePushStore - SQLite-backed storage for the push-subscriptions domain.
 *
 * The `push_subscriptions` domain lives in a SQLite database under DATA_DIR.
 * Push is inherently MULTI-DEVICE: a single user can register one subscription
 * per device, so rows are keyed by the composite `(user_id, endpoint)` —
 * multiple rows per user are preserved: upsert on conflict of (user_id,
 * endpoint).
 *
 * Single-user scoping: a PC install serves exactly ONE Clerk identity. Every
 * method filters by `user_id` at the query layer, enforcing row isolation at
 * the application layer.
 *
 * Layout (under `dataDir`, default `resolveDataDir()` = DATA_DIR):
 *   push-subscriptions.sqlite   Single database file holding the
 *                               `push_subscriptions` table. `device_info` and
 *                               `notification_settings` round-trip as JSON text.
 *
 * Concurrency: bun:sqlite is synchronous, so every mutation completes atomically
 * relative to other JS execution — no write-serialization chain is needed
 * (mirrors SqliteConnectionStore / SqliteThemeStore).
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

/** Filename of the SQLite database inside the data directory. */
export const SQLITE_PUSH_DB_FILE = 'push-subscriptions.sqlite';

/** Raw `push_subscriptions` table row. */
interface DbPushRow {
  user_id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  platform: string;
  fcm_token: string | null;
  device_info: string;
  notification_settings: string;
}

/** Shape returned by savePushSubscription. */
type PushSubscriptionInput = {
  endpoint: string;
  keys?: {
    p256dh: string;
    auth: string;
  };
  platform?: 'web' | 'ios' | 'android';
  fcmToken?: string;
  deviceInfo?: any;
};

/** Resolved notification settings (with defaults applied). */
type NotificationSettings = {
  enabled: boolean;
  taskComplete: boolean;
  notifyWhen: 'always' | 'offline';
};

export class SqlitePushStore {
  private readonly dbPath: string;
  private readonly dataDir: string;
  private db!: Database;

  /**
   * @param dataDir Directory for the push-subscriptions SQLite database.
   *                Defaults to `resolveDataDir()` (DATA_DIR) — the same root the
   *                LocalSecretStore, SqliteConnectionStore, and SqliteThemeStore
   *                use.
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    this.dbPath = path.join(this.dataDir, SQLITE_PUSH_DB_FILE);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    // WAL avoids torn writes, but may be unsupported on FUSE-backed volumes;
    // fall back to TRUNCATE (kernel-local locks) rather than failing startup.
    // Same probe pattern as SqliteConnectionStore / SqliteThemeStore.
    try {
      const mode = this.db.prepare<{ journal_mode: string }>('PRAGMA journal_mode = WAL').get();
      if ((mode?.journal_mode ?? '').toLowerCase() !== 'wal') {
        throw new Error(`journal_mode pragma returned '${mode?.journal_mode}'`);
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('COMMIT');
    } catch (error) {
      console.warn(
        '[SqlitePushStore] WAL unavailable on this filesystem, falling back to TRUNCATE journal:',
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
    // Composite PK (user_id, endpoint) = one row per device per user — the
    // multi-device contract (upsert on conflict of user_id, endpoint).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT,
        auth TEXT,
        platform TEXT NOT NULL DEFAULT 'web',
        fcm_token TEXT,
        device_info TEXT NOT NULL DEFAULT '{}',
        notification_settings TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, endpoint)
      );
    `);
  }

  close(): void {
    this.db?.close();
  }

  /**
   * Save or update a push subscription. Keyed on (user_id, endpoint) so each of
   * a user's devices keeps its own row (multi-device preserved). On conflict the
   * device's keys/platform/fcm/device_info are refreshed; notification_settings
   * are left untouched so updateNotificationSettings is not clobbered.
   */
  async savePushSubscription(
    userId: string,
    subscription: PushSubscriptionInput,
    _authToken?: string
  ): Promise<boolean> {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (user_id, endpoint, p256dh, auth, platform, fcm_token, device_info, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           platform = excluded.platform,
           fcm_token = excluded.fcm_token,
           device_info = excluded.device_info,
           updated_at = excluded.updated_at`
      )
      .run(
        userId,
        subscription.endpoint,
        subscription.keys?.p256dh ?? null,
        subscription.keys?.auth ?? null,
        subscription.platform ?? 'web',
        subscription.fcmToken ?? null,
        JSON.stringify(subscription.deviceInfo ?? {}),
        new Date().toISOString()
      );
    console.log(`[SqlitePushStore] Saved push subscription for user ${userId}`);
    return true;
  }

  /**
   * Remove a push subscription by endpoint (single device).
   */
  async removePushSubscription(
    userId: string,
    endpoint: string,
    _authToken?: string
  ): Promise<boolean> {
    this.db
      .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(userId, endpoint);
    console.log(`[SqlitePushStore] Removed push subscription for user ${userId}`);
    return true;
  }

  /**
   * Get all push subscriptions for a user (all devices).
   */
  async getUserPushSubscriptions(
    userId: string,
    _authToken?: string
  ): Promise<
    Array<{
      userId: string;
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
      fcmToken?: string;
      deviceInfo?: any;
    }>
  > {
    const rows = this.db
      .prepare<DbPushRow>(
        `SELECT user_id, endpoint, p256dh, auth, platform, fcm_token, device_info, notification_settings
           FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at ASC, endpoint ASC`
      )
      .all(userId);
    return rows.map((row) => ({
      userId: row.user_id,
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh ?? '',
        auth: row.auth ?? '',
      },
      // Native Expo/FCM subscriptions carry an fcm_token (web-push subs do not).
      fcmToken: row.fcm_token ?? undefined,
      deviceInfo: this.parseJson(row.device_info, {}),
    }));
  }

  /**
   * Get notification settings for a user (from the first subscription found),
   * or null when the user has no subscriptions. Applies defaulting
   * (enabled/taskComplete default true; notifyWhen defaults always).
   */
  async getNotificationSettings(
    userId: string,
    _authToken?: string
  ): Promise<NotificationSettings | null> {
    // bun:sqlite's .get() returns null (not undefined) when there is no row.
    const row = this.db
      .prepare<{ notification_settings: string }>(
        `SELECT notification_settings FROM push_subscriptions
           WHERE user_id = ? ORDER BY updated_at ASC, endpoint ASC LIMIT 1`
      )
      .get(userId);
    if (row == null) {
      return null;
    }
    const settings = this.parseJson(row.notification_settings, {}) as Record<string, unknown>;
    return this.resolveSettings(settings);
  }

  /**
   * Update notification settings for ALL of a user's subscriptions. Merges the
   * incoming partial over the existing settings (read from the first row), then
   * writes the merged object to every device row (user_id match, no endpoint
   * filter).
   */
  async updateNotificationSettings(
    userId: string,
    settings: Partial<NotificationSettings>,
    _authToken?: string
  ): Promise<boolean> {
    const existing = this.db
      .prepare<{ notification_settings: string }>(
        `SELECT notification_settings FROM push_subscriptions
           WHERE user_id = ? ORDER BY updated_at ASC, endpoint ASC LIMIT 1`
      )
      .get(userId);
    const currentSettings = (
      existing == null ? {} : this.parseJson(existing.notification_settings, {})
    ) as Record<string, unknown>;
    const mergedSettings = { ...currentSettings, ...settings };

    this.db
      .prepare(
        `UPDATE push_subscriptions
           SET notification_settings = ?, updated_at = ?
           WHERE user_id = ?`
      )
      .run(JSON.stringify(mergedSettings), new Date().toISOString(), userId);
    return true;
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

  /** Apply default-resolution to a raw settings object. */
  private resolveSettings(settings: Record<string, unknown>): NotificationSettings {
    return {
      enabled: settings.enabled !== false,
      taskComplete: settings.taskComplete !== false,
      notifyWhen: settings.notifyWhen === 'offline' ? 'offline' : 'always',
    };
  }
}
