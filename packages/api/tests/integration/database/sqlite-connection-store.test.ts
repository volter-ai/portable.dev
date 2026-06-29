/**
 * SqliteConnectionStore / SqliteDbAdapter connections Tests
 *
 * THE STORY: The connections domain is persisted on local SQLite
 * under DATA_DIR. A service connection's METADATA is stored in a SQLite database
 * and round-trips (create -> read) on local SQLite. Single-user scoping is
 * enforced by the user_id filter in every query (no RLS).
 *
 * REAL SERVICES:
 * - ✅ SqliteConnectionStore - real bun:sqlite database (temp dir per test)
 * - ✅ SqliteDbAdapter - real adapter under test
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SqliteDbAdapter,
  SqliteConnectionStore,
  SQLITE_CONNECTIONS_DB_FILE,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'sqlite-conn-user@example.com';
const OTHER_USER = 'someone-else@example.com';

describe('SqliteDbAdapter - connections domain on local SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-conn-'));
    // 1st arg = chat data dir, 2nd arg = connections data dir.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the connections database file under the data dir', async () => {
    const stat = await fs.stat(path.join(dataDir, SQLITE_CONNECTIONS_DB_FILE));
    expect(stat.isFile()).toBe(true);
  });

  // ── The acceptance-criterion test: create -> read a connection ──
  it('stores a connection and reads it back (create -> read)', async () => {
    const stored = await adapter.storeConnection({
      userId: USER,
      connectionId: 'slack_1',
      displayName: 'My Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: 'xoxp-secret' },
    });

    expect(stored.connectionId).toBe('slack_1');
    expect(stored.displayName).toBe('My Slack');
    expect(stored.isActive).toBe(true);

    const read = await adapter.getConnection({ userId: USER, connectionId: 'slack_1' });
    expect(read).not.toBeNull();
    expect(read!.connectionId).toBe('slack_1');
    expect(read!.service).toBe('slack');
    expect(read!.serviceType).toBe('sdk');
    expect(read!.displayName).toBe('My Slack');
    expect(read!.credentials).toEqual({ token: 'xoxp-secret' });
    expect(read!.connectedAt).toBeInstanceOf(Date);
  });

  it('lists a user’s connections and isolates them by user (no RLS, app-enforced)', async () => {
    await adapter.storeConnection({
      userId: USER,
      connectionId: 'slack_1',
      displayName: 'Mine',
      service: 'slack',
      serviceType: 'sdk',
      credentials: {},
    });
    await adapter.storeConnection({
      userId: OTHER_USER,
      connectionId: 'slack_1',
      displayName: 'Theirs',
      service: 'slack',
      serviceType: 'sdk',
      credentials: {},
    });

    const mine = await adapter.getUserConnections({ userId: USER });
    expect(mine).toHaveLength(1);
    expect(mine[0].displayName).toBe('Mine');

    const theirs = await adapter.getConnection({ userId: OTHER_USER, connectionId: 'slack_1' });
    expect(theirs!.displayName).toBe('Theirs');
  });

  it('hasConnection / getConnectionCredentials reflect stored state', async () => {
    expect(await adapter.hasConnection({ userId: USER, connectionId: 'aws_1' })).toBe(false);

    await adapter.storeConnection({
      userId: USER,
      connectionId: 'aws_1',
      displayName: 'AWS',
      service: 'aws',
      serviceType: 'cli',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'shh' },
    });

    expect(await adapter.hasConnection({ userId: USER, connectionId: 'aws_1' })).toBe(true);
    const creds = await adapter.getConnectionCredentials({ userId: USER, connectionId: 'aws_1' });
    expect(creds).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });
  });

  it('toggleConnectionActive disables other connections of the same exclusive service', async () => {
    for (const id of ['aws_1', 'aws_2']) {
      await adapter.storeConnection({
        userId: USER,
        connectionId: id,
        displayName: id,
        service: 'aws',
        serviceType: 'cli',
        credentials: {},
      });
    }

    // Both are active-by-default on insert; activating aws_1 must deactivate aws_2.
    await adapter.toggleConnectionActive({ userId: USER, connectionId: 'aws_1', isActive: true });

    const active = await adapter.getActiveConnectionsByService({ userId: USER, service: 'aws' });
    expect(active).toHaveLength(1);
    expect(active[0].connectionId).toBe('aws_1');
  });

  it('renames and deletes a connection', async () => {
    await adapter.storeConnection({
      userId: USER,
      connectionId: 'slack_1',
      displayName: 'Old',
      service: 'slack',
      serviceType: 'sdk',
      credentials: {},
    });

    const renamed = await adapter.renameConnection({
      userId: USER,
      oldConnectionId: 'slack_1',
      newConnectionId: 'slack_work',
      newDisplayName: 'Work Slack',
    });
    expect(renamed.connectionId).toBe('slack_work');
    expect(renamed.displayName).toBe('Work Slack');
    expect(await adapter.getConnection({ userId: USER, connectionId: 'slack_1' })).toBeNull();

    await adapter.deleteConnection({ userId: USER, connectionId: 'slack_work' });
    expect(await adapter.getConnection({ userId: USER, connectionId: 'slack_work' })).toBeNull();
  });

  it('persists connections across a simulated restart (same data dir)', async () => {
    await adapter.storeConnection({
      userId: USER,
      connectionId: 'notion_1',
      displayName: 'Notion',
      service: 'notion',
      serviceType: 'sdk',
      credentials: { token: 'ntn' },
    });

    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();
    try {
      const read = await reloaded.getConnection({ userId: USER, connectionId: 'notion_1' });
      expect(read).not.toBeNull();
      expect(read!.displayName).toBe('Notion');
    } finally {
      reloaded.close();
    }
  });
});

describe('SqliteConnectionStore - direct unit coverage', () => {
  let dataDir: string;
  let store: SqliteConnectionStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-conn-store-'));
    store = new SqliteConnectionStore(dataDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('upserts an existing connection in place (preserves id, updates fields)', async () => {
    const first = await store.storeConnection({
      userId: USER,
      connectionId: 'slack_1',
      displayName: 'V1',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: 'a' },
    });
    const second = await store.storeConnection({
      userId: USER,
      connectionId: 'slack_1',
      displayName: 'V2',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: 'b' },
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('V2');

    const all = await store.getUserConnections({ userId: USER });
    expect(all).toHaveLength(1);
    expect(all[0].credentials).toEqual({ token: 'b' });
  });
});
