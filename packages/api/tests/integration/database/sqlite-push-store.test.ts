/**
 * SqlitePushStore / SqliteDbAdapter push-subscriptions Tests
 *
 * THE STORY: The push-subscriptions domain is persisted on local
 * SQLite under DATA_DIR. Push is multi-device, so a user keeps one row per
 * device (keyed by user_id + endpoint); a subscription round-trips
 * (register -> list) on local SQLite. Single-user scoping is enforced by the
 * user_id filter in every query (no RLS).
 *
 * REAL SERVICES:
 * - ✅ SqlitePushStore - real bun:sqlite database (temp dir per test)
 * - ✅ SqliteDbAdapter - real adapter under test
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SqliteDbAdapter,
  SqlitePushStore,
  SQLITE_PUSH_DB_FILE,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'sqlite-push-user@example.com';
const OTHER_USER = 'someone-else@example.com';

const DEVICE_A = {
  endpoint: 'https://push.example.com/device-a',
  keys: { p256dh: 'p256dh-a', auth: 'auth-a' },
  platform: 'web' as const,
  deviceInfo: { browser: 'chrome' },
};
const DEVICE_B = {
  endpoint: 'https://push.example.com/device-b',
  keys: { p256dh: 'p256dh-b', auth: 'auth-b' },
  platform: 'ios' as const,
  fcmToken: 'fcm-b',
  deviceInfo: { model: 'iphone' },
};

describe('SqliteDbAdapter - push-subscriptions domain on local SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-push-'));
    // 1st arg = chat data dir, 2nd arg = connections/themes/push data dir.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the push-subscriptions database file under the data dir', async () => {
    const stat = await fs.stat(path.join(dataDir, SQLITE_PUSH_DB_FILE));
    expect(stat.isFile()).toBe(true);
  });

  // ── The acceptance-criterion test: register -> list a subscription ──
  it('registers a subscription and lists it back (register -> list)', async () => {
    const saved = await adapter.savePushSubscription(USER, DEVICE_A);
    expect(saved).toBe(true);

    const list = await adapter.getUserPushSubscriptions(USER);
    expect(list).toEqual([
      {
        userId: USER,
        endpoint: DEVICE_A.endpoint,
        keys: { p256dh: 'p256dh-a', auth: 'auth-a' },
        deviceInfo: { browser: 'chrome' },
      },
    ]);
  });

  it('preserves multi-device rows (one row per endpoint)', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    await adapter.savePushSubscription(USER, DEVICE_B);

    const list = await adapter.getUserPushSubscriptions(USER);
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.endpoint).sort()).toEqual(
      [DEVICE_A.endpoint, DEVICE_B.endpoint].sort()
    );
  });

  it('upserts the same device in place (no duplicate row on re-register)', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    await adapter.savePushSubscription(USER, {
      ...DEVICE_A,
      keys: { p256dh: 'p256dh-a2', auth: 'auth-a2' },
    });

    const list = await adapter.getUserPushSubscriptions(USER);
    expect(list).toHaveLength(1);
    expect(list[0].keys).toEqual({ p256dh: 'p256dh-a2', auth: 'auth-a2' });
  });

  it('removes a subscription by endpoint', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    await adapter.savePushSubscription(USER, DEVICE_B);

    expect(await adapter.removePushSubscription(USER, DEVICE_A.endpoint)).toBe(true);

    const list = await adapter.getUserPushSubscriptions(USER);
    expect(list).toHaveLength(1);
    expect(list[0].endpoint).toBe(DEVICE_B.endpoint);
  });

  it('isolates subscriptions by user (no RLS, app-enforced)', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    await adapter.savePushSubscription(OTHER_USER, DEVICE_B);

    expect(await adapter.getUserPushSubscriptions(USER)).toHaveLength(1);
    expect((await adapter.getUserPushSubscriptions(USER))[0].endpoint).toBe(DEVICE_A.endpoint);
    expect((await adapter.getUserPushSubscriptions(OTHER_USER))[0].endpoint).toBe(
      DEVICE_B.endpoint
    );
  });

  it('returns null notification settings when the user has no subscriptions', async () => {
    expect(await adapter.getNotificationSettings(USER)).toBeNull();
  });

  it('defaults notification settings for a fresh subscription', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    expect(await adapter.getNotificationSettings(USER)).toEqual({
      enabled: true,
      taskComplete: true,
      notifyWhen: 'always',
    });
  });

  it('merges and applies notification settings across all of a users devices', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);
    await adapter.savePushSubscription(USER, DEVICE_B);

    expect(await adapter.updateNotificationSettings(USER, { notifyWhen: 'offline' })).toBe(true);
    expect(await adapter.updateNotificationSettings(USER, { taskComplete: false })).toBe(true);

    // Both partial updates merged (notifyWhen from the first, taskComplete from the second).
    expect(await adapter.getNotificationSettings(USER)).toEqual({
      enabled: true,
      taskComplete: false,
      notifyWhen: 'offline',
    });
  });

  it('persists subscriptions across a simulated restart (same data dir)', async () => {
    await adapter.savePushSubscription(USER, DEVICE_A);

    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();
    try {
      const list = await reloaded.getUserPushSubscriptions(USER);
      expect(list).toHaveLength(1);
      expect(list[0].endpoint).toBe(DEVICE_A.endpoint);
    } finally {
      reloaded.close();
    }
  });
});

describe('SqlitePushStore - direct unit coverage', () => {
  let dataDir: string;
  let store: SqlitePushStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-push-store-'));
    store = new SqlitePushStore(dataDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('handles a subscription with no keys (fcm-only device)', async () => {
    await store.savePushSubscription(USER, {
      endpoint: 'https://fcm.example.com/x',
      platform: 'android',
      fcmToken: 'fcm-x',
    });
    const list = await store.getUserPushSubscriptions(USER);
    expect(list).toEqual([
      {
        userId: USER,
        endpoint: 'https://fcm.example.com/x',
        keys: { p256dh: '', auth: '' },
        // The native FCM token is surfaced so PushNotificationService.notifyViaGateway
        // can delegate the send to the gateway.
        fcmToken: 'fcm-x',
        deviceInfo: {},
      },
    ]);
  });
});
