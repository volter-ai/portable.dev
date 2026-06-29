/**
 * SqliteServiceAccountStore / SqliteDbAdapter service-accounts + audit-log Tests
 *
 * THE STORY: The service-accounts and service-account-audit-log domains are
 * persisted on local SQLite under DATA_DIR. A service account
 * round-trips (create -> read) and an audit log entry round-trips (log -> read)
 * on local SQLite. Single-user scoping is enforced by the user_id filter in
 * every service-account query (no RLS).
 *
 * REAL SERVICES:
 * - ✅ SqliteServiceAccountStore - real bun:sqlite database (temp dir per test)
 * - ✅ SqliteDbAdapter - real adapter under test
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SqliteDbAdapter,
  SqliteServiceAccountStore,
  SQLITE_SERVICE_ACCOUNTS_DB_FILE,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'sqlite-sa-user@example.com';
const OTHER_USER = 'someone-else@example.com';

const ACCOUNT_A = {
  id: 'sa-aaaa-1111',
  userId: USER,
  name: 'CI bot',
  description: 'used by GitHub Actions',
  tokenPrefix: 'sa_abc1234',
  tokenEncrypted: { encrypted: 'sa_abc1234deadbeef', iv: 'iv-a', tag: 'tag-a' },
  allowedUserIds: ['u1', 'u2'],
};

describe('SqliteDbAdapter - service-accounts domain on local SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-sa-'));
    // 1st arg = chat data dir, 2nd arg = connections/themes/push/SA data dir.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the service-accounts database file under the data dir', async () => {
    const stat = await fs.stat(path.join(dataDir, SQLITE_SERVICE_ACCOUNTS_DB_FILE));
    expect(stat.isFile()).toBe(true);
  });

  // ── The acceptance-criterion test (service accounts): create -> read ──
  it('creates a service account and reads it back (create -> read)', async () => {
    expect(await adapter.createServiceAccount(ACCOUNT_A)).toBe(true);

    const sa = await adapter.getServiceAccount(ACCOUNT_A.id, USER);
    expect(sa).not.toBeNull();
    expect(sa!.id).toBe(ACCOUNT_A.id);
    expect(sa!.userId).toBe(USER);
    expect(sa!.name).toBe('CI bot');
    expect(sa!.description).toBe('used by GitHub Actions');
    expect(sa!.tokenPrefix).toBe('sa_abc1234');
    expect(sa!.tokenEncrypted).toEqual(ACCOUNT_A.tokenEncrypted);
    expect(sa!.allowedUserIds).toEqual(['u1', 'u2']);
    expect(sa!.enabled).toBe(true);
    expect(sa!.createdAt).toBeInstanceOf(Date);
    expect(sa!.updatedAt).toBeInstanceOf(Date);
  });

  it('lists a user accounts and isolates by user (no RLS, app-enforced)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);
    await adapter.createServiceAccount({
      ...ACCOUNT_A,
      id: 'sa-bbbb-2222',
      userId: OTHER_USER,
      tokenPrefix: 'sa_other999',
      tokenEncrypted: { encrypted: 'sa_other999xyz' },
    });

    const mine = await adapter.getServiceAccounts(USER);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(ACCOUNT_A.id);

    const theirs = await adapter.getServiceAccounts(OTHER_USER);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].id).toBe('sa-bbbb-2222');

    // Reading another user's account by id returns null.
    expect(await adapter.getServiceAccount(ACCOUNT_A.id, OTHER_USER)).toBeNull();
  });

  it('finds a service account by token prefix (for validation)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);

    const byPrefix = await adapter.getServiceAccountByPrefix('sa_abc1234');
    expect(byPrefix).not.toBeNull();
    expect(byPrefix!.id).toBe(ACCOUNT_A.id);
    expect(byPrefix!.userId).toBe(USER);
    expect(byPrefix!.tokenEncrypted).toEqual(ACCOUNT_A.tokenEncrypted);
    expect(byPrefix!.rateLimitRequestsCount).toBe(0);

    expect(await adapter.getServiceAccountByPrefix('sa_missing')).toBeNull();
  });

  it('updates fields (and re-derives the token prefix on token change)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);

    expect(
      await adapter.updateServiceAccount(ACCOUNT_A.id, USER, {
        name: 'CI bot v2',
        enabled: false,
        allowedUserIds: ['u3'],
        tokenEncrypted: { encrypted: 'sa_new5678rotated' },
      })
    ).toBe(true);

    const sa = await adapter.getServiceAccount(ACCOUNT_A.id, USER);
    expect(sa!.name).toBe('CI bot v2');
    expect(sa!.enabled).toBe(false);
    expect(sa!.allowedUserIds).toEqual(['u3']);
    // token_prefix re-derived from the first 10 chars of the new encrypted token.
    expect(sa!.tokenPrefix).toBe('sa_new5678');
  });

  it('tracks usage + rate limit counters', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);

    expect(await adapter.updateServiceAccountUsage(ACCOUNT_A.id)).toBe(true);
    const afterUse = await adapter.getServiceAccount(ACCOUNT_A.id, USER);
    expect(afterUse!.lastUsedAt).toBeInstanceOf(Date);

    const windowStart = new Date('2026-06-22T00:00:00.000Z');
    expect(await adapter.updateServiceAccountRateLimit(ACCOUNT_A.id, 42, windowStart)).toBe(true);
    const byPrefix = await adapter.getServiceAccountByPrefix('sa_abc1234');
    expect(byPrefix!.rateLimitRequestsCount).toBe(42);
    expect(byPrefix!.rateLimitWindowStart?.toISOString()).toBe(windowStart.toISOString());
  });

  it('deletes a service account (scoped by user)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);
    expect(await adapter.deleteServiceAccount(ACCOUNT_A.id, USER)).toBe(true);
    expect(await adapter.getServiceAccount(ACCOUNT_A.id, USER)).toBeNull();
  });

  // ── The acceptance-criterion test (audit log): log -> read ──
  it('writes an audit log entry and reads it back (log -> read)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);

    expect(
      await adapter.createServiceAccountAuditLog({
        serviceAccountId: ACCOUNT_A.id,
        userId: USER,
        action: 'create',
        details: { source: 'cli' },
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        success: true,
      })
    ).toBe(true);

    const logs = await adapter.getServiceAccountAuditLogs(ACCOUNT_A.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].serviceAccountId).toBe(ACCOUNT_A.id);
    expect(logs[0].userId).toBe(USER);
    expect(logs[0].action).toBe('create');
    expect(logs[0].details).toEqual({ source: 'cli' });
    expect(logs[0].ipAddress).toBe('127.0.0.1');
    expect(logs[0].userAgent).toBe('jest');
    expect(logs[0].success).toBe(true);
    expect(logs[0].id).toBeTruthy();
    expect(logs[0].createdAt).toBeInstanceOf(Date);
  });

  it('filters audit logs by action + success and applies limit', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);
    await adapter.createServiceAccountAuditLog({
      serviceAccountId: ACCOUNT_A.id,
      userId: USER,
      action: 'use',
      success: true,
    });
    await adapter.createServiceAccountAuditLog({
      serviceAccountId: ACCOUNT_A.id,
      userId: USER,
      action: 'delete',
      success: false,
      errorMessage: 'boom',
    });

    const onlyUse = await adapter.getServiceAccountAuditLogs(ACCOUNT_A.id, { action: 'use' });
    expect(onlyUse).toHaveLength(1);
    expect(onlyUse[0].action).toBe('use');

    const failures = await adapter.getServiceAccountAuditLogs(ACCOUNT_A.id, { success: false });
    expect(failures).toHaveLength(1);
    expect(failures[0].action).toBe('delete');
    expect(failures[0].errorMessage).toBe('boom');

    const limited = await adapter.getServiceAccountAuditLogs(ACCOUNT_A.id, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('persists service accounts across a simulated restart (same data dir)', async () => {
    await adapter.createServiceAccount(ACCOUNT_A);

    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();
    try {
      const sa = await reloaded.getServiceAccount(ACCOUNT_A.id, USER);
      expect(sa).not.toBeNull();
      expect(sa!.name).toBe('CI bot');
    } finally {
      reloaded.close();
    }
  });
});

describe('SqliteServiceAccountStore - direct unit coverage', () => {
  let dataDir: string;
  let store: SqliteServiceAccountStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-sa-store-'));
    store = new SqliteServiceAccountStore(dataDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates an account with no description / empty allowed users', async () => {
    await store.createServiceAccount({
      id: 'sa-min',
      userId: USER,
      name: 'minimal',
      tokenPrefix: 'sa_min0001',
      tokenEncrypted: { encrypted: 'sa_min0001zzz' },
      allowedUserIds: [],
    });
    const sa = await store.getServiceAccount('sa-min', USER);
    expect(sa!.description).toBeUndefined();
    expect(sa!.allowedUserIds).toEqual([]);
    expect(sa!.enabled).toBe(true);
  });
});
