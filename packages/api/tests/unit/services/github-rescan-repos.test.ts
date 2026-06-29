/**
 * POST /api/repos/rescan — `GitHubApiService.handleRescanRepos` drops the
 * caller's in-memory repo caches so a freshly-linked/unlinked local project
 * (junction + repo-views.json written by `portable link`/`unlink`) shows up on
 * the NEXT repos fetch without restarting `portable`. It invalidates the
 * `ReposCacheService` repos-list cache and clears the `RepoViewTrackerService`
 * viewed-repos in-memory cache, both scoped to the calling user.
 *
 * Database-free unit test. `RepoViewTrackerService` reads/writes its store under
 * the module-level `WORKSPACE_DIR` (a load-time constant we can't redirect at
 * runtime), so these tests exercise the IN-MEMORY cache semantics only —
 * `getViewedRepos` warms the cache (read-only) and `clearCache` drops it; no test
 * writes to the workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';

import { GitHubApiService } from '../../../src/services/GitHubApiService';
import { ReposCacheService } from '../../../src/services/ReposCacheService';
import { RepoViewTrackerService } from '../../../src/services/RepoViewTrackerService';

import type { Request, Response } from 'express';

const USER = 'rescan-user@e.com';

function makeRes(): Response & { statusCode?: number; body?: any } {
  const res: any = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

function makeReq(userEmail: string | undefined): Request {
  return { session: { userEmail } } as unknown as Request;
}

let reposCache: ReposCacheService;
let viewTracker: RepoViewTrackerService;
let svc: GitHubApiService;

beforeEach(async () => {
  reposCache = new ReposCacheService();
  viewTracker = new RepoViewTrackerService();
  await viewTracker.initialize();
  const connections = new EventEmitter() as any; // ctor only registers .on listeners
  svc = new GitHubApiService(reposCache, connections, viewTracker, null);
});

afterEach(() => {
  // Drop any in-memory cache entry we warmed (no disk artifacts are created).
  viewTracker.clearCache(USER);
});

describe('handleRescanRepos', () => {
  it('invalidates the repos-list cache and clears the view cache for the user', async () => {
    // Seed a repos-list cache entry for the user.
    reposCache.set({ userId: USER, page: 1 } as any, { repos: ['stale'] });
    // Warm the view-tracker in-memory cache (read-only) so a clear is observable.
    await viewTracker.getViewedRepos(USER);

    const res = makeRes();
    await svc.handleRescanRepos(makeReq(USER), res);

    expect(res.body.success).toBe(true);
    expect(res.body.invalidatedRepoCacheEntries).toBe(1);
    expect(res.body.clearedRepoViewCache).toBe(true);
    // The cache entry is gone.
    expect(reposCache.get({ userId: USER, page: 1 } as any)).toBeNull();
  });

  it('reports zeroes when nothing was cached for the user', async () => {
    const res = makeRes();
    await svc.handleRescanRepos(makeReq(USER), res);

    expect(res.body.success).toBe(true);
    expect(res.body.invalidatedRepoCacheEntries).toBe(0);
    expect(res.body.clearedRepoViewCache).toBe(false);
  });

  it('401s when unauthenticated', async () => {
    const res = makeRes();
    await svc.handleRescanRepos(makeReq(undefined), res);
    expect(res.statusCode).toBe(401);
  });
});

describe('RepoViewTrackerService.clearCache', () => {
  it('drops the in-memory cache entry (forcing a fresh disk read next time)', async () => {
    // Warm the cache (read-only populate from disk).
    await viewTracker.getViewedRepos(USER);
    // Now a cache entry exists → clearing it reports true.
    expect(viewTracker.clearCache(USER)).toBe(true);
    // A second clear is a no-op (nothing cached) → false.
    expect(viewTracker.clearCache(USER)).toBe(false);
    // A user that was never loaded has no entry → false.
    expect(viewTracker.clearCache('never-loaded@e.com')).toBe(false);
  });
});
