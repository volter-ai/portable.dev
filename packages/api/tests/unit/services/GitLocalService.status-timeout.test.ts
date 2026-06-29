/**
 * GitLocalService — git-status resource bounds (large-repo freeze fix)
 *
 * The 30s cache + dedup stopped the request FLOOD, but the
 * git subprocesses themselves were still unbounded: on a large repo inside a
 * resource-constrained sandbox, `git status`/`git diff` could run for minutes,
 * starving the event loop and freezing EVERY route. A timed-out compute was
 * never cached, so each retry restarted a full-worktree scan — a CPU-pegging
 * retry storm.
 *
 * These tests assert the bounding contract:
 *   - getDiffStats uses `--shortstat` (one summary line) and sums staged+unstaged,
 *   - getRepositoryStatus runs `--no-optional-locks` with a timeout + output cap,
 *   - a resource-limit failure degrades gracefully (stale cache, else zeros) with
 *     `degraded: true` instead of throwing/hanging,
 *   - a timeout opens a per-repo circuit breaker (cooldown) that serves
 *     stale/degraded WITHOUT spawning git — even for `?fresh=1` (bypassCache),
 *   - a genuine (non-resource) error still rejects and opens no breaker,
 *   - the success path closes the breaker and refreshes the cache,
 *   - a process-wide semaphore caps concurrent status computes,
 *   - getUnpushedCount parses `rev-list --count` and is failure-safe.
 *
 * Strategy: stub the injectable `gitRunner` seam (no real git) for the parsing
 * tests, and spy on the private `computeCompleteRepoStatus`/`performFetch`
 * workers for the breaker/degradation/semaphore tests — mirroring the
 * status-cache suite and avoiding global child_process mocks (which leak across
 * files in Bun).
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import os from 'os';
import path from 'path';

// Isolated temp workspace so we never touch the real ~/claude-workspace
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `vgit-status-timeout-${process.pid}`);

import { GitLocalService, GitResourceLimitError } from '../../../src/services/GitLocalService.js';

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

const TEN_MIN_MS = 10 * 60 * 1000;

describe('GitLocalService git-status resource bounds (large-repo freeze)', () => {
  let service: GitLocalService;

  beforeEach(() => {
    service = new GitLocalService();
  });

  // --- 1. shortstat parsing / summation -------------------------------------

  it('getDiffStats parses --shortstat and sums staged + unstaged', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      // `git diff --cached --shortstat` (staged) vs `git diff --shortstat` (unstaged)
      if (args.includes('--cached')) {
        return Promise.resolve(' 1 file changed, 5 insertions(+), 1 deletion(-)\n');
      }
      return Promise.resolve(' 2 files changed, 10 insertions(+), 3 deletions(-)\n');
    };

    const stats = await service.getDiffStats('/x');

    expect(stats).toEqual({ insertions: 15, deletions: 4 });
    // Both diffs requested via shortstat (never numstat).
    expect(calls.some((a) => a.join(' ') === 'diff --shortstat')).toBe(true);
    expect(calls.some((a) => a.join(' ') === 'diff --cached --shortstat')).toBe(true);
  });

  // --- 2. shortstat edge cases ----------------------------------------------

  it('parseShortstat handles singular / one-sided / binary-only / empty output', () => {
    const p = (s: string) => (service as any).parseShortstat(s);
    expect(p(' 1 file changed, 1 insertion(+), 1 deletion(-)')).toEqual({
      insertions: 1,
      deletions: 1,
    });
    expect(p(' 1 file changed, 5 insertions(+)')).toEqual({ insertions: 5, deletions: 0 });
    expect(p(' 1 file changed, 2 deletions(-)')).toEqual({ insertions: 0, deletions: 2 });
    expect(p(' 1 file changed')).toEqual({ insertions: 0, deletions: 0 }); // binary-only
    expect(p('')).toEqual({ insertions: 0, deletions: 0 }); // no changes
  });

  // --- 3. status runner args + bounds, parsing unchanged ---------------------

  it('getRepositoryStatus runs --no-optional-locks with a timeout + output cap', async () => {
    const calls: Array<{ args: string[]; opts: any }> = [];
    (service as any).gitRunner = (args: string[], opts: any) => {
      calls.push({ args, opts });
      return Promise.resolve(
        '## main...origin/main [ahead 2]\n M file1.ts\n?? file2.ts\nA  file3.ts\n'
      );
    };

    const status = await service.getRepositoryStatus('/x');

    // `--no-optional-locks` is a GLOBAL flag and must come first, before `status`.
    expect(calls[0].args).toEqual(['--no-optional-locks', 'status', '--porcelain', '--branch']);
    expect(calls[0].opts.timeoutMs).toBeGreaterThan(0);
    expect(calls[0].opts.maxOutputBytes).toBeGreaterThan(0);

    // Parsing is unchanged from the execFile implementation.
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(0);
    expect(status.staged).toBe(1); // 'A  file3.ts'
    expect(status.modified).toBe(1); // ' M file1.ts'
    expect(status.untracked).toBe(1); // '?? file2.ts'
  });

  // --- 4. degraded: stale cache served on timeout ---------------------------

  it('serves the stale cache with degraded:true when a recompute times out', async () => {
    let mode: 'ok' | 'timeout' = 'ok';
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      if (mode === 'timeout') {
        return Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'));
      }
      return Promise.resolve(makeStatus('feature'));
    });

    // Warm the cache with a good compute.
    const good = await service.getRepoStatusSafe('/x');
    expect(good.branch).toBe('feature');
    expect(good.degraded).toBeUndefined();

    // Age the cached entry past the TTL so the next call recomputes...
    const entry = (service as any).statusCache.get('/x');
    entry.timestamp -= TEN_MIN_MS;

    // ...and make that recompute time out.
    mode = 'timeout';
    const degraded = await service.getRepoStatusSafe('/x');
    expect(degraded.branch).toBe('feature'); // stale data, not zeros
    expect(degraded.degraded).toBe(true);
  });

  // --- 5. degraded: zeros when nothing cached -------------------------------

  it('returns zeroed branch:unknown + degraded:true on timeout with no cache', async () => {
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() =>
      Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'))
    );

    const res = await service.getRepoStatusSafe('/fresh');
    expect(res.branch).toBe('unknown');
    expect(res.degraded).toBe(true);
    expect(res.clean).toBe(true);
    expect(res.ahead).toBe(0);
    expect(res.insertions).toBe(0);
    expect(res.untracked).toBe(0);
  });

  // --- 6. breaker opens on timeout ------------------------------------------

  it('opens a breaker on timeout: a second call serves degraded WITHOUT recomputing', async () => {
    let calls = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      calls++;
      return Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'));
    });

    const first = await service.getRepoStatusSafe('/x');
    expect(first.degraded).toBe(true);
    expect(calls).toBe(1);

    // Breaker is open — the second call must NOT spawn git again.
    const second = await service.getRepoStatusSafe('/x');
    expect(second.degraded).toBe(true);
    expect(calls).toBe(1);
  });

  // --- 7. breaker closes after cooldown; success refreshes cache ------------

  it('recomputes after the cooldown and a success closes the breaker + refreshes cache', async () => {
    let mode: 'timeout' | 'ok' = 'timeout';
    let calls = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      calls++;
      if (mode === 'timeout') {
        return Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'));
      }
      return Promise.resolve(makeStatus('main'));
    });

    await service.getRepoStatusSafe('/x'); // opens breaker
    expect(calls).toBe(1);

    // Rewind the failure timestamp past the cooldown window.
    (service as any).statusFailures.set('/x', Date.now() - TEN_MIN_MS);
    mode = 'ok';

    const res = await service.getRepoStatusSafe('/x');
    expect(calls).toBe(2); // recomputed once the cooldown expired
    expect(res.branch).toBe('main');
    expect(res.degraded).toBeUndefined();
    expect((service as any).statusFailures.has('/x')).toBe(false); // breaker cleared
    expect((service as any).statusCache.get('/x').data.branch).toBe('main'); // cache refreshed
  });

  // --- 8. non-resource error rethrows and does NOT open the breaker ---------

  it('rethrows a genuine git error and never opens the breaker', async () => {
    let calls = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      calls++;
      return Promise.reject(new Error('fatal: not a git repository'));
    });

    await expect(service.getRepoStatusSafe('/x')).rejects.toThrow('not a git repository');
    expect((service as any).statusFailures.has('/x')).toBe(false);

    // No breaker → a retry recomputes (preserves the failed-retry contract).
    await expect(service.getRepoStatusSafe('/x')).rejects.toThrow('not a git repository');
    expect(calls).toBe(2);
  });

  // --- 9. fresh=1 (bypassCache) does not punch through an open breaker -------

  it('does not let bypassCache (?fresh=1) bypass an active breaker', async () => {
    let calls = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() => {
      calls++;
      return Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'));
    });

    await service.getRepoStatusSafe('/x'); // opens breaker
    expect(calls).toBe(1);

    const res = await service.getRepoStatusSafe('/x', { bypassCache: true });
    expect(calls).toBe(1); // breaker blocks even the fresh path
    expect(res.degraded).toBe(true);
  });

  // --- 10. process-wide concurrency cap -------------------------------------

  it('caps concurrent status computes at statusMaxConcurrent', async () => {
    (service as any).statusMaxConcurrent = 1;
    let active = 0;
    let maxActive = 0;
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(
      () =>
        new Promise((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            resolve(makeStatus('m'));
          }, 30);
        })
    );

    const results = await Promise.all([
      service.getRepoStatusSafe('/a'),
      service.getRepoStatusSafe('/b'),
      service.getRepoStatusSafe('/c'),
    ]);

    expect(maxActive).toBe(1);
    expect(results.map((r) => r.branch)).toEqual(['m', 'm', 'm']);
  });

  // --- 11. fetchFirst short-circuits before fetch when breaker is open ------

  it('skips the fetch entirely (fetchFirst) when the breaker is open', async () => {
    let fetches = 0;
    spyOn(service as any, 'performFetch').mockImplementation(() => {
      fetches++;
      return Promise.resolve();
    });
    spyOn(service as any, 'computeCompleteRepoStatus').mockImplementation(() =>
      Promise.reject(new GitResourceLimitError('timed out after 15000ms', 'timeout'))
    );

    // Open the breaker with a plain status call.
    await service.getRepoStatusSafe('/x');

    // A following fetchFirst call must not even attempt `git fetch`.
    const res = await service.getRepoStatusSafe('/x', { fetchFirst: true });
    expect(fetches).toBe(0);
    expect(res.degraded).toBe(true);
  });

  // --- 12. getUnpushedCount ---------------------------------------------------

  it('getUnpushedCount parses rev-list --count and is failure-safe', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve('7\n');
    };
    expect(await service.getUnpushedCount('/x')).toBe(7);
    expect(captured!.args).toEqual(['rev-list', '--count', '--branches', '--not', '--remotes']);
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);

    // Any runner failure → 0 (best-effort metadata, never throws).
    (service as any).gitRunner = () => Promise.reject(new Error('boom'));
    expect(await service.getUnpushedCount('/x')).toBe(0);
  });
});
