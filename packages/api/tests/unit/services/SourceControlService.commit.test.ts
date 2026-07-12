/**
 * SourceControlService.commit (US-015, portable.dev#17)
 *
 * Two layers:
 *  1. Stub the injectable `gitRunner` seam (over a REAL temp `.git` so the
 *     `.git`-exists guard passes) to assert the PER-COMMAND author identity argv
 *     (`git -c user.name=<login> -c user.email=<login>@users.noreply.github.com
 *     commit -m <message>`), the resolved login, and the empty-message /
 *     nothing-staged / non-git-repo guards — deterministic, no real commit.
 *  2. A REAL-git integration test against a temp repo that proves the AC: the
 *     commit is authored with the RESOLVED GitHub login (`git log -1 --format=%an`
 *     === the connection's username, NOT a Clerk display name), and falls back to
 *     the JWT username when no GitHub connection resolves.
 *
 * Identity resolution goes through the shared `resolveGitAuthorIdentity` helper,
 * which reads the same ConnectionsService seams the stubs below fake
 * (getActiveGitHubConnection + getConnectionAccountInfo).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  SourceControlService,
  EmptyCommitMessageError,
  NothingStagedError,
  NotAGitRepoError,
} from '../../../src/services/SourceControlService.js';
import type { AuthService } from '../../../src/services/AuthService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';

/** A ConnectionsService stub that resolves the GitHub login to `username`. */
function connectionsWithLogin(username: string): ConnectionsService {
  return {
    getActiveGitHubConnection: async () => ({
      type: 'oauth',
      connection: { connectionId: 'github_1' },
    }),
    getConnectionAccountInfo: async () => ({ service: 'github', username }),
  } as unknown as ConnectionsService;
}

/** A ConnectionsService stub with NO active connection (forces the fallback). */
function connectionsWithoutGitHub(): ConnectionsService {
  return {
    getActiveGitHubConnection: async () => ({ type: 'none' }),
    getConnectionAccountInfo: async () => null,
  } as unknown as ConnectionsService;
}

const STAGED_PORCELAIN = [
  '# branch.head main',
  '# branch.ab +0 -0',
  '1 M. N... 100644 100644 100644 1111111 2222222 file.ts',
  '',
].join('\n');

const EMPTY_PORCELAIN = ['# branch.head main', '# branch.ab +0 -0', ''].join('\n');

describe('SourceControlService.commit — identity argv + guards (stubbed git)', () => {
  let repoDir: string;
  let service: SourceControlService;

  beforeEach(() => {
    // A real temp dir with a `.git` so the .git-exists guard passes; git itself
    // is stubbed out via gitRunner, so no real commit happens.
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-commit-stub-'));
    fs.mkdirSync(path.join(repoDir, '.git'));
    service = new SourceControlService(
      connectionsWithLogin('octocat'),
      {} as unknown as AuthService
    );
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('runs the per-command author identity and returns the new sha', async () => {
    const captured: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      captured.push(args);
      if (args[0] === 'status') return Promise.resolve(STAGED_PORCELAIN);
      if (args[0] === 'rev-parse') return Promise.resolve('abc1234def\n');
      return Promise.resolve('');
    };

    const res = await service.commit(repoDir, 'feat: do a thing', {
      userId: 'me@example.com',
      authToken: 'jwt',
      jwtUsername: 'Display Name',
    });

    const commitArgs = captured.find((a) => a.includes('commit'));
    expect(commitArgs).toEqual([
      '-c',
      'user.name=octocat',
      '-c',
      'user.email=octocat@users.noreply.github.com',
      'commit',
      '-m',
      'feat: do a thing',
    ]);
    expect(res).toEqual({ sha: 'abc1234def', branch: 'main', author: 'octocat' });
  });

  it('rejects an empty / whitespace-only message with EmptyCommitMessageError (no git run)', async () => {
    let ran = false;
    (service as any).gitRunner = () => {
      ran = true;
      return Promise.resolve('');
    };

    await expect(
      service.commit(repoDir, '   ', { userId: 'me@example.com' })
    ).rejects.toBeInstanceOf(EmptyCommitMessageError);
    expect(ran).toBe(false);
  });

  it('rejects when nothing is staged with NothingStagedError (no commit run)', async () => {
    const captured: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      captured.push(args);
      if (args[0] === 'status') return Promise.resolve(EMPTY_PORCELAIN);
      return Promise.resolve('');
    };

    await expect(
      service.commit(repoDir, 'feat: nope', { userId: 'me@example.com' })
    ).rejects.toBeInstanceOf(NothingStagedError);
    expect(captured.some((a) => a.includes('commit'))).toBe(false);
  });

  it('rejects a non-git directory with NotAGitRepoError', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-commit-nogit-'));
    try {
      await expect(
        service.commit(plainDir, 'feat: x', { userId: 'me@example.com' })
      ).rejects.toBeInstanceOf(NotAGitRepoError);
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

describe('SourceControlService.commit — real git author', () => {
  let repoDir: string;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-commit-'));
    git('init', '-q');
    // A deliberately DIFFERENT local identity so we can prove the commit is
    // authored with the resolved GitHub login, not this config.
    git('config', 'user.email', 'local@example.com');
    git('config', 'user.name', 'Local Config Name');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'original\n');
    git('add', 'file.ts');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('authors the commit with the resolved GitHub login (not the Clerk display name)', async () => {
    const service = new SourceControlService(
      connectionsWithLogin('octocat'),
      {} as unknown as AuthService
    );

    const res = await service.commit(repoDir, 'feat: initial', {
      userId: 'me@example.com',
      authToken: 'jwt',
      jwtUsername: 'Display Name',
    });

    const authorName = execFileSync('git', ['log', '-1', '--format=%an'], {
      cwd: repoDir,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    const authorEmail = execFileSync('git', ['log', '-1', '--format=%ae'], {
      cwd: repoDir,
      stdio: 'pipe',
    })
      .toString()
      .trim();

    expect(authorName).toBe('octocat');
    expect(authorEmail).toBe('octocat@users.noreply.github.com');
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.author).toBe('octocat');
  });

  it('falls back to the JWT username when no GitHub connection resolves', async () => {
    const service = new SourceControlService(
      connectionsWithoutGitHub(),
      {} as unknown as AuthService
    );

    await service.commit(repoDir, 'feat: fallback', {
      userId: 'me@example.com',
      jwtUsername: 'jwtuser',
    });

    const authorName = execFileSync('git', ['log', '-1', '--format=%an'], {
      cwd: repoDir,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    expect(authorName).toBe('jwtuser');
  });
});
