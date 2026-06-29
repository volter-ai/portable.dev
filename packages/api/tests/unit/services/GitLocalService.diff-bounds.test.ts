/**
 * GitLocalService — diff/command bounding (large-repo freeze follow-up).
 *
 * The status/diff-STATS path was already bounded (timeout + cache + breaker), but
 * three sibling methods still spawned git with NO timeout:
 *   - getUnifiedDiff      (module runGit, no timeoutMs)
 *   - getChangedFiles     (execFileAsync, no timeout + 1 MB maxBuffer)
 *   - executeGitCommand   (execFileAsync, no timeout)
 * On the large repo in the logs these could run for minutes and never resolve,
 * wedging their routes. The fix routes all three through the injectable
 * `gitRunner` seam WITH `timeoutMs: statusGitTimeoutMs`. These tests assert that
 * bounding contract by stubbing `gitRunner` (no real git) and inspecting opts.
 */
import { describe, it, expect, beforeEach } from 'bun:test';

import { GitLocalService } from '../../../src/services/GitLocalService.js';

describe('GitLocalService — diff/command bounding', () => {
  let service: GitLocalService;
  let calls: Array<{ args: string[]; opts: any }>;

  beforeEach(() => {
    service = new GitLocalService();
    calls = [];
    // Stub the injectable git seam: record (args, opts), return shaped stdout.
    (service as any).gitRunner = (args: string[], opts: any = {}) => {
      calls.push({ args, opts });
      if (args.includes('--numstat')) return Promise.resolve('1\t2\tfile.ts\n');
      return Promise.resolve('');
    };
  });

  it('getUnifiedDiff bounds BOTH diff subprocesses with statusGitTimeoutMs', async () => {
    await service.getUnifiedDiff('/repo');

    expect(calls.length).toBe(2);
    expect(calls[0].args).toEqual(['diff', '--cached']);
    expect(calls[1].args).toEqual(['diff']);
    for (const c of calls) {
      expect(c.opts.cwd).toBe('/repo');
      expect(c.opts.timeoutMs).toBe((service as any).statusGitTimeoutMs);
    }
  });

  it('getChangedFiles bounds `git diff --numstat` with a hard timeout (no maxBuffer hang)', async () => {
    const files = await service.getChangedFiles('/repo');

    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual(['diff', '--numstat', 'HEAD']);
    expect(calls[0].opts.cwd).toBe('/repo');
    expect(calls[0].opts.timeoutMs).toBe((service as any).statusGitTimeoutMs);
    // Still parses the numstat output correctly after switching runners.
    expect(files).toEqual([{ path: 'file.ts', status: 'modified', insertions: 1, deletions: 2 }]);
  });

  it('executeGitCommand bounds an arbitrary git command with a hard timeout', async () => {
    const out = await service.executeGitCommand('/repo', ['status', '--porcelain']);

    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual(['status', '--porcelain']);
    expect(calls[0].opts.cwd).toBe('/repo');
    expect(calls[0].opts.timeoutMs).toBe((service as any).statusGitTimeoutMs);
    expect(out).toBe('');
  });
});
