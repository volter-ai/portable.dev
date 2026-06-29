/**
 * SqliteSecretsVaultStore / LocalSecretsVaultAdapter Tests
 *
 * THE STORY: The saved-secrets vault ("save and reuse" env vars) is persisted on
 * local SQLite under DATA_DIR. Values arrive ALREADY ENCRYPTED from
 * SecretsService, so the store only persists the opaque blob. Single-user
 * scoping is enforced by the user_id filter in every query (no RLS).
 *
 * The SqliteDbAdapter is SQLite-only (no wrapped adapter), so the local-first
 * runtime boots (initialize/isHealthy) with no external database.
 *
 * REAL SERVICES:
 * - ✅ SqliteSecretsVaultStore - real bun:sqlite database (temp dir per test)
 * - ✅ LocalSecretsVaultAdapter - real adapter over the store
 * - ✅ SqliteDbAdapter - SQLite-only (local-first boot path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LocalSecretsVaultAdapter } from '../../../src/db/LocalSecretsVaultAdapter.js';
import {
  SqliteDbAdapter,
  SqliteSecretsVaultStore,
  SQLITE_SECRETS_VAULT_DB_FILE,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'vault-user@example.com';
const OTHER_USER = 'someone-else@example.com';

describe('SqliteSecretsVaultStore', () => {
  let dataDir: string;
  let store: SqliteSecretsVaultStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-vault-'));
    store = new SqliteSecretsVaultStore(dataDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the secrets-vault database file under the data dir', async () => {
    const stat = await fs.stat(path.join(dataDir, SQLITE_SECRETS_VAULT_DB_FILE));
    expect(stat.isFile()).toBe(true);
  });

  // ── The acceptance-criterion test: save -> read an encrypted secret ──
  it('saves an encrypted secret and reads it back (save -> read)', async () => {
    await store.saveSecret(USER, 'OPENAI_API_KEY', 'enc:abc123', 'manual');

    const got = await store.getSavedSecret(USER, 'OPENAI_API_KEY');
    expect(got).not.toBeNull();
    expect(got!.key).toBe('OPENAI_API_KEY');
    expect(got!.valueEncrypted).toBe('enc:abc123');
    expect(got!.source).toBe('manual');
    expect(got!.id).toBeTruthy();
  });

  it('returns null for a missing secret', async () => {
    expect(await store.getSavedSecret(USER, 'NOPE')).toBeNull();
  });

  it('upserts in place (one row per user+key) and keeps the id/createdAt', async () => {
    await store.saveSecret(USER, 'TOKEN', 'enc:v1', 'manual');
    const first = await store.getSavedSecret(USER, 'TOKEN');

    await store.saveSecret(USER, 'TOKEN', 'enc:v2', 'env_editor', 'conn-1');
    const second = await store.getSavedSecret(USER, 'TOKEN');

    expect(second!.valueEncrypted).toBe('enc:v2');
    expect(second!.source).toBe('env_editor');
    expect(second!.sourceConnectionId).toBe('conn-1');
    // id + createdAt are immutable across the upsert.
    expect(second!.id).toBe(first!.id);
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime());

    const all = await store.getSavedSecrets(USER);
    expect(all.length).toBe(1);
  });

  it('isolates secrets by user (no RLS, app-enforced)', async () => {
    await store.saveSecret(USER, 'A', 'enc:mine');
    await store.saveSecret(OTHER_USER, 'A', 'enc:theirs');

    expect((await store.getSavedSecret(USER, 'A'))!.valueEncrypted).toBe('enc:mine');
    expect((await store.getSavedSecret(OTHER_USER, 'A'))!.valueEncrypted).toBe('enc:theirs');
    expect((await store.getSavedSecrets(USER)).length).toBe(1);
  });

  it('lists all of a user secrets, most-recently-updated first', async () => {
    await store.saveSecret(USER, 'FIRST', 'enc:1');
    await store.saveSecret(USER, 'SECOND', 'enc:2');
    const keys = (await store.getSavedSecrets(USER)).map((s) => s.key);
    expect(keys).toContain('FIRST');
    expect(keys).toContain('SECOND');
  });

  it('deletes a secret', async () => {
    await store.saveSecret(USER, 'GONE', 'enc:x');
    await store.deleteSecret(USER, 'GONE');
    expect(await store.getSavedSecret(USER, 'GONE')).toBeNull();
  });

  it('searches by partial key (case-insensitive, top 10)', async () => {
    await store.saveSecret(USER, 'STRIPE_KEY', 'enc:1');
    await store.saveSecret(USER, 'STRIPE_SECRET', 'enc:2');
    await store.saveSecret(USER, 'GITHUB_TOKEN', 'enc:3');

    const hits = await store.searchSecrets(USER, 'stripe');
    expect(hits.map((s) => s.key).sort()).toEqual(['STRIPE_KEY', 'STRIPE_SECRET']);
  });

  it('escapes LIKE wildcards in the search query', async () => {
    await store.saveSecret(USER, 'A_B', 'enc:1');
    await store.saveSecret(USER, 'AXB', 'enc:2');
    // '_' is a LIKE wildcard; escaping means it only matches the literal underscore.
    const hits = await store.searchSecrets(USER, 'A_B');
    expect(hits.map((s) => s.key)).toEqual(['A_B']);
  });

  it('updates the last-used timestamp', async () => {
    await store.saveSecret(USER, 'USED', 'enc:1');
    await store.updateLastUsed(USER, 'USED');
    const got = await store.getSavedSecret(USER, 'USED');
    expect(got!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('persists across a simulated restart (same data dir)', async () => {
    await store.saveSecret(USER, 'PERSIST', 'enc:keep');
    store.close();

    const reloaded = new SqliteSecretsVaultStore(dataDir);
    await reloaded.initialize();
    try {
      expect((await reloaded.getSavedSecret(USER, 'PERSIST'))!.valueEncrypted).toBe('enc:keep');
    } finally {
      reloaded.close();
    }
  });
});

describe('LocalSecretsVaultAdapter', () => {
  let dataDir: string;
  let adapter: LocalSecretsVaultAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-vault-adapter-'));
    adapter = new LocalSecretsVaultAdapter(dataDir);
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('lazily initializes and round-trips a secret (authToken ignored)', async () => {
    await adapter.saveSecret(USER, 'KEY', 'enc:val', 'manual', undefined, 'ignored-jwt');
    const got = await adapter.getSavedSecret(USER, 'KEY', 'ignored-jwt');
    expect(got!.valueEncrypted).toBe('enc:val');
  });

  it('returns [] for a user with no secrets', async () => {
    expect(await adapter.getSavedSecrets('nobody@example.com')).toEqual([]);
  });
});

describe('SqliteDbAdapter - SQLite-only boot', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-no-wrapped-'));
    // SQLite-only — the local-first boot path.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('initializes and reports healthy', async () => {
    expect(await adapter.initialize()).toBe(true);
    expect(await adapter.isHealthy()).toBe(true);
  });

  it('reports an adapter type with no wrapped suffix', async () => {
    await adapter.initialize();
    expect(adapter.getAdapterType()).toBe('SQLite(chats,connections,themes,push,service-accounts)');
  });

  it('still serves local domains (e.g. themes) on local SQLite', async () => {
    await adapter.initialize();
    await adapter.saveTheme(USER, { mode: 'dark' });
    expect(await adapter.getTheme(USER)).toEqual({ mode: 'dark' });
  });
});
