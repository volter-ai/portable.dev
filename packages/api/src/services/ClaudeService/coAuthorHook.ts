/**
 * Portable co-author trailer hook.
 *
 * The Claude Agent SDK stamps every commit it makes with its OWN
 * `Co-Authored-By: Claude <noreply@anthropic.com>` trailer (gated by the per-user
 * toggle — see [[coAuthorPreference]]). Portable also wants ITS OWN brand
 * credited on those commits: `Co-Authored-By: Portable Dev <portable@volter.ai>`
 * (the github.com/portable-one account). The SDK exposes only a boolean
 * `includeCoAuthoredBy` — there is NO option for a custom co-author string — so we add
 * the Portable trailer deterministically via a `prepare-commit-msg`
 * git hook that appends it with `git interpret-trailers`. `interpret-trailers` is
 * idempotent (`--if-exists addIfDifferent`) and places the new trailer in the trailer
 * block ALONGSIDE the SDK's Claude trailer — so a commit ends up with BOTH credits.
 *
 * Gated by the SAME toggle, resolved in `ExecutionHandler`:
 *   - ON (default) → install the hook (commit carries Claude + Portable).
 *   - OFF (opt-out) → remove OUR hook; the SDK's Claude trailer is already
 *     disabled by `ExecutionHandler`, so an opted-out commit carries NO co-author at all.
 *
 * Installed per repo at git-config time, right next to where `git config user.name`
 * is set (see [[gitAuthorIdentity]]). The hook is written to the repo's
 * EFFECTIVE hooks dir (`git rev-parse --git-path hooks`, so it honors a `core.hooksPath`
 * set by husky/lefthook/org templates — not just `.git/hooks`). It NEVER throws — commit
 * attribution is best-effort and must never break a Claude session; a hook write
 * failure just means the Portable trailer isn't added. A pre-existing, NON-Portable
 * `prepare-commit-msg` hook is never clobbered (matched by the marker comment).
 *
 * NB: GitHub links a co-author to an account by the trailer EMAIL, so the commit links
 * to github.com/portable-one only while `portable@volter.ai` is a verified email on
 * that account. The display name is cosmetic.
 */

import { execFileSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';

/** Display name of the Portable co-author. */
export const PORTABLE_COAUTHOR_NAME = 'Portable Dev';
/** Email of the Portable co-author (must be verified on github.com/portable-one to link). */
export const PORTABLE_COAUTHOR_EMAIL = 'portable@volter.ai';
/** The full `Co-Authored-By:` trailer line appended to commits. */
export const PORTABLE_COAUTHOR_TRAILER = `Co-Authored-By: ${PORTABLE_COAUTHOR_NAME} <${PORTABLE_COAUTHOR_EMAIL}>`;

/**
 * Marker comment identifying a Portable-managed hook. Matched by PREFIX so a future
 * hook revision (`… v2`) is still recognized as ours (and overwritable / removable).
 */
const HOOK_MARKER_PREFIX = '# portable-coauthor-hook';
const HOOK_MARKER = `${HOOK_MARKER_PREFIX} v1`;

/**
 * Minimal structural surface of `fs` used here. Kept structural (no `fs` import in the
 * signature) so the installer is unit-testable with a plain fake or a real temp dir.
 */
export interface CoAuthorHookFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, encoding: 'utf8'): string;
  writeFileSync(p: string, data: string, options?: { mode?: number }): void;
  chmodSync(p: string, mode: number): void;
  rmSync(p: string, options?: { force?: boolean }): void;
  mkdirSync(p: string, options?: { recursive?: boolean }): void;
}

const defaultFs: CoAuthorHookFs = {
  existsSync: (p) => fsSync.existsSync(p),
  readFileSync: (p, encoding) => fsSync.readFileSync(p, encoding),
  writeFileSync: (p, data, options) => fsSync.writeFileSync(p, data, options),
  chmodSync: (p, mode) => fsSync.chmodSync(p, mode),
  rmSync: (p, options) => fsSync.rmSync(p, options),
  mkdirSync: (p, options) => {
    fsSync.mkdirSync(p, options);
  },
};

/**
 * The POSIX-sh `prepare-commit-msg` hook body. It appends the Portable trailer with
 * `git interpret-trailers --if-exists addIfDifferent` (idempotent: no duplicate on
 * amend/rerun; coexists with an existing Claude trailer). It exits 0 on any failure so
 * a commit is NEVER blocked by attribution, and no-ops when given no message file.
 *
 * The trailer value contains only spaces, `<`, `>`, `@`, `.` and letters — no shell
 * metacharacters — so embedding it inside double quotes is safe (`<`/`>` lose their
 * redirection meaning inside quotes).
 */
