/**
 * SourceControlService.listWorktrees + the optional `worktree` scope param on
 * getWorkingTreeChanges / getFileDiff (US-007, portable.dev#17)
 *
 * Verifies the `git worktree list --porcelain` parse (main + linked + detached +
 * locked, with isMain flagged on the first record and refs/heads/<n> stripped to
 * a branch name), the runner args + resource bounds, and that the optional
 * worktree param scopes a status / file-diff read to that worktree's cwd while
 * rejecting a path that escapes the main checkout.
 *
 * Strategy: stub the injectable `gitRunner` seam (no real git), per the project
 * pattern. A pure-git read builds the service with `{} as ...` for the DB/auth
 * deps it never touches.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SourceControlService,
  PathTraversalError,
} from '../../../src/services/SourceControlService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import type { AuthService } from '../../../src/services/AuthService.js';

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

/**
 * A porcelain fixture: main + a linked branch worktree + a detached worktree + a
 * locked worktree (with a reason). Records are blank-line separated; git ends the
 * stream with a trailing blank line.
 */
const WORKTREE_PORCELAIN = [
  'worktree /workspace/owner/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /workspace/owner/repo/.worktrees/feature',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/x',
  '',
  'worktree /workspace/owner/repo/.worktrees/detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /workspace/owner/repo/.worktrees/locked',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/locked-branch',
  'locked needs review',
  '',
].join('\n');

describe('SourceControlService.listWorktrees', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('runs git worktree list --porcelain with resource limits', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve(WORKTREE_PORCELAIN);
    };

    await service.listWorktrees('/workspace/owner/repo');

    expect(captured!.args).toEqual(['worktree', 'list', '--porcelain']);
    expect(captured!.opts.cwd).toBe('/workspace/owner/repo');
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);
    expect(captured!.opts.maxOutputBytes).toBeGreaterThan(0);
  });

  it('parses main + linked + detached + locked worktrees', async () => {
    (service as any).gitRunner = () => Promise.resolve(WORKTREE_PORCELAIN);

    const { worktrees } = await service.listWorktrees('/workspace/owner/repo');

    expect(worktrees).toHaveLength(4);

    // Main checkout — first record, isMain true, branch stripped of refs/heads/.
    expect(worktrees[0]).toEqual({
      path: '/workspace/owner/repo',
      head: '1111111111111111111111111111111111111111',
      branch: 'main',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: true,
    });

    // Linked branch worktree — not main, branch name preserved (incl. slash).
    expect(worktrees[1]).toEqual({
      path: '/workspace/owner/repo/.worktrees/feature',
      head: '2222222222222222222222222222222222222222',
      branch: 'feature/x',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain: false,
    });

    // Detached worktree — no branch, detached flag set.
    expect(worktrees[2]).toEqual({
      path: '/workspace/owner/repo/.worktrees/detached',
      head: '3333333333333333333333333333333333333333',
      detached: true,
      bare: false,
      locked: false,
      prunable: false,
      isMain: false,
    });

    // Locked worktree — locked flag + reason captured.
    expect(worktrees[3]).toEqual({
      path: '/workspace/owner/repo/.worktrees/locked',
      head: '4444444444444444444444444444444444444444',
      branch: 'locked-branch',
      detached: false,
      bare: false,
      locked: true,
      lockedReason: 'needs review',
      prunable: false,
      isMain: false,
    });
  });

  it('returns exactly one (main) worktree for a normal single clone', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(
        [
          'worktree /workspace/owner/repo',
          'HEAD abc1234abc1234abc1234abc1234abc1234abcd',
          'branch refs/heads/main',
          '',
        ].join('\n')
      );

    const { worktrees } = await service.listWorktrees('/workspace/owner/repo');

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].branch).toBe('main');
  });

  it('captures a bare and a prunable worktree with its reason', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(
        [
          'worktree /workspace/owner/repo.git',
          'bare',
          '',
          'worktree /workspace/owner/repo/.worktrees/gone',
          'HEAD 5555555555555555555555555555555555555555',
          'branch refs/heads/gone',
          'prunable gitdir file points to non-existent location',
          '',
        ].join('\n')
      );

    const { worktrees } = await service.listWorktrees('/workspace/owner/repo.git');

    expect(worktrees[0].bare).toBe(true);
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[1].prunable).toBe(true);
    expect(worktrees[1].prunableReason).toBe('gitdir file points to non-existent location');
  });
});

