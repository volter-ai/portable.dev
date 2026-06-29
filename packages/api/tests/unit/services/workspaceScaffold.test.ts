/**
 * workspaceScaffold — the workspace-as-a-Claude-project scaffolder.
 *
 * Proves ensureWorkspaceScaffold creates `<workspace>/CLAUDE.md` + `<workspace>/tmp/` +
 * `<workspace>/tmp/CLAUDE.md`, is idempotent, NEVER overwrites a user-edited file, and
 * never throws (best-effort). Runs against a self-owned temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { ensureWorkspaceScaffold } from '../../../src/services/workspaceScaffold.js';

describe('ensureWorkspaceScaffold', () => {
  let WS: string;

  beforeEach(async () => {
    WS = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-scaffold-'));
  });
  afterEach(async () => {
    await fs.rm(WS, { recursive: true, force: true });
  });

  it('creates the workspace CLAUDE.md, the tmp/ dir, and tmp/CLAUDE.md', async () => {
    await ensureWorkspaceScaffold(WS);

    const rootMd = await fs.readFile(path.join(WS, 'CLAUDE.md'), 'utf8');
    const tmpMd = await fs.readFile(path.join(WS, 'tmp', 'CLAUDE.md'), 'utf8');

    expect(await fs.stat(path.join(WS, 'tmp')).then((s) => s.isDirectory())).toBe(true);
    // Root documents the workspace taxonomy + what Portable is.
    expect(rootMd).toContain('Portable workspace');
    expect(rootMd).toContain('tmp/');
    // tmp documents one-off / scratch usage.
    expect(tmpMd.toLowerCase()).toContain('scratch');
    expect(tmpMd).toContain('one-off');
  });

  it('git-inits the tmp scratch so it is a valid git repo (cwd for one-off chats)', async () => {
    await ensureWorkspaceScaffold(WS);
    // ExecutionHandler sets a LOCAL git identity in the cwd before every run and throws
    // on a non-git dir, so the scratch must be a real repo.
    expect(await fs.stat(path.join(WS, 'tmp', '.git')).then((s) => s.isDirectory())).toBe(true);
  });

  it('creates the workspace root if it does not exist yet', async () => {
    const fresh = path.join(WS, 'nested', 'workspace');
    await ensureWorkspaceScaffold(fresh);
    expect(await fs.stat(path.join(fresh, 'tmp')).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.readFile(path.join(fresh, 'CLAUDE.md'), 'utf8')).toContain('Portable');
  });

  it('NEVER overwrites a user-edited CLAUDE.md (write-if-absent + idempotent)', async () => {
    await fs.mkdir(path.join(WS, 'tmp'), { recursive: true });
    await fs.writeFile(path.join(WS, 'CLAUDE.md'), 'MY EDITS', 'utf8');
    await fs.writeFile(path.join(WS, 'tmp', 'CLAUDE.md'), 'MY TMP EDITS', 'utf8');

    await ensureWorkspaceScaffold(WS);
    await ensureWorkspaceScaffold(WS); // idempotent — second call is a no-op too

    expect(await fs.readFile(path.join(WS, 'CLAUDE.md'), 'utf8')).toBe('MY EDITS');
    expect(await fs.readFile(path.join(WS, 'tmp', 'CLAUDE.md'), 'utf8')).toBe('MY TMP EDITS');
  });

  it('never throws on a bad workspace path', async () => {
    // A path whose parent is a FILE cannot be mkdir'd — must be swallowed, not thrown.
    const filePath = path.join(WS, 'iam-a-file');
    await fs.writeFile(filePath, 'x', 'utf8');
    await expect(
      ensureWorkspaceScaffold(path.join(filePath, 'cannot', 'exist'))
    ).resolves.toBeUndefined();
  });
});
