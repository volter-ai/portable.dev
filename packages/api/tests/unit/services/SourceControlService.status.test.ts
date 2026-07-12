/**
 * SourceControlService.getWorkingTreeChanges (US-005, portable.dev#17)
 *
 * Verifies the working-tree reader: the `git status --porcelain=v2 --branch`
 * runner args + resource bounds, branch/ahead/behind header parsing, and that
 * each entry lands in the correct group (Staged / Unstaged / Untracked /
 * Conflicts) with the correct status letter and rename `previousPath`.
 *
 * Strategy: stub the injectable `gitRunner` seam (no real git). Output is built
 * with literal porcelain-v2 lines so the parse is exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SourceControlService } from '../../../src/services/SourceControlService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import type { AuthService } from '../../../src/services/AuthService.js';

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

const BRANCH_HEADERS = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
].join('\n');

describe('SourceControlService.getWorkingTreeChanges', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('runs git status --porcelain=v2 --branch with resource limits', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve(BRANCH_HEADERS);
    };

    await service.getWorkingTreeChanges('/repo');

    expect(captured!.args).toEqual(['status', '--porcelain=v2', '--branch']);
    expect(captured!.opts.cwd).toBe('/repo');
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);
    expect(captured!.opts.maxOutputBytes).toBeGreaterThan(0);
  });

  it('parses branch name and ahead/behind from the header', async () => {
    (service as any).gitRunner = () => Promise.resolve(BRANCH_HEADERS);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.branch).toBe('main');
    expect(res.ahead).toBe(2);
    expect(res.behind).toBe(1);
  });

  it('puts a staged add in the Staged group with status added', async () => {
    const out =
      BRANCH_HEADERS +
      '\n' +
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 newfile.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.staged).toEqual([{ path: 'newfile.txt', status: 'added', staged: true }]);
    expect(res.unstaged).toEqual([]);
    expect(res.untracked).toEqual([]);
    expect(res.conflicted).toEqual([]);
  });

  it('puts an unstaged modify in the Unstaged group with status modified', async () => {
    const out =
      BRANCH_HEADERS +
      '\n' +
      '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 changed.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.unstaged).toEqual([{ path: 'changed.txt', status: 'modified', staged: false }]);
    expect(res.staged).toEqual([]);
  });

  it('puts an untracked file in the Untracked group', async () => {
    const out = BRANCH_HEADERS + '\n' + '? untracked.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.untracked).toEqual([{ path: 'untracked.txt', status: 'untracked', staged: false }]);
    expect(res.staged).toEqual([]);
    expect(res.unstaged).toEqual([]);
  });

  it('puts a staged rename in the Staged group with status renamed + previousPath', async () => {
    const out =
      BRANCH_HEADERS +
      '\n' +
      '2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 R100 newname.txt\toldname.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.staged).toEqual([
      { path: 'newname.txt', status: 'renamed', staged: true, previousPath: 'oldname.txt' },
    ]);
  });

  it('puts a conflicted file in the Conflicts group with status conflicted', async () => {
    const out =
      BRANCH_HEADERS +
      '\n' +
      'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.conflicted).toEqual([{ path: 'conflict.txt', status: 'conflicted', staged: false }]);
    expect(res.staged).toEqual([]);
    expect(res.unstaged).toEqual([]);
  });

  it('splits a file that is both staged and unstaged (MM) into both groups', async () => {
    const out =
      BRANCH_HEADERS +
      '\n' +
      '1 MM N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 both.txt';
    (service as any).gitRunner = () => Promise.resolve(out);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.staged).toEqual([{ path: 'both.txt', status: 'modified', staged: true }]);
    expect(res.unstaged).toEqual([{ path: 'both.txt', status: 'modified', staged: false }]);
  });

  it('returns empty groups for a clean tree', async () => {
    (service as any).gitRunner = () => Promise.resolve(BRANCH_HEADERS);

    const res = await service.getWorkingTreeChanges('/repo');

    expect(res.staged).toEqual([]);
    expect(res.unstaged).toEqual([]);
    expect(res.untracked).toEqual([]);
    expect(res.conflicted).toEqual([]);
  });
});
