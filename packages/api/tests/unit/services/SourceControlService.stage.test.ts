/**
 * SourceControlService.stage / unstage (US-013, portable.dev#17)
 *
 * Two layers:
 *  1. Stub the injectable `gitRunner` seam to assert the exact git argv +
 *     resource bounds, the path-traversal guard, and the empty-paths guard
 *     (deterministic, no real git).
 *  2. A REAL-git integration test against a temp repo that proves the effect the
 *     AC requires: staging an unstaged file moves it from the Unstaged group to
 *     the Staged group on the next `getWorkingTreeChanges` read (and unstaging
 *     moves it back).
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

describe('SourceControlService.stage / unstage — argv + guards', () => {
  let service: SourceControlService;

  beforeEach(() => {
    service = makeService();
  });

  it('stage runs `git add -- <paths>` with resource limits and echoes the paths', async () => {
    let captured: { args: string[]; opts: any } | undefined;
    (service as any).gitRunner = (args: string[], opts: any) => {
      captured = { args, opts };
      return Promise.resolve('');
    };

    const res = await service.stage('/repo', ['src/a.ts', 'b.ts']);

    expect(captured!.args).toEqual(['add', '--', 'src/a.ts', 'b.ts']);
    expect(captured!.opts.cwd).toBe('/repo');
    expect(captured!.opts.timeoutMs).toBeGreaterThan(0);
    expect(captured!.opts.maxOutputBytes).toBeGreaterThan(0);
    expect(res).toEqual({ ok: true, paths: ['src/a.ts', 'b.ts'] });
  });

  it('unstage runs `git restore --staged -- <paths>`', async () => {
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve('');
    };

    const res = await service.unstage('/repo', ['src/a.ts']);

    expect(captured).toEqual(['restore', '--staged', '--', 'src/a.ts']);
    expect(res).toEqual({ ok: true, paths: ['src/a.ts'] });
  });

  it('always leads with `--` so a `-`-prefixed path cannot be parsed as a git option', async () => {
    let captured: string[] | undefined;
    (service as any).gitRunner = (args: string[]) => {
      captured = args;
      return Promise.resolve('');
    };

    await service.stage('/repo', ['-rf']);

    // The path still resolves inside the repo, and the `--` separator protects it.
    expect(captured).toEqual(['add', '--', '-rf']);
  });

  it('rejects a path escaping the repo with PathTraversalError (no git run)', async () => {
    let ran = false;
    (service as any).gitRunner = () => {
      ran = true;
      return Promise.resolve('');
    };

    await expect(service.stage('/repo', ['../../etc/passwd'])).rejects.toBeInstanceOf(
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

    await expect(service.stage('/repo', [])).rejects.toBeInstanceOf(EmptyPathsError);
    await expect(service.unstage('/repo', undefined as unknown as string[])).rejects.toBeInstanceOf(
      EmptyPathsError
    );
    expect(ran).toBe(false);
  });
});

describe('SourceControlService.stage / unstage — real git effect', () => {
  let repoDir: string;
  let service: SourceControlService;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' });
  };

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-stage-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'original\n');
    git('add', 'file.ts');
    git('commit', '-q', '-m', 'init');
    // Modify the tracked file so it shows up as an unstaged change.
    fs.writeFileSync(path.join(repoDir, 'file.ts'), 'changed\n');

    service = makeService();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('staging an unstaged file moves it to the Staged group on the next status read', async () => {
    const before = await service.getWorkingTreeChanges(repoDir);
    expect(before.unstaged.map((f) => f.path)).toContain('file.ts');
    expect(before.staged.map((f) => f.path)).not.toContain('file.ts');

    const res = await service.stage(repoDir, ['file.ts']);
    expect(res).toEqual({ ok: true, paths: ['file.ts'] });

    const after = await service.getWorkingTreeChanges(repoDir);
    expect(after.staged.map((f) => f.path)).toContain('file.ts');
    expect(after.unstaged.map((f) => f.path)).not.toContain('file.ts');
  });

  it('unstaging a staged file moves it back to the Unstaged group', async () => {
    await service.stage(repoDir, ['file.ts']);
    expect((await service.getWorkingTreeChanges(repoDir)).staged.map((f) => f.path)).toContain(
      'file.ts'
    );

    const res = await service.unstage(repoDir, ['file.ts']);
    expect(res).toEqual({ ok: true, paths: ['file.ts'] });

    const after = await service.getWorkingTreeChanges(repoDir);
    expect(after.unstaged.map((f) => f.path)).toContain('file.ts');
    expect(after.staged.map((f) => f.path)).not.toContain('file.ts');
  });
});
