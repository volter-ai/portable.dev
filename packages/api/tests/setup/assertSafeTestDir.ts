/**
 * assertSafeTestDir — the last line of defence against the test suite deleting
 * REAL files (issue #1563).
 *
 * Several tests treat `WORKSPACE_DIR` / `DATA_DIR` as a disposable sandbox and
 * `fs.rm(..., { recursive: true, force: true })` them between cases. After the
 * rev9 D27 "per-user layer collapse", `getUserWorkspaceDir()` returns
 * `WORKSPACE_DIR` itself, so those deletes now hit the workspace ROOT. If
 * `WORKSPACE_DIR` ever resolves to a real path — e.g. a developer's `.env` sets
 * `WORKSPACE_DIR` to the parent folder that CONTAINS this repo, and the preload
 * force-set didn't apply (a bare `bun --cwd packages/api test` skips the root
 * bunfig preload) — the suite deletes the real repo plus the untracked `.env*`
 * files. This happened TWICE.
 *
 * This guard makes that structurally impossible: any directory the suite will
 * create / populate / DELETE must live under the OS temp dir, and must NOT be
 * inside the repo or any git working tree. `assertSafeTestDir` THROWS on an
 * unsafe dir; the preload (`isolateTestDirs.ts`) turns that throw into an
 * immediate `process.exit(1)` so NOT A SINGLE test runs against a real path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root: this file lives at packages/api/tests/setup — four levels down.
const REPO_ROOT = realpathNearest(path.resolve(__dirname, '..', '..', '..', '..'));

/**
 * Resolve `p` to an absolute, symlink-free path, tolerating a not-yet-created
 * directory by realpath-ing its nearest EXISTING ancestor and re-joining the
 * remainder. (macOS `os.tmpdir()` is a `/var → /private/var` symlink, so a naive
 * string compare against a not-yet-created temp dir would miss.)
 */
function realpathNearest(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  // Bounded by the filesystem root (path.dirname('/') === '/').
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // nothing on the path exists
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` is `parent`, or lives underneath it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Nearest ancestor of `p` (inclusive) that is a git working tree, or null. */
function enclosingGitWorkingTree(p: string): string | null {
  let cur = path.resolve(p);
  for (;;) {
    // `.git` is a directory in a normal clone and a FILE in a git worktree —
    // existsSync catches both.
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Throw unless `dir` is a safe, disposable test directory: a path under the OS
 * temp dir, outside the repo and outside any git working tree. `label` names the
 * source (e.g. `'WORKSPACE_DIR'`) for the error message.
 */
export function assertSafeTestDir(label: string, dir: string | undefined | null): void {
  if (!dir || !dir.trim()) {
    throw new Error(
      `[test-guard] ${label} is empty — refusing to run the test suite. ` +
        `An unset ${label} defaults to a REAL path and the suite deletes it recursively (issue #1563).`
    );
  }

  const resolved = realpathNearest(dir);
  const tmpRoot = realpathNearest(os.tmpdir());

  // (1) Catch-all: a safe test dir MUST live under the OS temp dir. This alone
  //     rejects every real path (the repo, worktrees, ~/claude-workspace, ~/.portable).
  if (!isInside(resolved, tmpRoot)) {
    throw new Error(
      `[test-guard] ${label} resolves OUTSIDE the OS temp dir and the test suite deletes it ` +
        `recursively — refusing to run (issue #1563).\n` +
        `  ${label}   = ${dir}\n  resolved  = ${resolved}\n  os.tmpdir = ${tmpRoot}`
    );
  }
  // (2) Never inside the repo (guards a pathological TMPDIR pointed inside the checkout).
  if (isInside(resolved, REPO_ROOT)) {
    throw new Error(
      `[test-guard] ${label} resolves INSIDE the repo (${REPO_ROOT}) — refusing to run (issue #1563).\n` +
        `  ${label} = ${dir}\n  resolved = ${resolved}`
    );
  }
  // (3) Never inside any git working tree.
  const gitRoot = enclosingGitWorkingTree(resolved);
  if (gitRoot) {
    throw new Error(
      `[test-guard] ${label} resolves inside a git working tree (${gitRoot}) — refusing to run (issue #1563).\n` +
        `  ${label} = ${dir}\n  resolved = ${resolved}`
    );
  }
}
