/**
 * GitLocalService — clone concurrency guard
 *
 * Regression tests: clicking "Clone to Local" (plus the
 * auto-clone path and rapid re-clicks) fired many parallel `git clone`
 * operations against the same destination because the check ("is it
 * cloned?") and the act ("git clone") were not guarded against concurrency.
 * The parallel clones piled up until the server crashed.
 *
 * These tests assert the public contract of the in-flight guard:
 *   - concurrent clone requests for the SAME repo collapse into ONE clone,
 *   - clones for DIFFERENT repos still run independently,
 *   - the in-flight lock is released after completion (no stale lock).
 *
 * Strategy: spy on the private `performClone` (the actual clone work) so the
 * guard logic in `cloneRepository` is exercised without spawning real git or
 * globally mocking `child_process` (which leaks across test files in Bun).
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import os from 'os';
import path from 'path';

// Isolated temp workspace so we never touch the real ~/claude-workspace
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `vgit-clone-race-${process.pid}`);

import { GitLocalService } from '../../../src/services/GitLocalService.js';

/**
 * Replaces performClone with a controllable stub that resolves after a tick,
 * so concurrent callers overlap. Returns the call counter.
 */
function stubClone(service: GitLocalService, delayMs = 50): { count: () => number } {
  let calls = 0;
  spyOn(service as any, 'performClone').mockImplementation(
    (_owner: string, _repo: string, _userId: string, repoPath: string) => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve(repoPath), delayMs));
    }
  );
  return { count: () => calls };
}

describe('GitLocalService clone concurrency guard', () => {
  let service: GitLocalService;

  beforeEach(() => {
    service = new GitLocalService();
  });

  it('runs the clone only once for concurrent requests on the same repo', async () => {
    const clone = stubClone(service);
    const userId = 'race@test.com';

    const results = await Promise.all([
      service.cloneRepository('octo', 'repo-a', userId, 'token'),
      service.cloneRepository('octo', 'repo-a', userId, 'token'),
      service.cloneRepository('octo', 'repo-a', userId, 'token'),
    ]);

    // Only ONE underlying clone should have run for the three concurrent calls.
    expect(clone.count()).toBe(1);

    // All callers resolve to the same destination path.
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[0].endsWith(path.join('octo', 'repo-a'))).toBe(true);
  });

  it('still clones different repos in parallel (guard is per-repo)', async () => {
    const clone = stubClone(service);
    const userId = 'race@test.com';

    await Promise.all([
      service.cloneRepository('octo', 'repo-b', userId, 'token'),
      service.cloneRepository('octo', 'repo-c', userId, 'token'),
    ]);

    expect(clone.count()).toBe(2);
  });

  it('releases the in-flight lock after completion so later clones run again', async () => {
    const clone = stubClone(service);
    const userId = 'race@test.com';

    await service.cloneRepository('octo', 'repo-d', userId, 'token');
    expect(clone.count()).toBe(1);

    // The lock must be cleared in `finally`; a subsequent call should run a
    // fresh clone rather than resolving against a stale in-flight promise.
    await service.cloneRepository('octo', 'repo-d', userId, 'token');
    expect(clone.count()).toBe(2);
  });

  it('releases the in-flight lock when the clone FAILS so a retry can run', async () => {
    // The wedge scenario: a clone that never resolves/rejects (e.g. git
    // blocking on a credential prompt) hands its pending promise to every
    // subsequent caller via the guard. The fix forces clones to fail fast
    // (GIT_TERMINAL_PROMPT=0 + timeout) — so the contract we must guarantee is
    // that a REJECTED clone still clears the lock, letting a retry start fresh
    // instead of awaiting a dead promise forever.
    let calls = 0;
    spyOn(service as any, 'performClone').mockImplementation(() => {
      calls++;
      return Promise.reject(new Error('clone failed (simulated auth failure)'));
    });
    const userId = 'race@test.com';

    await expect(service.cloneRepository('octo', 'repo-e', userId, 'token')).rejects.toThrow(
      'clone failed'
    );
    expect(calls).toBe(1);

    // A second attempt must run its OWN clone, not re-await the failed one.
    await expect(service.cloneRepository('octo', 'repo-e', userId, 'token')).rejects.toThrow(
      'clone failed'
    );
    expect(calls).toBe(2);
  });
});
