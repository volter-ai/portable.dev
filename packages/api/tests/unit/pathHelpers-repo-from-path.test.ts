/**
 * rev9 Feature 1 / D27 — getRepoFromPath generalized to be WORKSPACE_DIR-relative.
 *
 * The old helper anchored only on the literal `claude-workspace` segment, so a
 * custom WORKSPACE_DIR returned null and silently broke auto-clone + new-session
 * repo resolution. The generalized helper resolves a two-level `<ws>/<owner>/<repo>`
 * path relative to the configured workspace root, returns null for a FLAT clone
 * (owner not in the path), and keeps the legacy claude-workspace anchor as a fallback.
 */
import { describe, expect, it } from 'bun:test';

import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';

describe('getRepoFromPath (rev9 D27 — WORKSPACE_DIR-relative)', () => {
  it('extracts owner/repo for a two-level path under a custom WORKSPACE_DIR', () => {
    expect(getRepoFromPath('/Users/dev/code/octocat/hello', '/Users/dev/code')).toBe(
      'octocat/hello'
    );
  });

  it('returns null for a FLAT clone path (owner not derivable from the path)', () => {
    expect(getRepoFromPath('/Users/dev/code/myrepo', '/Users/dev/code')).toBeNull();
  });

  it('returns null for the workspace root itself', () => {
    expect(getRepoFromPath('/Users/dev/code', '/Users/dev/code')).toBeNull();
  });

  it('normalizes Windows backslashes', () => {
    expect(getRepoFromPath('C:\\ws\\octocat\\hello', 'C:\\ws')).toBe('octocat/hello');
  });

  it('falls back to the legacy claude-workspace anchor (two-level)', () => {
    expect(getRepoFromPath('/home/x/claude-workspace/octocat/hello', '/some/other/ws')).toBe(
      'octocat/hello'
    );
  });

  it('falls back to the legacy claude-workspace anchor (per-user email layout)', () => {
    expect(
      getRepoFromPath('/home/x/claude-workspace/local_host/octocat/hello', '/some/other/ws')
    ).toBe('octocat/hello');
  });

  it('does NOT mis-read a 3-segment legacy path under the default-style workspace root', () => {
    // <ws>/local_host/owner/repo has 3 relative segments → must NOT yield
    // `local_host/owner`; it falls through to the legacy anchor and resolves owner/repo.
    expect(
      getRepoFromPath(
        '/home/x/claude-workspace/local_host/octocat/hello',
        '/home/x/claude-workspace'
      )
    ).toBe('octocat/hello');
  });

  it('returns null for undefined / unmatched paths', () => {
    expect(getRepoFromPath(undefined)).toBeNull();
    expect(getRepoFromPath('/random/path/foo', '/some/ws')).toBeNull();
  });
});
