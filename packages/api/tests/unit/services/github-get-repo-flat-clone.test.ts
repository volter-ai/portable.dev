/**
 * Bug 2 — the repo Overview's `GET /api/repos/:owner/:repo` must report a FLAT clone
 * (`<workspace>/<dir>`, dir name ≠ `owner/repo`) as `isLocal: true`, exactly like the repos
 * LIST already does. `handleGetRepo` previously checked the HARDCODED canonical two-level
 * path (`<workspace>/<owner>/<repo>`) and so reported a flat clone as "not cloned" — while
 * the Home/Repos list (which resolves the real on-disk path) showed it cloned. It now uses
 * `resolveRepoLocalPath` (the `gitLocalService.resolveLocalRepoPath` seam, flat-aware).
 *
 * Database-free unit test: `getOctokitForUser` is stubbed (no GitHub call), `repoViewTracker`
 * is null (handleGetRepo skips the view-tracker / cache-refresh block), and the only filesystem
 * touched is a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { GitHubApiService } from '../../../src/services/GitHubApiService';
import { ReposCacheService } from '../../../src/services/ReposCacheService';

import type { Request, Response } from 'express';

function makeService(repoGet?: () => Promise<{ data: unknown }>): GitHubApiService {
  const connections = new EventEmitter() as any; // constructor only registers .on listeners
  const svc = new GitHubApiService(
    new ReposCacheService(),
    connections,
    null, // repoViewTracker — handleGetRepo skips the view-tracker/cache-refresh block
    null // chatService
  );
  // Return fixture repo data instead of hitting GitHub (override `repoGet` per test).
  (svc as any).getOctokitForUser = async () => ({
    repos: {
      get:
        repoGet ??
        (async () => ({
          data: { name: 'clock-app', full_name: 'me/clock-app', default_branch: 'main' },
        })),
    },
  });
  return svc;
}

function makeRes(): Response & { body?: any } {
  const res: any = {};
  res.status = () => res;
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  res.send = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

function makeReq(
  gitLocalService: unknown,
  params: { owner: string; repo: string } = { owner: 'me', repo: 'clock-app' }
): Request {
  return {
    params,
    session: { userEmail: 'u@e.com' },
    query: { skipGitOperations: 'true' },
    gitLocalService,
  } as unknown as Request;
}

/** A GitHub 404 (the shape octokit throws for an unknown repo). */
function notFound(): never {
  const err: any = new Error('Not Found');
  err.status = 404;
  throw err;
}

let root: string;
let flatRepo: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rev9-getrepo-'));
  // a FLAT clone: the dir name ('checkout') is NOT 'me/clock-app'
  flatRepo = path.join(root, 'checkout');
  await fs.mkdir(path.join(flatRepo, '.git'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('handleGetRepo — flat-clone isLocal (Bug 2)', () => {
  it('reports isLocal:true for a FLAT clone via resolveLocalRepoPath', async () => {
    const svc = makeService();
    const res = makeRes();
    // The flat-aware resolver returns the REAL on-disk path (dir name irrelevant).
    await svc.handleGetRepo(makeReq({ resolveLocalRepoPath: async () => flatRepo }), res);

    expect(res.body.isLocal).toBe(true);
    expect(res.body.localPath).toBe(flatRepo);
  });

  it('reports isLocal:false when the resolved path has no clone', async () => {
    const svc = makeService();
    const res = makeRes();
    const missing = path.join(root, 'does-not-exist');
    await svc.handleGetRepo(makeReq({ resolveLocalRepoPath: async () => missing }), res);

    expect(res.body.isLocal).toBe(false);
    expect(res.body.localPath).toBeUndefined();
  });
});

describe('handleGetRepo — local-only repo (no GitHub record)', () => {
  it("serves a local stub for a `portable link`'d `local/` repo WITHOUT calling GitHub", async () => {
    let githubCalled = false;
    const svc = makeService(async () => {
      githubCalled = true;
      return notFound();
    });
    const res = makeRes();
    // The `local/` owner can never resolve on github.com — the guaranteed-404 must be skipped.
    await svc.handleGetRepo(
      makeReq({ resolveLocalRepoPath: async () => flatRepo }, { owner: 'local', repo: 'my-proj' }),
      res
    );

    expect(githubCalled).toBe(false);
    expect(res.body.isLocal).toBe(true);
    expect(res.body.localPath).toBe(flatRepo);
    expect(res.body.full_name).toBe('local/my-proj');
    expect(res.body.name).toBe('my-proj');
    expect(res.body.error).toBeUndefined();
  });

  it('falls back to a local stub when GitHub 404s but the repo IS cloned (deleted remote)', async () => {
    const svc = makeService(notFound);
    const res = makeRes();
    await svc.handleGetRepo(makeReq({ resolveLocalRepoPath: async () => flatRepo }), res);

    expect(res.body.isLocal).toBe(true);
    expect(res.body.localPath).toBe(flatRepo);
    expect(res.body.full_name).toBe('me/clock-app');
    expect(res.body.error).toBeUndefined();
  });

  it('still errors when GitHub 404s AND the repo is not cloned locally', async () => {
    const svc = makeService(notFound);
    const res = makeRes();
    const missing = path.join(root, 'does-not-exist');
    await svc.handleGetRepo(makeReq({ resolveLocalRepoPath: async () => missing }), res);

    expect(res.body.isLocal).toBeUndefined();
    expect(res.body.error).toBeDefined();
  });
});
