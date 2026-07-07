/**
 * assertSafeTestDir — the filesystem guard that makes it structurally impossible
 * for the test suite to delete real files (issue #1563).
 *
 * The suite `fs.rm(..., { recursive: true, force: true })`s WORKSPACE_DIR/DATA_DIR
 * between cases. After the rev9 D27 collapse those deletes hit the workspace ROOT,
 * and a developer whose `.env` points WORKSPACE_DIR at the parent folder that
 * CONTAINS this repo would lose the repo + untracked `.env*` files. This test
 * pins the guard's contract: it must ACCEPT throwaway temp dirs and REFUSE the
 * repo, any git working tree, and any non-temp real path. Reverting the guard to
 * a no-op makes these expectations fail loudly.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import { resolveDataDir } from '@vgit2/shared/secrets';

import { assertSafeTestDir } from '../../setup/assertSafeTestDir';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// This file lives at packages/api/tests/unit/setup — five levels down.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const REPO_PARENT = path.dirname(REPO_ROOT); // the exact shape of the 2026-07-03 incident

describe('assertSafeTestDir (issue #1563)', () => {
  it('ACCEPTS a throwaway dir under the OS temp dir', () => {
    const safe = path.join(os.tmpdir(), `portable-test-workspace-${process.pid}`);
    expect(() => assertSafeTestDir('WORKSPACE_DIR', safe)).not.toThrow();
  });

  it('ACCEPTS an existing mkdtemp dir under the OS temp dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-safe-ok-'));
    try {
      expect(() => assertSafeTestDir('DATA_DIR', dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES an empty or missing value', () => {
    expect(() => assertSafeTestDir('WORKSPACE_DIR', '')).toThrow(/empty/i);
    expect(() => assertSafeTestDir('WORKSPACE_DIR', '   ')).toThrow(/empty/i);
    expect(() => assertSafeTestDir('WORKSPACE_DIR', undefined)).toThrow(/empty/i);
    expect(() => assertSafeTestDir('WORKSPACE_DIR', null)).toThrow(/empty/i);
  });

  it('REFUSES a path inside the repo', () => {
    // This test file itself is inside the repo AND inside a git working tree.
    expect(() => assertSafeTestDir('WORKSPACE_DIR', HERE)).toThrow(/1563/);
    expect(() => assertSafeTestDir('WORKSPACE_DIR', REPO_ROOT)).toThrow(/1563/);
  });

  it('REFUSES the repo parent — the exact incident path', () => {
    // e.g. WORKSPACE_DIR=/Users/<me>/volter with the repo at /Users/<me>/volter/mobile-vgit
    expect(() => assertSafeTestDir('WORKSPACE_DIR', REPO_PARENT)).toThrow(/1563/);
  });

  it('REFUSES a non-temp real path (home dir)', () => {
    expect(() => assertSafeTestDir('DATA_DIR', os.homedir())).toThrow(/1563/);
  });

  it('REFUSES a dir inside a git working tree even when it is under the temp dir', () => {
    const fakeTree = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-safe-gittree-'));
    fs.mkdirSync(path.join(fakeTree, '.git'));
    try {
      const child = path.join(fakeTree, 'workspace');
      expect(() => assertSafeTestDir('WORKSPACE_DIR', child)).toThrow(/git working tree/);
    } finally {
      fs.rmSync(fakeTree, { recursive: true, force: true });
    }
  });
});

describe('test-dir isolation is active end-to-end (isolateTestDirs, issue #1563)', () => {
  // These assert the EFFECTIVE dirs the app resolves — i.e. that the preload's
  // force-set actually took effect before @vgit2/shared froze WORKSPACE_DIR. If
  // the force-set ever silently stops applying, these fail here (and the preload
  // guard hard-aborts the whole run), instead of a test deleting the real repo.
  it('the resolved WORKSPACE_DIR is a safe temp dir', () => {
    expect(() => assertSafeTestDir('WORKSPACE_DIR', getUserWorkspaceDir())).not.toThrow();
  });

  it('the resolved DATA_DIR is a safe temp dir', () => {
    expect(() => assertSafeTestDir('DATA_DIR', resolveDataDir())).not.toThrow();
  });
});
