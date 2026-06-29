/**
 * coAuthorHook Unit Tests.
 *
 * Portable wants its own brand credited on agent commits alongside the SDK's Claude
 * trailer: `Co-Authored-By: Portable Dev <portable@volter.ai>` (github.com/portable-one).
 * The SDK can't emit a custom co-author, so we install a `prepare-commit-msg` git hook
 * that appends the trailer with `git interpret-trailers`.
 *
 * Behaviour under test:
 * - enabled  → an executable, Portable-marked hook is written under `.git/hooks/`
 * - the written hook actually appends the Portable trailer ALONGSIDE the Claude one,
 *   is idempotent on re-run (amend), and works on a bare (Claude-less) message
 * - disabled → our hook is removed (so opt-out = no co-author at all)
 * - a NON-Portable existing hook is NEVER clobbered or deleted (install + remove)
 * - never throws on an unwritable repo path (warns instead)
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, describe, expect, it, spyOn } from 'bun:test';

import {
  PORTABLE_COAUTHOR_TRAILER,
  buildPortableCoAuthorHookScript,
  hooksDirFromGitOutput,
  syncPortableCoAuthorHook,
} from '../../../src/services/ClaudeService/coAuthorHook';

const PORTABLE_TRAILER = 'Co-Authored-By: Portable Dev <portable@volter.ai>';
const CLAUDE_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

const tmpDirs: string[] = [];
function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcoauthor-'));
  tmpDirs.push(dir);
  return dir;
}
function hookPathFor(repo: string): string {
  return path.join(repo, '.git', 'hooks', 'prepare-commit-msg');
}
/** Run the installed hook the way git does: `sh <hook> <commit-msg-file>`. */
function runHook(hook: string, msgFile: string): void {
  execFileSync('sh', [hook, msgFile], { stdio: 'ignore' });
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('coAuthorHook', () => {
  it('exposes the exact Portable trailer string', () => {
    expect(PORTABLE_COAUTHOR_TRAILER).toBe(PORTABLE_TRAILER);
  });

  it('builds a hook script with shebang, marker, and the interpret-trailers append', () => {
    const script = buildPortableCoAuthorHookScript();
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain('portable-coauthor-hook');
    expect(script).toContain('git interpret-trailers');
    expect(script).toContain(PORTABLE_TRAILER);
  });

  describe('syncPortableCoAuthorHook — enabled', () => {
    it('writes an executable hook under .git/hooks/', () => {
      const repo = makeRepoDir();

      syncPortableCoAuthorHook(repo, true);

      const hook = hookPathFor(repo);
      expect(fs.existsSync(hook)).toBe(true);
      // executable bit set (git ignores a non-executable hook)
      expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    });

    it('the hook appends the Portable trailer ALONGSIDE the Claude one', () => {
      const repo = makeRepoDir();
      syncPortableCoAuthorHook(repo, true);
      const hook = hookPathFor(repo);

      const msg = path.join(repo, 'COMMIT_EDITMSG');
      fs.writeFileSync(msg, `subject\n\nbody\n\n${CLAUDE_TRAILER}\n`);

      runHook(hook, msg);

      const out = fs.readFileSync(msg, 'utf8');
      expect(out).toContain(CLAUDE_TRAILER); // SDK trailer preserved
      expect(out).toContain(PORTABLE_TRAILER); // Portable trailer added
    });

    it('is idempotent — re-running (amend) never duplicates the Portable trailer', () => {
      const repo = makeRepoDir();
      syncPortableCoAuthorHook(repo, true);
      const hook = hookPathFor(repo);

      const msg = path.join(repo, 'COMMIT_EDITMSG');
      fs.writeFileSync(msg, `subject\n\n${CLAUDE_TRAILER}\n`);

      runHook(hook, msg);
      runHook(hook, msg);

      const out = fs.readFileSync(msg, 'utf8');
      expect(out.match(/Portable Dev/g)?.length).toBe(1);
    });

    it('adds the Portable trailer to a bare (Claude-less) message too', () => {
      const repo = makeRepoDir();
      syncPortableCoAuthorHook(repo, true);
      const hook = hookPathFor(repo);

      const msg = path.join(repo, 'COMMIT_EDITMSG');
      fs.writeFileSync(msg, 'just a subject line\n');

      runHook(hook, msg);

      expect(fs.readFileSync(msg, 'utf8')).toContain(PORTABLE_TRAILER);
    });

    it('re-installing over our own hook is a no-op overwrite (still one hook)', () => {
      const repo = makeRepoDir();
      syncPortableCoAuthorHook(repo, true);
      syncPortableCoAuthorHook(repo, true);

      expect(fs.existsSync(hookPathFor(repo))).toBe(true);
    });
  });

  describe('syncPortableCoAuthorHook — disabled (opt-out)', () => {
    it('removes a previously-installed Portable hook', () => {
      const repo = makeRepoDir();
      syncPortableCoAuthorHook(repo, true);
      expect(fs.existsSync(hookPathFor(repo))).toBe(true);

      syncPortableCoAuthorHook(repo, false);

      expect(fs.existsSync(hookPathFor(repo))).toBe(false);
    });

    it('is a no-op when there is no hook to remove', () => {
      const repo = makeRepoDir();
      // .git/hooks does not exist yet
      syncPortableCoAuthorHook(repo, false);
      expect(fs.existsSync(hookPathFor(repo))).toBe(false);
    });
  });

  describe('foreign hooks are never touched', () => {
    function writeForeignHook(repo: string): string {
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hook = path.join(hooksDir, 'prepare-commit-msg');
      fs.writeFileSync(hook, '#!/bin/sh\n# a user-authored hook\nexit 0\n', { mode: 0o755 });
      return hook;
    }

    it('enabled: does NOT clobber a non-Portable hook (and warns)', () => {
      const repo = makeRepoDir();
      const hook = writeForeignHook(repo);
      const before = fs.readFileSync(hook, 'utf8');
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      syncPortableCoAuthorHook(repo, true);

      expect(fs.readFileSync(hook, 'utf8')).toBe(before); // untouched
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('disabled: does NOT delete a non-Portable hook (and warns)', () => {
      const repo = makeRepoDir();
      const hook = writeForeignHook(repo);
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      syncPortableCoAuthorHook(repo, false);

      expect(fs.existsSync(hook)).toBe(true); // not deleted
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does NOT misclassify a foreign hook that merely MENTIONS the marker string', () => {
      const repo = makeRepoDir();
      const hooksDir = path.join(repo, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hook = path.join(hooksDir, 'prepare-commit-msg');
      // The marker string appears, but NOT as the structural line-2 marker.
      fs.writeFileSync(
        hook,
        '#!/bin/sh\n# a user hook\necho "# portable-coauthor-hook (just a log line)"\nexit 0\n',
        { mode: 0o755 }
      );
      const before = fs.readFileSync(hook, 'utf8');
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      syncPortableCoAuthorHook(repo, true);

      expect(fs.readFileSync(hook, 'utf8')).toBe(before); // treated as foreign → untouched
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('effective hooks dir (honors core.hooksPath)', () => {
    // The path-mapping logic of the real `git rev-parse --git-path hooks` resolver,
    // tested as a pure function (the live git spawn is trivial; a subprocess-based test
    // is environment-fragile).
    it('default .git/hooks output → <repo>/.git/hooks', () => {
      expect(hooksDirFromGitOutput('/r', '.git/hooks\n')).toBe(path.join('/r', '.git', 'hooks'));
    });
    it('relative core.hooksPath (husky/lefthook) → <repo>/<dir>', () => {
      expect(hooksDirFromGitOutput('/r', '.husky\n')).toBe(path.join('/r', '.husky'));
    });
    it('absolute core.hooksPath → used verbatim', () => {
      expect(hooksDirFromGitOutput('/r', '/abs/hooks\n')).toBe('/abs/hooks');
    });
    it('empty/blank output → conventional .git/hooks fallback', () => {
      expect(hooksDirFromGitOutput('/r', '')).toBe(path.join('/r', '.git', 'hooks'));
      expect(hooksDirFromGitOutput('/r', '   \n')).toBe(path.join('/r', '.git', 'hooks'));
    });

    it('installs into the dir returned by an injected resolveHooksDir seam', () => {
      const repo = makeRepoDir();
      const customDir = path.join(repo, 'custom-hooks');

      syncPortableCoAuthorHook(repo, true, { resolveHooksDir: () => customDir });

      expect(fs.existsSync(path.join(customDir, 'prepare-commit-msg'))).toBe(true);
      // NOT the default location, proving the resolver decides where it lands.
      expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
    });
  });

  it('never throws when the repo path is unwritable (warns instead)', () => {
    // repoPath under a regular FILE → mkdir of .git/hooks fails with ENOTDIR.
    const fileParent = path.join(makeRepoDir(), 'a-file');
    fs.writeFileSync(fileParent, 'x');
    const badRepo = path.join(fileParent, 'nested');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => syncPortableCoAuthorHook(badRepo, true)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
