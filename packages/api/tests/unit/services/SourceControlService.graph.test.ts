/**
 * SourceControlService.getCommitGraph (US-004, portable.dev#17)
 *
 * Verifies the commit-graph reader: the `git log` runner args + resource bounds,
 * the FIELD_SEP / RECORD_SEP parse (multi-parent merge, root commit), ref
 * decoration classification (HEAD/tag:/origin/*), offset-based pagination, and
 * the GitResourceLimitError → degraded-empty path.
 *
 * Strategy: stub the injectable `gitRunner` seam (no real git). Records are
 * built with the same ASCII separators the service requests so the parse is
 * exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SourceControlService } from '../../../src/services/SourceControlService.js';
import { GitResourceLimitError } from '../../../src/services/git/runGit.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import type { AuthService } from '../../../src/services/AuthService.js';

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Build one `git log` record matching the service's `--pretty` field order. */
function rec(opts: {
  sha: string;
  parents?: string;
  author?: string;
  date?: string;
  decorate?: string;
  subject?: string;
}): string {
  const {
    sha,
    parents = '',
    author = 'Ada Lovelace',
    date = '2026-06-16T10:00:00-07:00',
    decorate = '',
    subject = 'a commit',
  } = opts;
  return [sha, parents, author, date, decorate, subject].join(FIELD) + RECORD;
}

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

describe('SourceControlService.getCommitGraph', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('runs git log with --all --topo-order, a bounded max-count, and resource limits', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve(rec({ sha: 'aaa', subject: 'init' }));
    };

    await service.getCommitGraph('/repo', { limit: 200 });

    expect(captured!.args[0]).toBe('log');
    expect(captured!.args).toContain('--all');
    expect(captured!.args).toContain('--topo-order');
    // limit + 1 rows requested so "more history" can be detected.
    expect(captured!.args).toContain('--max-count=201');
    expect(captured!.args.some((a) => a.startsWith('--pretty='))).toBe(true);
    // No --skip on the first page.
    expect(captured!.args.some((a) => a.startsWith('--skip='))).toBe(false);
    expect(captured!.opts.cwd).toBe('/repo');
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);
    expect(captured!.opts.maxOutputBytes).toBeGreaterThan(0);
  });

  it('walks HEAD only (not --all) when all:false', async () => {
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve(rec({ sha: 'aaa' }));
    };

    await service.getCommitGraph('/repo', { all: false });

    expect(captured).toContain('HEAD');
    expect(captured).not.toContain('--all');
  });

  it('parses a multi-parent merge commit (parents.length >= 2)', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(
        rec({
          sha: 'merge1',
          parents: 'p1 p2',
          subject: 'Merge branch feature',
          decorate: 'HEAD -> main',
        })
      );

    const { nodes } = await service.getCommitGraph('/repo');

    expect(nodes).toHaveLength(1);
    expect(nodes[0].sha).toBe('merge1');
    expect(nodes[0].parents).toEqual(['p1', 'p2']);
    expect(nodes[0].parents.length).toBeGreaterThanOrEqual(2);
    expect(nodes[0].subject).toBe('Merge branch feature');
  });

  it('parses a root commit with no parents', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(rec({ sha: 'root1', parents: '', subject: 'initial commit' }));

    const { nodes } = await service.getCommitGraph('/repo');

    expect(nodes).toHaveLength(1);
    expect(nodes[0].parents).toEqual([]);
  });

  it('classifies HEAD/branch/tag/origin decorations into typed refs', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(
        rec({
          sha: 'deco1',
          parents: 'p0',
          decorate: 'HEAD -> main, origin/main, tag: v1.0.0, feature/x',
          subject: 'decorated',
        })
      );

    const { nodes } = await service.getCommitGraph('/repo');

    expect(nodes[0].refs).toEqual([
      { name: 'main', type: 'head' },
      { name: 'origin/main', type: 'remote' },
      { name: 'v1.0.0', type: 'tag' },
      { name: 'feature/x', type: 'branch' },
    ]);
  });

  it('returns an empty refs array when a commit has no decorations', async () => {
    (service as any).gitRunner = () =>
      Promise.resolve(rec({ sha: 'bare1', parents: 'p0', decorate: '' }));

    const { nodes } = await service.getCommitGraph('/repo');

    expect(nodes[0].refs).toEqual([]);
  });

  it('parses multiple records and skips the trailing empty record', async () => {
    // git separates entries with a newline; the last record is followed by EOF.
    const out =
      rec({ sha: 'c2', parents: 'c1', subject: 'second' }) +
      '\n' +
      rec({ sha: 'c1', parents: '', subject: 'first' });
    (service as any).gitRunner = () => Promise.resolve(out);

    const { nodes } = await service.getCommitGraph('/repo');

    expect(nodes.map((n) => n.sha)).toEqual(['c2', 'c1']);
    expect(nodes[1].parents).toEqual([]);
  });

  it('emits an offset-based nextCursor when more history exists', async () => {
    // limit:2 → service requests 3 rows; returning 3 means there is a 3rd page row.
    const out =
      rec({ sha: 'a', parents: 'b' }) +
      '\n' +
      rec({ sha: 'b', parents: 'c' }) +
      '\n' +
      rec({ sha: 'c', parents: '' });
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve(out);
    };

    const res = await service.getCommitGraph('/repo', { limit: 2 });

    expect(captured).toContain('--max-count=3');
    // Extra row dropped; only `limit` nodes returned.
    expect(res.nodes.map((n) => n.sha)).toEqual(['a', 'b']);
    expect(res.nextCursor).toBe('2');
  });

  it('has no nextCursor on the last page and applies --skip from the cursor', async () => {
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve(rec({ sha: 'z', parents: '' }));
    };

    const res = await service.getCommitGraph('/repo', { limit: 2, cursor: '2' });

    expect(captured).toContain('--skip=2');
    expect(res.nextCursor).toBeUndefined();
    expect(res.nodes).toHaveLength(1);
  });

  it('returns a degraded empty result on a GitResourceLimitError', async () => {
    (service as any).gitRunner = () =>
      Promise.reject(new GitResourceLimitError('git log timed out after 15000ms', 'timeout'));

    const res = await service.getCommitGraph('/repo');

    expect(res.nodes).toEqual([]);
    expect(res.degraded).toBe(true);
    expect(res.nextCursor).toBeUndefined();
  });

  it('rethrows a genuine (non-resource) git error', async () => {
    (service as any).gitRunner = () =>
      Promise.reject(new Error('fatal: your current branch does not have any commits yet'));

    await expect(service.getCommitGraph('/repo')).rejects.toThrow(/does not have any commits/);
  });
});
