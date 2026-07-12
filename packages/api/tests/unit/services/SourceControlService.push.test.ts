/**
 * SourceControlService.push / pull (US-016, portable.dev#17)
 *
 * Two layers:
 *  1. Stub the injectable `gitRunner` seam to assert the exact git argv — the
 *     one-shot inline credential-helper `-c` pair prepended to push/pull — AND
 *     that the GitHub token is passed via the `GITHUB_TOKEN` env (with the
 *     non-interactive guard) — never embedded in the argv/URL. Also asserts the
 *     refreshed ahead/behind comes from the follow-up status read.
 *  2. A route-level test against the isolated factory proving the AC's auth
 *     boundary: a push with no GitHub connection → a deterministic 401, and the
 *     service is never invoked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import type { Application } from 'express';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';

import { createSourceControlRoutes } from '../../../src/routes/subroutes/source-control.routes.js';
import {
  InvalidBranchError,
  MergeConflictsError,
  SourceControlService,
} from '../../../src/services/SourceControlService.js';
import type { AuthService } from '../../../src/services/AuthService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

// A minimal `git status --porcelain=v2 --branch` body: branch + ahead/behind.
const STATUS_OUTPUT = '# branch.head feature/x\n# branch.ab +2 -1\n';

// The per-command credential-helper prefix push/pull must lead with: the EMPTY
// first helper clears ambient helpers (osxkeychain, gh, …) so Portable's
// device-flow token is authoritative; the second reads $GITHUB_TOKEN from env.
const CRED_HELPER_ARGS = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f',
];

describe('SourceControlService.push / pull — argv + token env', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('push runs `git push` behind the inline credential helper with the token in GITHUB_TOKEN env (not the argv) and returns updated ahead/behind', async () => {
    const calls: { args: string[]; opts: any }[] = [];
    (service as any).gitRunner = (args: string[], opts: any) => {
      calls.push({ args, opts });
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    const res = await service.push('/repo', {}, 'ghp_secret');

    const push = calls.find((c) => c.args.includes('push'))!;
    expect(push.args).toEqual([...CRED_HELPER_ARGS, 'push']);
    // Token rides the env only — never the argv.
    expect(push.args.join(' ')).not.toContain('ghp_secret');
    expect(push.opts.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(push.opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(push.opts.cwd).toBe('/repo');

    // ahead/behind come from the follow-up status read.
    expect(res).toEqual({ pushed: true, branch: 'feature/x', ahead: 2, behind: 1 });
  });

  it('push rejects an option-injection branch name before running git', async () => {
    let ran = false;
    (service as any).gitRunner = () => {
      ran = true;
      return Promise.resolve('');
    };

    // A `-`-leading value would be parsed as a git option (`git push origin --foo`);
    // the ref-name guard rejects it up front so no push is attempted.
    await expect(
      service.push('/repo', { branch: '--upload-pack=evil' }, 'tok')
    ).rejects.toBeInstanceOf(InvalidBranchError);
    expect(ran).toBe(false);
  });

  it('push with setUpstream + branch runs `git push --set-upstream origin <branch>`', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    await service.push('/repo', { branch: 'feature/x', setUpstream: true }, 'tok');

    expect(calls.find((a) => a.includes('push'))).toEqual([
      ...CRED_HELPER_ARGS,
      'push',
      '--set-upstream',
      'origin',
      'feature/x',
    ]);
  });

  it('pull runs `git pull` behind the inline credential helper with the token in GITHUB_TOKEN env and returns updated ahead/behind', async () => {
    const calls: { args: string[]; opts: any }[] = [];
    (service as any).gitRunner = (args: string[], opts: any) => {
      calls.push({ args, opts });
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    const res = await service.pull('/repo', 'ghp_secret');

    const pull = calls.find((c) => c.args.includes('pull'))!;
    expect(pull.args).toEqual([...CRED_HELPER_ARGS, 'pull']);
    expect(pull.args.join(' ')).not.toContain('ghp_secret');
    expect(pull.opts.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(pull.opts.env.GIT_TERMINAL_PROMPT).toBe('0');

    expect(res).toEqual({ pulled: true, branch: 'feature/x', ahead: 2, behind: 1 });
  });
});

// A porcelain v2 status with an unmerged (conflicted) entry — the state a
// conflicting pull leaves the working tree in.
const CONFLICT_STATUS_OUTPUT =
  '# branch.head feature/x\n# branch.ab +2 -1\n' +
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt\n';

describe('SourceControlService.push / pull — worktree scope + conflict handling', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('push scoped to a nested worktree runs every git call in the worktree cwd', async () => {
    const calls: { args: string[]; opts: any }[] = [];
    (service as any).gitRunner = (args: string[], opts: any) => {
      calls.push({ args, opts });
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    const res = await service.push('/repo', { worktree: '/repo/.worktrees/17' }, 'tok');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.opts.cwd).toBe('/repo/.worktrees/17');
    }
    expect(res.pushed).toBe(true);
  });

  it('push refuses (MergeConflictsError, no git push) while the tree has unresolved conflicts', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      return Promise.resolve(args[0] === 'status' ? CONFLICT_STATUS_OUTPUT : '');
    };

    await expect(service.push('/repo', {}, 'tok')).rejects.toBeInstanceOf(MergeConflictsError);
    expect(calls.some((a) => a.includes('push'))).toBe(false);
  });

  it('push with no upstream retries as `git push --set-upstream origin <current branch>`', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      if (args.includes('@{upstream}')) {
        return Promise.reject(new Error('fatal: no upstream configured for branch'));
      }
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    const res = await service.push('/repo', {}, 'tok');

    expect(calls.find((a) => a.includes('push'))).toEqual([
      ...CRED_HELPER_ARGS,
      'push',
      '--set-upstream',
      'origin',
      'feature/x',
    ]);
    expect(res.pushed).toBe(true);
  });

  it('pull scoped to a nested worktree runs every git call in the worktree cwd', async () => {
    const calls: { args: string[]; opts: any }[] = [];
    (service as any).gitRunner = (args: string[], opts: any) => {
      calls.push({ args, opts });
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    const res = await service.pull('/repo', 'tok', { worktree: '/repo/.worktrees/17' });

    for (const call of calls) {
      expect(call.opts.cwd).toBe('/repo/.worktrees/17');
    }
    expect(res.pulled).toBe(true);
  });

  it('a conflicting pull resolves { pulled: false, conflicts: true } instead of throwing', async () => {
    (service as any).gitRunner = (args: string[]) => {
      if (args.includes('pull')) {
        return Promise.reject(new Error('CONFLICT (content): Merge conflict in conflicted.txt'));
      }
      return Promise.resolve(args[0] === 'status' ? CONFLICT_STATUS_OUTPUT : '');
    };

    const res = await service.pull('/repo', 'tok');

    expect(res).toEqual({
      pulled: false,
      conflicts: true,
      branch: 'feature/x',
      ahead: 2,
      behind: 1,
    });
  });

  it('a pull failure with a CLEAN tree rethrows (a genuine error is not a conflict)', async () => {
    (service as any).gitRunner = (args: string[]) => {
      if (args.includes('pull')) {
        return Promise.reject(new Error('fatal: unable to access remote'));
      }
      return Promise.resolve(args[0] === 'status' ? STATUS_OUTPUT : '');
    };

    await expect(service.pull('/repo', 'tok')).rejects.toThrow('unable to access remote');
  });
});

describe('Source Control push route — GitHub connection boundary', () => {
  const userEmail = 'pushpull-17@example.com';
  const owner = 'octocat';
  const repo = 'hello-world';
  let repoPath: string;
  let app: Application;
  let pushCalled: boolean;

  /** Build a minimal app: json body + a fake authenticated session + the factory. */
  function buildApp(authService: AuthService): Application {
    const service = makeService();
    pushCalled = false;
    (service as any).push = () => {
      pushCalled = true;
      return Promise.resolve({ pushed: true });
    };

    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).session = { userEmail };
      next();
    });
    a.use('/api/source-control', createSourceControlRoutes(service, authService, undefined));
    return a;
  }

  beforeEach(() => {
    // resolveRepoPath only checks the repo dir exists — create it under the
    // (test-isolated) workspace so the handler reaches the GitHub-token
    // resolution. With no gitLocalService the resolver falls back to the
    // canonical <workspace>/<owner>/<repo> layout.
    repoPath = path.join(getUserWorkspaceDir(userEmail), owner, repo);
    fs.mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.join(getUserWorkspaceDir(userEmail), owner), { recursive: true, force: true });
  });

  it('returns 401 (and never runs the push) when there is no GitHub connection', async () => {
    const authService = {
      getGitHubToken: () => {
        const error = new Error('INSUFFICIENT_GITHUB_PERMISSIONS') as Error & { code?: string };
        error.code = 'INSUFFICIENT_GITHUB_PERMISSIONS';
        return Promise.reject(error);
      },
    } as unknown as AuthService;
    app = buildApp(authService);

    const res = await request(app).post(`/api/source-control/${owner}/${repo}/push`).send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('GitHub connection required. Please connect your GitHub account.');
    expect(pushCalled).toBe(false);
  });

  it('maps a MergeConflictsError to a deterministic 409', async () => {
    const authService = {
      getGitHubToken: () => Promise.resolve('tok'),
    } as unknown as AuthService;

    const service = makeService();
    (service as any).push = () => Promise.reject(new MergeConflictsError());

    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).session = { userEmail };
      next();
    });
    a.use('/api/source-control', createSourceControlRoutes(service, authService, undefined));

    const res = await request(a).post(`/api/source-control/${owner}/${repo}/push`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Resolve merge conflicts before pushing');
  });
});
