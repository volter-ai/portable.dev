/**
 * rev9 Feature 1 / D27 Part B — flat-repo discovery + per-user-layer collapse.
 *
 * Proves getLocalRepositoriesIn now finds a human's FLAT `<workspace>/<repo>/.git`
 * clone (deriving owner/repo from the git remote, NOT the dir name), keeps the legacy
 * two-level layout working, and that resolveLocalRepoPath returns the REAL on-disk
 * path. Discovery is exercised against a self-owned temp dir via the
 * `getLocalRepositoriesIn(root)` seam — so it never touches the operator's real
 * workspace and does not depend on redirecting the module-level WORKSPACE_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';

import {
  extractOriginUrl,
  GitLocalService,
  parseGitHubSlug,
} from '../../../src/services/GitLocalService.js';

async function makeGitRepo(dir: string, originUrl?: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
  const config = originUrl
    ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : `[core]\n\trepositoryformatversion = 0\n`;
  await fs.writeFile(path.join(dir, '.git', 'config'), config);
}

describe('getUserWorkspaceDir collapse (rev9 D27)', () => {
  it('maps every user to the same WORKSPACE_DIR (per-user layer collapsed)', () => {
    const a = getUserWorkspaceDir('alice@example.com');
    const b = getUserWorkspaceDir('bob@example.com');
    expect(a).toBe(b);
    expect(getUserWorkspaceDir()).toBe(a);
  });
});

describe('GitLocalService.getLocalRepositoriesIn — flat-repo discovery (rev9 D27)', () => {
  let svc: GitLocalService;
  let WS: string;

  beforeEach(async () => {
    WS = await fs.mkdtemp(path.join(os.tmpdir(), 'rev9-flat-disc-'));
    svc = new GitLocalService();
  });
  afterEach(async () => {
    await fs.rm(WS, { recursive: true, force: true });
  });

  it('discovers a FLAT clone, deriving owner/repo from the git remote (NOT the dir name)', async () => {
    // dir name 'my-checkout' deliberately differs from the GitHub repo name.
    await makeGitRepo(
      path.join(WS, 'my-checkout'),
      'https://github.com/BrunoCCPires/clock-app.git'
    );
    const repos = await svc.getLocalRepositoriesIn(WS);
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('BrunoCCPires/clock-app');
    expect(repos[0].localPath).toBe(path.join(WS, 'my-checkout'));
  });

  it('keeps discovering a TWO-LEVEL clone from the dir names (back-compat)', async () => {
    await makeGitRepo(
      path.join(WS, 'octocat', 'hello-world'),
      'https://github.com/octocat/hello-world.git'
    );
    const repos = await svc.getLocalRepositoriesIn(WS);
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('octocat/hello-world');
    expect(repos[0].localPath).toBe(path.join(WS, 'octocat', 'hello-world'));
  });

  it('represents a FLAT clone with no github remote as local/<dir> (kept out of Tasks)', async () => {
    await makeGitRepo(path.join(WS, 'scratch')); // no remote at all
    await makeGitRepo(path.join(WS, 'gl'), 'git@gitlab.com:me/proj.git'); // non-github remote
    const repos = await svc.getLocalRepositoriesIn(WS);
    const byPath = Object.fromEntries(repos.map((r) => [r.localPath, r.full_name]));
    expect(byPath[path.join(WS, 'scratch')]).toBe('local/scratch');
    expect(byPath[path.join(WS, 'gl')]).toBe('local/gl');
  });

  it('finds BOTH flat and two-level clones in one workspace', async () => {
    await makeGitRepo(path.join(WS, 'flatrepo'), 'git@github.com:me/flatrepo.git');
    await makeGitRepo(path.join(WS, 'acme', 'widget'), 'https://github.com/acme/widget');
    const repos = await svc.getLocalRepositoriesIn(WS);
    expect(repos.map((r) => r.full_name).sort()).toEqual(['acme/widget', 'me/flatrepo']);
  });

  it('ignores node_modules and non-repo dirs', async () => {
    await fs.mkdir(path.join(WS, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(WS, 'data', 'media'), { recursive: true });
    await fs.mkdir(path.join(WS, '.chat-data'), { recursive: true });
    expect(await svc.getLocalRepositoriesIn(WS)).toHaveLength(0);
  });

  it('skips the workspace scratch dir `tmp` even if it has a stray .git (never a project)', async () => {
    // `tmp` is the one-off / "Workspace" chat scratch folder — never a Portable project,
    // so a git-init'd tmp must NOT surface as a repo. A real repo alongside it still does.
    await makeGitRepo(path.join(WS, 'tmp'), 'https://github.com/someone/tmp.git');
    await makeGitRepo(path.join(WS, 'realrepo'), 'git@github.com:me/realrepo.git');
    const repos = await svc.getLocalRepositoriesIn(WS);
    expect(repos.map((r) => r.full_name)).toEqual(['me/realrepo']);
  });

  it('returns [] for a non-existent workspace root (never throws)', async () => {
    expect(await svc.getLocalRepositoriesIn(path.join(WS, 'does-not-exist'))).toEqual([]);
  });
});

describe('GitLocalService.resolveLocalRepoPath (rev9 D27)', () => {
  it('returns the discovered flat path when present, else the canonical two-level path', async () => {
    const svc = new GitLocalService();
    const ws = getUserWorkspaceDir('u');
    // Stub discovery so we never touch the filesystem / real workspace.
    spyOn(svc, 'getLocalRepositoriesIn').mockResolvedValue([
      { full_name: 'me/clock-app', localPath: path.join(ws, 'my-checkout') },
    ]);

    // present (flat) → its REAL on-disk path (so portable uses it, not a duplicate clone)
    expect(await svc.resolveLocalRepoPath('u', 'me', 'clock-app')).toBe(
      path.join(ws, 'my-checkout')
    );
    // case-insensitive full_name match
    expect(await svc.resolveLocalRepoPath('u', 'ME', 'Clock-App')).toBe(
      path.join(ws, 'my-checkout')
    );
    // absent → canonical two-level path for auto-clone
    expect(await svc.resolveLocalRepoPath('u', 'someone', 'absent')).toBe(
      path.join(ws, 'someone', 'absent')
    );
  });
});

describe('parseGitHubSlug (rev9 D27)', () => {
  it('parses https / ssh / scp github URLs, stripping .git and trailing slashes', () => {
    expect(parseGitHubSlug('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseGitHubSlug('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseGitHubSlug('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseGitHubSlug('ssh://git@github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseGitHubSlug('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for non-github hosts and garbage', () => {
    expect(parseGitHubSlug('git@gitlab.com:me/proj.git')).toBeNull();
    expect(parseGitHubSlug('https://bitbucket.org/me/proj.git')).toBeNull();
    expect(parseGitHubSlug('not a url')).toBeNull();
  });
});

describe('extractOriginUrl (rev9 D27)', () => {
  it('extracts the origin url from a git config across section ordering', () => {
    const cfg = `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/r.git\n\tfetch = +refs/heads/*\n[branch "main"]\n\tremote = origin\n`;
    expect(extractOriginUrl(cfg)).toBe('https://github.com/o/r.git');
  });

  it('returns null when there is no origin remote', () => {
    expect(extractOriginUrl('[core]\n\tbare = false\n')).toBeNull();
    expect(
      extractOriginUrl('[remote "upstream"]\n\turl = https://github.com/o/r.git\n')
    ).toBeNull();
  });
});
