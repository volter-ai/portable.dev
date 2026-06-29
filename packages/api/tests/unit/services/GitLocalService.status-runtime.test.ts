/**
 * GitLocalService — git-status REAL subprocess bounds (large-repo freeze fix)
 *
 * The status-timeout suite stubs the `gitRunner` seam, so it
 * never proves the actual spawn path. These tests run the REAL `runGit` against
 * a fake `git` on PATH that either hangs or floods stdout, asserting that:
 *   - a hung `git status`/`git diff` is SIGKILLed at the timeout (the call
 *     returns in ~timeout, NOT after the fake git's long sleep), and
 *   - a `git status` that floods stdout is SIGKILLed once it exceeds the output
 *     cap,
 * with `getRepoStatusSafe` degrading to `{ degraded: true }` either way — i.e.
 * the sandbox-freezing scenario now returns promptly instead of wedging.
 *
 * This is the end-to-end equivalent of the manual PATH-shim repro, without
 * booting the server. POSIX-only (skipped on win32).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `vgit-status-runtime-${process.pid}`);

import { GitLocalService } from '../../../src/services/GitLocalService.js';

const isPosix = process.platform !== 'win32';
const d = isPosix ? describe : describe.skip;

// A temp dir used as the spawn cwd (must exist; need not be a real git repo —
// the fake `git` intercepts every invocation).
let repoDir: string;
// Dir prepended to PATH holding the fake `git`.
let shimDir: string;
let originalPath: string | undefined;

/** Write an executable `git` shim and prepend its dir to PATH. */
function installGitShim(script: string): void {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgit-shim-'));
  const gitPath = path.join(shimDir, 'git');
  fs.writeFileSync(gitPath, script, { mode: 0o755 });
  fs.chmodSync(gitPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ''}`;
}

function removeGitShim(): void {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  try {
    fs.rmSync(shimDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

d('GitLocalService git-status REAL subprocess bounds', () => {
  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgit-repo-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('SIGKILLs a hung git and returns degraded at the timeout (not the sleep)', async () => {
    // Fake git: any status/diff/fetch hangs for 30s; everything else exits 0.
    installGitShim(
      '#!/bin/sh\n' +
        'for a in "$@"; do\n' +
        '  case "$a" in\n' +
        '    status|diff|fetch) exec sleep 30 ;;\n' +
        '  esac\n' +
        'done\n' +
        'exit 0\n'
    );

    try {
      const service = new GitLocalService();
      (service as any).statusGitTimeoutMs = 250; // tiny budget for the test

      const start = Date.now();
      const res = await service.getRepoStatusSafe(repoDir);
      const elapsed = Date.now() - start;

      expect(res.degraded).toBe(true);
      expect(res.branch).toBe('unknown');
      // Returned because the timeout SIGKILLed git — NOT because `sleep 30`
      // finished. A generous ceiling keeps this robust on a loaded CI box.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      removeGitShim();
    }
  });

  it('SIGKILLs a flooding git status once it exceeds the output cap (degraded)', async () => {
    // Fake git: `status` floods stdout (~5MB); `diff` returns empty quickly.
    installGitShim(
      '#!/bin/sh\n' +
        'for a in "$@"; do\n' +
        '  case "$a" in\n' +
        "    status) exec sh -c 'yes 2>/dev/null | head -c 5000000' ;;\n" +
        '    diff) exit 0 ;;\n' +
        '  esac\n' +
        'done\n' +
        'exit 0\n'
    );

    try {
      const service = new GitLocalService();
      (service as any).statusOutputLimitBytes = 1000; // 1 KB cap
      (service as any).statusGitTimeoutMs = 10000; // ensure the CAP fires, not the timeout

      const start = Date.now();
      const res = await service.getRepoStatusSafe(repoDir);
      const elapsed = Date.now() - start;

      expect(res.degraded).toBe(true);
      expect(res.branch).toBe('unknown');
      // Killed on the output cap, long before the 10s timeout.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      removeGitShim();
    }
  });
});
