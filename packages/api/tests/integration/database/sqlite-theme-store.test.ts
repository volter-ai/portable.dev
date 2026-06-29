/**
 * SqliteThemeStore / SqliteDbAdapter themes Tests
 *
 * THE STORY: The themes domain is persisted on local SQLite under
 * DATA_DIR. A user's theme_config is stored in a SQLite database and round-trips
 * (persist -> read) on local SQLite. Single-user scoping is enforced by the
 * user_id filter in every query (no RLS).
 *
 * REAL SERVICES:
 * - ✅ SqliteThemeStore - real bun:sqlite database (temp dir per test)
 * - ✅ SqliteDbAdapter - real adapter under test
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SqliteDbAdapter,
  SqliteThemeStore,
  SQLITE_THEMES_DB_FILE,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'sqlite-theme-user@example.com';
const OTHER_USER = 'someone-else@example.com';

describe('SqliteDbAdapter - themes domain on local SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-theme-'));
    // 1st arg = chat data dir, 2nd arg = connections/themes data dir.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates the themes database file under the data dir', async () => {
    const stat = await fs.stat(path.join(dataDir, SQLITE_THEMES_DB_FILE));
    expect(stat.isFile()).toBe(true);
  });

  // ── The acceptance-criterion test: persist -> read a theme ──
  it('persists a theme and reads it back (persist -> read)', async () => {
    const theme = { primary: '#ff0000', mode: 'dark', radius: 8 };

    const saved = await adapter.saveTheme(USER, theme);
    expect(saved).toBe(true);

    const read = await adapter.getTheme(USER);
    expect(read).toEqual(theme);
  });

  it('returns null when no theme is saved', async () => {
    expect(await adapter.getTheme(USER)).toBeNull();
  });

  it('upserts an existing theme in place (one row per user)', async () => {
    await adapter.saveTheme(USER, { mode: 'light' });
    await adapter.saveTheme(USER, { mode: 'dark', accent: 'blue' });

    expect(await adapter.getTheme(USER)).toEqual({ mode: 'dark', accent: 'blue' });
  });

  it('isolates themes by user (no RLS, app-enforced)', async () => {
    await adapter.saveTheme(USER, { mode: 'dark' });
    await adapter.saveTheme(OTHER_USER, { mode: 'light' });

    expect(await adapter.getTheme(USER)).toEqual({ mode: 'dark' });
    expect(await adapter.getTheme(OTHER_USER)).toEqual({ mode: 'light' });
  });

  it('deletes a theme', async () => {
    await adapter.saveTheme(USER, { mode: 'dark' });
    expect(await adapter.deleteTheme(USER)).toBe(true);
    expect(await adapter.getTheme(USER)).toBeNull();
  });

  it('persists themes across a simulated restart (same data dir)', async () => {
    await adapter.saveTheme(USER, { mode: 'midnight' });

    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();
    try {
      expect(await reloaded.getTheme(USER)).toEqual({ mode: 'midnight' });
    } finally {
      reloaded.close();
    }
  });
});

describe('SqliteThemeStore - direct unit coverage', () => {
  let dataDir: string;
  let store: SqliteThemeStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-theme-store-'));
    store = new SqliteThemeStore(dataDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips a nested theme config', async () => {
    const theme = { colors: { bg: '#000', fg: '#fff' }, fonts: ['mono', 'sans'] };
    await store.saveTheme(USER, theme);
    expect(await store.getTheme(USER)).toEqual(theme);
  });
});
