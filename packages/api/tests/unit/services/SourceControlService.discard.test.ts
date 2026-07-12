/**
 * SourceControlService.discard (US-014, portable.dev#17) — DESTRUCTIVE.
 *
 * Two layers:
 *  1. Stub the injectable `gitRunner` seam to assert the per-status argv split
 *     (`git restore -- <tracked>` + `git clean -fd -- <untracked>`, each leading
 *     with `--`), and the empty-paths / path-traversal guards (no git run).
 *  2. A REAL-git integration test against a temp repo that proves the AC effect:
 *     discarding a modified tracked file restores it, and discarding an untracked
 *     file removes it from disk + the working tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  SourceControlService,
  PathTraversalError,
  EmptyPathsError,
} from '../../../src/services/SourceControlService.js';
import type { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import type { AuthService } from '../../../src/services/AuthService.js';

function makeService(): SourceControlService {
  return new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );
}

describe('SourceControlService.discard — argv split + guards', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('runs `git restore -- <tracked>` and `git clean -fd -- <untracked>`, each leading with `--`', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      // The classification read (`git status --porcelain=v2 --branch`): report
      // `new.txt` as untracked, `src/a.ts` as a tracked worktree modification.
      if (args[0] === 'status') {
        return Promise.resolve(
          '# branch.head main\n1 .M N... 100644 100644 100644 h h src/a.ts\n? new.txt\n'
        );
      }
      return Promise.resolve('');
    };

    const res = await service.discard('/repo', ['src/a.ts', 'new.txt']);

    const restore = calls.find((a) => a[0] === 'restore');
    const clean = calls.find((a) => a[0] === 'clean');
    expect(restore).toEqual(['restore', '--', 'src/a.ts']);
    expect(clean).toEqual(['clean', '-fd', '--', 'new.txt']);
    expect(res).toEqual({ ok: true, paths: ['src/a.ts', 'new.txt'] });
  });

  it('only runs `git restore` when no requested path is untracked', async () => {
    const calls: string[][] = [];
    (service as any).gitRunner = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'status') {
        return Promise.resolve('# branch.head main\n1 .M N... 100644 100644 100644 h h src/a.ts\n');
      }
      return Promise.resolve('');
    };

    await service.discard('/repo', ['src/a.ts']);

    expect(calls.find((a) => a[0] === 'restore')).toEqual(['restore', '--', 'src/a.ts']);
    expect(calls.find((a) => a[0] === 'clean')).toBeUndefined();
  });

  it('rejects a path escaping the repo with PathTraversalError (no git run)', async () => {
    let ran = false;
    (service as any).gitRunner = () => {
      ran = true;
      return Promise.resolve('');
    };

    await expect(service.discard('/repo', ['../../etc/passwd'])).rejects.toBeInstanceOf(
      PathTraversalError
    );
    expect(ran).toBe(false);
  });

  it('rejects empty / non-array paths with EmptyPathsError (no git run)', async () => {
    let ran = false;
    (service as any).gitRunner = () => {
      ran = true;
      return Promise.resolve('');
    };

    await expect(service.discard('/repo', [])).rejects.toBeInstanceOf(EmptyPathsError);
    await expect(service.discard('/repo', undefined as unknown as string[])).rejects.toBeInstanceOf(
      EmptyPathsError
    );
    expect(ran).toBe(false);
  });
});

describe('SourceControlService.discard — real git effect', () => {
  let repoDir: string;
  let service: SourceControlService;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-discard-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'original\n');
    git('add', 'file.ts');
    git('commit', '-q', '-m', 'init');

    service = makeService();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('discarding a modified tracked file restores its committed contents', async () => {
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'changed\n');
    const before = await service.getWorkingTreeChanges(repoDir);
    expect(before.unstaged.map((f) => f.path)).toContain('file.ts');

    const res = await service.discard(repoDir, ['file.ts']);
    expect(res).toEqual({ ok: true, paths: ['file.ts'] });

    // File reverted to HEAD on disk + the working tree is clean again.
    expect(fs.readFileSync(path.join(repoDir, 'file.ts'), 'utf-8')).toBe('original\n');
    const after = await service.getWorkingTreeChanges(repoDir);
    expect(after.unstaged.map((f) => f.path)).not.toContain('file.ts');
  });

  it('discarding an untracked file removes it from disk + the working tree', async () => {
    const untracked = path.join(repoDir, 'scratch.txt');
    fs.writeFileSync(untracked, 'temp\n');
    const before = await service.getWorkingTreeChanges(repoDir);
    expect(before.untracked.map((f) => f.path)).toContain('scratch.txt');

    const res = await service.discard(repoDir, ['scratch.txt']);
    expect(res).toEqual({ ok: true, paths: ['scratch.txt'] });

    expect(fs.existsSync(untracked)).toBe(false);
    const after = await service.getWorkingTreeChanges(repoDir);
    expect(after.untracked.map((f) => f.path)).not.toContain('scratch.txt');
  });

  it('discarding a mix reverts the tracked file and deletes the untracked one', async () => {
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'changed\n');
    fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'temp\n');

    await service.discard(repoDir, ['file.ts', 'scratch.txt']);

    expect(fs.readFileSync(path.join(repoDir, 'file.ts'), 'utf-8')).toBe('original\n');
    expect(fs.existsSync(path.join(repoDir, 'scratch.txt'))).toBe(false);
    const after = await service.getWorkingTreeChanges(repoDir);
    expect(after.unstaged).toHaveLength(0);
    expect(after.untracked).toHaveLength(0);
  });
});
