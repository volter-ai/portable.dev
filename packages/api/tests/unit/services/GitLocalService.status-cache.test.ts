/**
 * GitLocalService — git-status cache + in-flight dedup
 *
 * Regression tests: the chat UI fired GET /git-status on every
 * streamed block, and the route spawned 3 git subprocesses per request with no
 * caching or dedup. When the setup agent streamed hundreds of blocks, it flooded
 * the backend until it crashed.
 *
 * The fix adds a short-TTL cache + an in-flight guard to getCompleteRepoStatus
 * (mirroring the clone-concurrency guard). These tests assert that
 * contract:
 *   - concurrent status requests for the SAME repo collapse into ONE compute,
 *   - repeated requests within the TTL hit the cache,
 *   - stale entries (past TTL) recompute,
 *   - DIFFERENT repos compute independently,
 *   - a FAILED compute is not cached and clears the in-flight lock,
 *   - { bypassCache: true } forces a recompute and refreshes the cache,
 *   - fetchAndGetCompleteRepoStatus dedups, ALWAYS runs a fresh fetch+compute
 *     (its "accurate ahead/behind" contract), and write-throughs the cache.
 *
 * Strategy: spy on the private workers (computeCompleteRepoStatus, performFetch)
 * so the guard/cache logic is exercised without spawning real git or globally
 * mocking child_process (which leaks across test files in Bun).
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import os from 'os';
import path from 'path';

// Isolated temp workspace so we never touch the real ~/claude-workspace
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `vgit-status-cache-${process.pid}`);

import { GitLocalService } from '../../../src/services/GitLocalService.js';

interface StatusShape {
  clean: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  insertions: number;
  deletions: number;
}

function makeStatus(branch: string): StatusShape {
  return {
    clean: true,
    branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    insertions: 0,
    deletions: 0,
  };
}

/**
 * Stub computeCompleteRepoStatus with a controllable async worker so concurrent
 * callers overlap. Each call resolves to a DISTINCT object (tagged with the call
 * number) so we can assert identity (dedup) and write-through.
 */
function stubCompute(service: GitLocalService, delayMs = 50): { count: () => number } {
  let calls = 0;
  spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation((repoPath: string) => {
    calls++;
    const tag = `${repoPath}#${calls}`;
    return new Promise((resolve) => setTimeout(() => resolve(makeStatus(tag)), delayMs));
  });
  return { count: () => calls };
}

describe('GitLocalService git-status cache + dedup', () => {
  let service: GitLocalService;

  beforeEach(() => {
    service = new GitLocalService();
  });

  it('computes only once for concurrent requests on the same repo', async () => {
    const compute = stubCompute(service);

    const results = await Promise.all([
      service.getCompleteRepoStatus('/x'),
      service.getCompleteRepoStatus('/x'),
      service.getCompleteRepoStatus('/x'),
    ]);

    expect(compute.count()).toBe(1);
    // All concurrent callers resolve to the SAME computed object (dedup).
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it('serves repeated requests within the TTL from cache (no recompute)', async () => {
    const compute = stubCompute(service);

    const first = await service.getCompleteRepoStatus('/x');
    const second = await service.getCompleteRepoStatus('/x');

    expect(compute.count()).toBe(1);
    // Cache hit returns the identical cached object.
    expect(second).toBe(first);
  });

  it('recomputes once a cache entry is past its TTL', async () => {
    const compute = stubCompute(service);

    await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(1);

    // Age the cached entry past the TTL deterministically (no sleep).
    const cache = (service as any).statusCache as Map<string, { data: unknown; timestamp: number }>;
    const entry = cache.get('/x')!;
    entry.timestamp = entry.timestamp - 10 * 60 * 1000; // 10 minutes in the past

    await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(2);
  });

  it('computes independently for different repo paths', async () => {
    const compute = stubCompute(service);

    await Promise.all([service.getCompleteRepoStatus('/a'), service.getCompleteRepoStatus('/b')]);

    expect(compute.count()).toBe(2);
  });

  it('does not cache a failed compute and clears the in-flight lock for retry', async () => {
    let calls = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      calls++;
      return Promise.reject(new Error('git status failed (simulated)'));
    });

    await expect(service.getCompleteRepoStatus('/x')).rejects.toThrow('git status failed');
    expect(calls).toBe(1);

    // A retry must run its OWN compute, not re-await the failed promise or hit a
    // poisoned cache entry.
    await expect(service.getCompleteRepoStatus('/x')).rejects.toThrow('git status failed');
    expect(calls).toBe(2);
  });

  it('bypassCache forces a recompute and refreshes the cache', async () => {
    const compute = stubCompute(service);

    const first = await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(1);

    // Even with a fresh cache entry, bypassCache recomputes.
    const bypassed = await service.getCompleteRepoStatus('/x', { bypassCache: true });
    expect(compute.count()).toBe(2);
    expect(bypassed).not.toBe(first);

    // The recompute is written through: a following plain call hits the cache.
    const cached = await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(2);
    expect(cached).toBe(bypassed);
  });

  it('fetchAndGetCompleteRepoStatus dedups and write-throughs the cache', async () => {
    const compute = stubCompute(service);
    let fetches = 0;
    spyOn(service as any, 'performFetch').mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            fetches++;
            resolve();
          }, 10)
        )
    );

    // Concurrent fetch-variant calls collapse into one fetch + one compute.
    const results = await Promise.all([
      service.fetchAndGetCompleteRepoStatus('/x'),
      service.fetchAndGetCompleteRepoStatus('/x'),
    ]);
    expect(fetches).toBe(1);
    expect(compute.count()).toBe(1);
    expect(results[0]).toBe(results[1]);

    // Write-through: an immediately-following plain call hits the cache.
    const plain = await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(1);
    expect(plain).toBe(results[0]);
  });

  it('fetch-variant recomputes even when a fresh plain cache entry exists', async () => {
    const compute = stubCompute(service);
    let fetches = 0;
    spyOn(service as any, 'performFetch').mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            fetches++;
            resolve();
          }, 10)
        )
    );

    // Warm the plain cache.
    await service.getCompleteRepoStatus('/x');
    expect(compute.count()).toBe(1);

    // The fetch variant must NOT short-circuit on the fresh cache — it promises
    // an accurate ahead/behind via a real `git fetch`.
    await service.fetchAndGetCompleteRepoStatus('/x');
    expect(fetches).toBe(1);
    expect(compute.count()).toBe(2);
  });
});
