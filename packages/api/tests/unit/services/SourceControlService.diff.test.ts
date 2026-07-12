/**
 * SourceControlService.getFileDiff + getCommitDetail (US-006, portable.dev#17)
 *
 * Verifies the per-file diff and per-commit detail readers: the git runner args
 * + resource bounds, the path-traversal guard (escape → PathTraversalError), the
 * sha guard (non-hex → InvalidShaError), and the name-status/numstat zip into a
 * changed-files list with stats.
 *
 * Strategy: stub the injectable `gitRunner` seam (no real git). For
 * getCommitDetail the stub branches on the requested `--name-status` /
 * `--numstat` / patch args so each of the three `git show` calls returns the
 * right fixture.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SourceControlService,
  PathTraversalError,
  InvalidShaError,
} from '../../../src/services/SourceControlService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import type { AuthService } from '../../../src/services/AuthService.js';

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const FILE_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' context',
  '-old line',
  '+new line',
  '+added line',
].join('\n');

describe('SourceControlService.getFileDiff', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('runs git diff -- <path> (worktree) with resource limits', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve(FILE_DIFF);
    };

    const res = await service.getFileDiff('/repo', 'src/foo.ts');

    expect(captured!.args).toEqual(['diff', '--', 'src/foo.ts']);
    expect(captured!.opts.cwd).toBe('/repo');
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);
    expect(captured!.opts.maxOutputBytes).toBeGreaterThan(0);
    expect(res.path).toBe('src/foo.ts');
    expect(res.diff).toContain('@@ -1,3 +1,4 @@');
  });

  it('adds --cached when staged is requested', async () => {
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve(FILE_DIFF);
    };

    await service.getFileDiff('/repo', 'src/foo.ts', { staged: true });

    expect(captured).toEqual(['diff', '--cached', '--', 'src/foo.ts']);
  });

  it('falls back to an all-additions --no-index diff for an UNTRACKED file', async () => {
    const NEW_FILE_DIFF = [
      'diff --git a/dev/null b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n');
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      if (args.includes('--no-index')) return Promise.resolve(NEW_FILE_DIFF);
      if (args[0] === 'ls-files') return Promise.reject(new Error('untracked')); // not tracked
      return Promise.resolve(''); // plain `git diff` is empty for an untracked file
    };

    const res = await service.getFileDiff('/repo', 'src/new.ts');

    // The plain diff was empty, ls-files said "untracked", so we ran --no-index.
    expect(calls.some((a) => a.join(' ') === 'diff --no-index -- /dev/null src/new.ts')).toBe(true);
    expect(res.diff).toContain('@@ -0,0 +1,2 @@');
    expect(res.diff).toContain('+line one');
  });

  it('does NOT run the --no-index fallback for an UNCHANGED tracked file (stays empty)', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ls-files') return Promise.resolve(''); // tracked (exit 0)
      return Promise.resolve(''); // no diff — the file is unchanged
    };

    const res = await service.getFileDiff('/repo', 'src/unchanged.ts');

    expect(res.diff).toBe('');
    // An unchanged tracked file must NOT be rendered as all-additions.
    expect(calls.some((a) => a.includes('--no-index'))).toBe(false);
  });

  it('throws PathTraversalError for a path escaping the repo', async () => {
    let called = false;
    (service as any).gitRunner = () => {
      called = true;
      return Promise.resolve('');
    };

    await expect(service.getFileDiff('/repo', '../../etc/passwd')).rejects.toBeInstanceOf(
      PathTraversalError
    );
    expect(called).toBe(false); // guard runs before git
  });
});

describe('SourceControlService.getCommitDetail', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  /** Route the three `git show` calls by their stat-format flag. */
  function stubShow(opts: { nameStatus: string; numstat: string; patch: string }) {
    (service as any).gitRunner = (args: string[]) => {
      if (args.includes('--name-status')) return Promise.resolve(opts.nameStatus);
      if (args.includes('--numstat')) return Promise.resolve(opts.numstat);
      return Promise.resolve(opts.patch);
    };
  }

  it('rejects a non-hex sha with InvalidShaError (before any git call)', async () => {
    let called = false;
    (service as any).gitRunner = () => {
      called = true;
      return Promise.resolve('');
    };

    await expect(service.getCommitDetail('/repo', '--upload-pack=evil')).rejects.toBeInstanceOf(
      InvalidShaError
    );
    expect(called).toBe(false);
  });

  it('runs git show with -M for each of name-status / numstat / patch', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      return Promise.resolve('');
    };

    await service.getCommitDetail('/repo', SHA);

    expect(calls.length).toBe(3);
    for (const args of calls) {
      expect(args[0]).toBe('show');
      expect(args).toContain(SHA);
      expect(args).toContain('-M');
      // git ≥ 2.39: `--no-patch` (-s) + `--name-status`/`--name-only` is a
      // fatal "cannot be used together" — every commit-detail read would 500.
      expect(args).not.toContain('--no-patch');
    }
  });

  it('zips name-status + numstat into a changed-files list with stats', async () => {
    stubShow({
      nameStatus: ['M\tsrc/foo.ts', 'A\tsrc/bar.ts', 'D\tsrc/old.ts'].join('\n'),
      numstat: ['3\t1\tsrc/foo.ts', '10\t0\tsrc/bar.ts', '0\t5\tsrc/old.ts'].join('\n'),
      patch: FILE_DIFF,
    });

    const res = await service.getCommitDetail('/repo', SHA);

    expect(res.sha).toBe(SHA);
    expect(res.files).toEqual([
      { path: 'src/foo.ts', status: 'modified', staged: false, insertions: 3, deletions: 1 },
      { path: 'src/bar.ts', status: 'added', staged: false, insertions: 10, deletions: 0 },
      { path: 'src/old.ts', status: 'deleted', staged: false, insertions: 0, deletions: 5 },
    ]);
    expect(res.stats).toEqual({ additions: 13, deletions: 6 });
    expect(res.diff).toContain('@@ -1,3 +1,4 @@');
  });

  it('parses a rename with previousPath and tolerates binary (-) numstat', async () => {
    stubShow({
      nameStatus: ['R100\told/name.ts\tnew/name.ts', 'M\timg.png'].join('\n'),
      numstat: ['0\t0\tnew/name.ts', '-\t-\timg.png'].join('\n'),
      patch: 'diff --git a/new/name.ts b/new/name.ts\nsimilarity index 100%\n',
    });

    const res = await service.getCommitDetail('/repo', SHA);

    expect(res.files[0]).toEqual({
      path: 'new/name.ts',
      status: 'renamed',
      staged: false,
      previousPath: 'old/name.ts',
      insertions: 0,
      deletions: 0,
    });
    // Binary file: no insertions/deletions fields, not counted in stats.
    expect(res.files[1]).toEqual({ path: 'img.png', status: 'modified', staged: false });
    expect(res.stats).toEqual({ additions: 0, deletions: 0 });
  });
});
