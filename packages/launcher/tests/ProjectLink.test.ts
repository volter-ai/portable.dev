/**
 * ProjectLink tests — the junction + repo-views.json mechanics behind
 * `portable link` / `unlink` / auto-link. Runs against real temp dirs so the
 * cross-platform junction (fs.symlink type 'junction') is exercised for real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  classifyDir,
  deriveProjectName,
  isFilesystemRoot,
  isUnder,
  linkProject,
  parseOwnerRepoFromUrl,
  resolveWorkspaceDir,
  unlinkProject,
} from '../src/ProjectLink.js';

let tmp: string;
let home: string;
let workspace: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-link-test-')));
  home = path.join(tmp, 'home');
  workspace = path.join(home, 'claude-workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeGitRepo(dir: string, remoteUrl?: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (remoteUrl) {
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      `[core]\n[remote "origin"]\n\turl = ${remoteUrl}\n`
    );
  }
  return dir;
}

function readViews(): string[] {
  const p = path.join(workspace, '.vgit', 'repo-views.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as string[]) : [];
}

describe('parseOwnerRepoFromUrl', () => {
  it('parses https, ssh-scp, ssh-url, with/without .git + trailing slash', () => {
    expect(parseOwnerRepoFromUrl('https://github.com/volter-ai/mobile-vgit.git')).toEqual({
      owner: 'volter-ai',
      repo: 'mobile-vgit',
    });
    expect(parseOwnerRepoFromUrl('git@github.com:oliver-io/unreal-mcp.git')).toEqual({
      owner: 'oliver-io',
      repo: 'unreal-mcp',
    });
    expect(parseOwnerRepoFromUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
    expect(parseOwnerRepoFromUrl('ssh://git@github.com/owner/repo.git/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('takes the last two segments for nested groups, returns null for junk', () => {
    expect(parseOwnerRepoFromUrl('https://gitlab.com/group/sub/repo.git')).toEqual({
      owner: 'sub',
      repo: 'repo',
    });
    expect(parseOwnerRepoFromUrl('not-a-url')).toBeNull();
    expect(parseOwnerRepoFromUrl('https://github.com/justowner')).toBeNull();
  });
});

describe('deriveProjectName', () => {
  it('uses the git origin remote when present', () => {
    const dir = makeGitRepo(path.join(tmp, 'proj'), 'git@github.com:acme/widgets.git');
    expect(deriveProjectName(dir)).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      fullName: 'acme/widgets',
      source: 'remote',
    });
  });

  it('falls back to local/<basename> with no remote', () => {
    const dir = makeGitRepo(path.join(tmp, 'no-remote-proj'));
    expect(deriveProjectName(dir)).toMatchObject({
      owner: 'local',
      repo: 'no-remote-proj',
      fullName: 'local/no-remote-proj',
      source: 'placeholder',
    });
  });
});

describe('path predicates', () => {
  it('isUnder + isFilesystemRoot', () => {
    expect(isUnder(path.join(home, 'a', 'b'), home)).toBe(true);
    expect(isUnder(home, home)).toBe(true);
    expect(isUnder(home, path.join(home, 'a'))).toBe(false);
    expect(isFilesystemRoot(path.parse(process.cwd()).root)).toBe(true);
    expect(isFilesystemRoot(home)).toBe(false);
  });
});

describe('classifyDir', () => {
  it('a git repo UNDER home is auto-eligible', () => {
    const dir = makeGitRepo(path.join(home, 'code', 'app'), 'https://github.com/me/app.git');
    const c = classifyDir(dir, { homedir: home });
    expect(c).toMatchObject({
      isGitRepo: true,
      isHome: false,
      isUnderHome: true,
      autoEligible: true,
    });
  });

  it('the home dir itself is NOT auto-eligible (isHome)', () => {
    makeGitRepo(home, 'https://github.com/me/home.git');
    const c = classifyDir(home, { homedir: home });
    expect(c.isHome).toBe(true);
    expect(c.autoEligible).toBe(false);
  });

  it('a non-git dir under home is not eligible', () => {
    const dir = path.join(home, 'notes');
    fs.mkdirSync(dir, { recursive: true });
    expect(classifyDir(dir, { homedir: home }).autoEligible).toBe(false);
  });

  it('a filesystem root is protected', () => {
    const root = path.parse(process.cwd()).root;
    expect(classifyDir(root, { homedir: home }).isProtected).toBe(true);
  });
});

describe('linkProject', () => {
  it('creates the junction + repo-views entry for a repo outside the workspace', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    const res = linkProject({ dir, workspaceDir: workspace });

    expect(res.ok).toBe(true);
    expect(res.fullName).toBe('me/app');
    const junction = path.join(workspace, 'me', 'app');
    expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(junction)).toBe(fs.realpathSync(dir));
    expect(readViews()).toEqual(['me/app']);
  });

  it('is idempotent — re-linking reports alreadyLinked and does not duplicate the view', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    linkProject({ dir, workspaceDir: workspace });
    const res2 = linkProject({ dir, workspaceDir: workspace });
    expect(res2.alreadyLinked).toBe(true);
    expect(readViews()).toEqual(['me/app']);
  });

  it('a dir already inside the workspace is pinned without a junction', () => {
    const dir = makeGitRepo(path.join(workspace, 'inside'), 'https://github.com/me/inside.git');
    const res = linkProject({ dir, workspaceDir: workspace });
    expect(res.alreadyInWorkspace).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'me', 'inside'))).toBe(false); // no junction
    expect(readViews()).toEqual(['me/inside']);
  });

  it('refuses to clobber a REAL directory sitting at the junction path', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    fs.mkdirSync(path.join(workspace, 'me', 'app'), { recursive: true }); // a real clone
    const res = linkProject({ dir, workspaceDir: workspace });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('refusing to overwrite');
  });
});

describe('unlinkProject', () => {
  it('removes the junction + the repo-views entry', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    linkProject({ dir, workspaceDir: workspace });

    const res = unlinkProject({ dir, workspaceDir: workspace });
    expect(res.ok).toBe(true);
    expect(res.removedJunction).toBe(true);
    expect(res.removedView).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'me', 'app'))).toBe(false);
    expect(readViews()).toEqual([]);
  });

  it('reports not-linked when nothing matches', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    const res = unlinkProject({ dir, workspaceDir: workspace });
    expect(res.ok).toBe(false);
  });

  it('never deletes a REAL directory at the junction path', () => {
    const dir = makeGitRepo(path.join(tmp, 'external', 'app'), 'https://github.com/me/app.git');
    const realAtPath = path.join(workspace, 'me', 'app');
    fs.mkdirSync(realAtPath, { recursive: true });
    fs.writeFileSync(path.join(realAtPath, 'keep.txt'), 'data');

    const res = unlinkProject({ dir, workspaceDir: workspace });
    expect(res.removedJunction).toBe(false);
    expect(fs.existsSync(path.join(realAtPath, 'keep.txt'))).toBe(true); // untouched
  });

  it('SAFETY: refuses unlink/rmdir if the path is not a symlink at removal time (TOCTOU defense)', () => {
    // The path passes the call-site isSymbolicLink() guard but, at the moment
    // removeLink re-asserts, it is NOT a link (a real dir swapped in). It must
    // remove NOTHING. We inject an fsi whose lstat flips symlink→dir between the
    // two checks; every destructive op is recorded and must stay at zero.
    let lstatCalls = 0;
    let unlinks = 0;
    let rmdirs = 0;
    const fsi: ProjectLinkFs = {
      existsSync: () => true,
      readFileSync: (p) =>
        p.endsWith('config')
          ? '[remote "origin"]\n\turl = https://github.com/me/app.git\n'
          : '["me/app"]',
      writeFileSync: () => {},
      mkdirSync: () => {},
      symlinkSync: () => {},
      // 1st lstat (call-site guard) → symlink; 2nd (removeLink assert) → real dir.
      lstatSync: () => {
        lstatCalls += 1;
        const link = lstatCalls < 2;
        return { isSymbolicLink: () => link, isDirectory: () => !link };
      },
      realpathSync: () => '/same/target', // pointsAt() → true
      unlinkSync: () => {
        unlinks += 1;
      },
      rmdirSync: () => {
        rmdirs += 1;
      },
      readdirSync: () => [],
    };

    const res = unlinkProject({ dir: '/some/app', workspaceDir: '/ws', fsi });
    expect(unlinks).toBe(0); // nothing unlinked
    expect(rmdirs).toBe(0); // nothing rmdir'd — the real dir is safe
    expect(res.removedJunction).toBe(false);
  });
});

describe('resolveWorkspaceDir', () => {
  it('honors WORKSPACE_DIR from env', () => {
    expect(resolveWorkspaceDir({ WORKSPACE_DIR: workspace } as NodeJS.ProcessEnv, home)).toBe(
      path.resolve(workspace)
    );
  });

  it('expands a leading ~/ against home', () => {
    expect(resolveWorkspaceDir({ WORKSPACE_DIR: '~/ws' } as NodeJS.ProcessEnv, home)).toBe(
      path.resolve(path.join(home, 'ws'))
    );
  });
});