describe('SourceControlService worktree-scoped reads (US-007)', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('scopes a status read to the given worktree cwd', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve('# branch.head feature/x\n# branch.ab +0 -0\n');
    };

    const res = await service.getWorkingTreeChanges('/workspace/owner/repo', {
      worktree: '/workspace/owner/repo/.worktrees/feature',
    });

    expect(captured!.args).toEqual(['status', '--porcelain=v2', '--branch']);
    expect(captured!.opts.cwd).toBe('/workspace/owner/repo/.worktrees/feature');
    expect(res.branch).toBe('feature/x');
  });

  it('uses the main checkout cwd when no worktree param is given', async () => {
    let capturedCwd: string | undefined;
    (service as any).gitRunner = (_args: string[], opts: any) => {
      capturedCwd = opts.cwd;
      return Promise.resolve('# branch.head main\n');
    };

    await service.getWorkingTreeChanges('/workspace/owner/repo');

    expect(capturedCwd).toBe('/workspace/owner/repo');
  });

  it('rejects an out-of-checkout worktree path that git does not list (status)', async () => {
    // A sibling dir git never reported as a worktree — the guard consults
    // `git worktree list` and rejects anything not in that authoritative set,
    // so the status read is never issued.
    let statusRan = false;
    (service as any).gitRunner = (args: string[]) => {
      if (args[0] === 'worktree') return Promise.resolve(WORKTREE_PORCELAIN);
      statusRan = true;
      return Promise.resolve('');
    };

    await expect(
      service.getWorkingTreeChanges('/workspace/owner/repo', {
        worktree: '/workspace/owner/other',
      })
    ).rejects.toBeInstanceOf(PathTraversalError);
    expect(statusRan).toBe(false); // rejected before the status read
  });

  it('accepts an out-of-checkout worktree that git DOES list (git-default sibling layout)', async () => {
    // `git worktree add ../repo-feature` → a SIBLING of the main checkout. The
    // list reports its absolute path; a status read scoped to it must succeed.
    const SIBLING = '/workspace/owner/repo-feature';
    let statusCwd: string | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      if (args[0] === 'worktree') {
        return Promise.resolve(
          [
            'worktree /workspace/owner/repo',
            'HEAD 1111111111111111111111111111111111111111',
            'branch refs/heads/main',
            '',
            `worktree ${SIBLING}`,
            'HEAD 5555555555555555555555555555555555555555',
            'branch refs/heads/feature',
            '',
          ].join('\n')
        );
      }
      statusCwd = opts.cwd;
      return Promise.resolve('# branch.head feature\n# branch.ab +0 -0\n');
    };

    const res = await service.getWorkingTreeChanges('/workspace/owner/repo', {
      worktree: SIBLING,
    });

    expect(statusCwd).toBe(SIBLING);
    expect(res.branch).toBe('feature');
  });

  it('scopes a file diff to the given worktree cwd', async () => {
    let capturedCwd: string | undefined;
    (service as any).gitRunner = (_args: string[], opts: any) => {
      capturedCwd = opts.cwd;
      return Promise.resolve('diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n');
    };

    const res = await service.getFileDiff('/workspace/owner/repo', 'src/foo.ts', {
      worktree: '/workspace/owner/repo/.worktrees/feature',
    });

    expect(capturedCwd).toBe('/workspace/owner/repo/.worktrees/feature');
    expect(res.path).toBe('src/foo.ts');
    expect(res.diff).toContain('@@ -1 +1 @@');
  });

  it('rejects a worktree path escaping to an arbitrary directory (file diff)', async () => {
    // `../../etc` resolves far outside the repo and is not a listed worktree,
    // so the diff read never runs.
    let diffRan = false;
    (service as any).gitRunner = (args: string[]) => {
      if (args[0] === 'worktree') return Promise.resolve(WORKTREE_PORCELAIN);
      diffRan = true;
      return Promise.resolve('');
    };

    await expect(
      service.getFileDiff('/workspace/owner/repo', 'src/foo.ts', {
        worktree: '../../etc',
      })
    ).rejects.toBeInstanceOf(PathTraversalError);
    expect(diffRan).toBe(false);
  });
});