export function buildPortableCoAuthorHookScript(): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Managed by Portable — appends the Portable co-author trailer to commits.',
    '# Regenerated each Claude session; do not edit.',
    'msg_file="$1"',
    '[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0',
    `git interpret-trailers --if-exists addIfDifferent --in-place --trailer "${PORTABLE_COAUTHOR_TRAILER}" "$msg_file" 2>/dev/null || true`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * True if `content` is a Portable-managed hook (safe to overwrite/remove). Anchored to
 * the generator's structure (`#!/bin/sh` on line 1, the marker on line 2), so a FOREIGN
 * hook that merely MENTIONS the marker string elsewhere (a comment, an `echo`) is not
 * misclassified as ours and clobbered. `startsWith(PREFIX)` still recognizes a future
 * `… v2` revision.
 */
function isPortableHook(content: string): boolean {
  return content.split('\n')[1]?.startsWith(HOOK_MARKER_PREFIX) ?? false;
}

/**
 * Pure mapping from `git rev-parse --git-path hooks` output to an absolute hooks dir.
 * git prints the path relative to the repo (default `.git/hooks`, or a relative
 * `core.hooksPath` like `.husky`) or absolute (an absolute `core.hooksPath`); empty /
 * blank output falls back to the conventional `<repoPath>/.git/hooks`. Extracted from
 * the subprocess so the path logic is unit-testable without spawning git.
 */
export function hooksDirFromGitOutput(repoPath: string, gitPathHooksOutput: string): string {
  const out = gitPathHooksOutput.trim();
  if (out) return path.isAbsolute(out) ? out : path.join(repoPath, out);
  return path.join(repoPath, '.git', 'hooks');
}

/**
 * Resolve the repo's EFFECTIVE hooks directory — honors `core.hooksPath` (husky /
 * lefthook / org templates), so the hook lands where git will actually run it rather
 * than an ignored `.git/hooks`. Falls back to `<repoPath>/.git/hooks` when `repoPath`
 * isn't a git repo or `git` is unavailable. Never throws.
 */
function defaultResolveHooksDir(repoPath: string): string {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8',
    });
    return hooksDirFromGitOutput(repoPath, out);
  } catch {
    // not a git repo / git unavailable — use the conventional location.
    return path.join(repoPath, '.git', 'hooks');
  }
}

/** Injectable seams for `syncPortableCoAuthorHook` (all optional; defaults hit real fs/git). */
export interface CoAuthorHookDeps {
  fs?: CoAuthorHookFs;
  logger?: Pick<Console, 'warn'>;
  /**
   * Resolve the repo's effective hooks dir (honors `core.hooksPath`). Test seam;
   * defaults to `git rev-parse --git-path hooks` with a `<repoPath>/.git/hooks` fallback.
   */
  resolveHooksDir?: (repoPath: string) => string;
}

/**
 * Reconcile the Portable co-author `prepare-commit-msg` hook for `repoPath` against the
 * toggle: install it when `enabled`, remove our managed hook when not. Never
 * throws; a NON-Portable existing hook is left untouched (and the install is skipped).
 *
 * @param repoPath  the repository working tree (its effective hooks dir is targeted)
 * @param enabled   the resolved `includeCoAuthoredBy` preference
 */
export function syncPortableCoAuthorHook(
  repoPath: string,
  enabled: boolean,
  deps: CoAuthorHookDeps = {}
): void {
  const fs = deps.fs ?? defaultFs;
  const logger = deps.logger ?? console;
  const resolveHooksDir = deps.resolveHooksDir ?? defaultResolveHooksDir;

  try {
    const hooksDir = resolveHooksDir(repoPath);
    const hookPath = path.join(hooksDir, 'prepare-commit-msg');
    const exists = fs.existsSync(hookPath);
    const existingIsForeign = exists && !isPortableHook(fs.readFileSync(hookPath, 'utf8'));

    // Never clobber or delete a user-authored hook.
    if (existingIsForeign) {
      logger.warn(
        `[coAuthorHook] ${repoPath}: a non-Portable prepare-commit-msg hook already exists; ` +
          `leaving it untouched (Portable co-author trailer not ${enabled ? 'installed' : 'changed'}).`
      );
      return;
    }

    if (!enabled) {
      // opt-out: remove our hook so the commit carries no co-author trailer at all
      // (the SDK's Claude trailer is disabled separately by ExecutionHandler).
      if (exists) fs.rmSync(hookPath, { force: true });
      return;
    }

    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hookPath, buildPortableCoAuthorHookScript(), { mode: 0o755 });
    // writeFileSync's mode is masked by umask; force the executable bit explicitly
    // (git ignores a non-executable hook).
    fs.chmodSync(hookPath, 0o755);
  } catch (error) {
    logger.warn(
      `[coAuthorHook] ${repoPath}: failed to ${enabled ? 'install' : 'remove'} the Portable ` +
        `co-author hook; commits proceed without the Portable trailer:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}
