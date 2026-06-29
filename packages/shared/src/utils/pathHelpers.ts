// NOTE: this module must NOT import from '../constants' — that module pulls in the
// Node standard library (fs/os/crypto/dotenv), and `getRepoFromPath` is consumed by the
// React Native mobile app (`packages/mobile`), whose Metro bundler cannot bundle Node
// builtins (it fails with `You attempted to import the Node standard library module "fs"`).
// The WORKSPACE_DIR-relative resolution is therefore OPT-IN via the `workspaceDir` arg:
// BACKEND callers pass their resolved workspace root explicitly (`getUserWorkspaceDir` /
// `WORKSPACE_DIR` from '../constants'), while the mobile app passes nothing and relies on
// the legacy `claude-workspace` anchor fallback below.

const RESERVED_OWNER_SEGMENTS = ['workspace', 'claude-workspace', 'vgit'];

/** Normalize backslashes → forward slashes and strip trailing slashes. */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Extract `owner/repo` from a repository path.
 *
 * portable's workspace root is operator-configurable (`WORKSPACE_DIR`),
 * so the slug is resolved RELATIVE to the configured workspace root first — the old
 * hard-coded `claude-workspace` segment anchor only resolved paths under the default
 * `~/claude-workspace` and returned `null` for any custom `WORKSPACE_DIR`, silently
 * breaking auto-clone + new-session repo resolution. The legacy anchor is kept as a
 * fallback so paths persisted by older installs still resolve.
 *
 * Supported layouts (two-level, portable-cloned):
 *   - `<WORKSPACE_DIR>/{owner}/{repo}`
 *   - legacy `…/claude-workspace/{email}/{owner}/{repo}` and `…/claude-workspace/{owner}/{repo}`
 *
 * A FLAT clone (`<WORKSPACE_DIR>/{repo}` with no owner in the path) returns `null` —
 * the owner is not derivable from the path (it comes from the git remote during
 * discovery), and a flat repo always exists on disk so the callers that use this
 * helper (auto-clone of a MISSING dir, new-session reconstruction) never need it.
 *
 * @param filePath - File system path
 * @param workspaceDir - Workspace root to resolve against. Defaults to `''` (no
 *   WORKSPACE_DIR-relative resolution → legacy `claude-workspace` anchor only).
 *   BACKEND callers should pass their resolved workspace root (`getUserWorkspaceDir` /
 *   `WORKSPACE_DIR`); the mobile app omits it (see the module note above).
 * @returns Repository name as "owner/repo" or null if not derivable from the path
 */
export function getRepoFromPath(filePath?: string, workspaceDir: string = ''): string | null {
  if (!filePath) return null;
  const normalizedPath = normalizeSlashes(filePath);

  // 1) WORKSPACE_DIR-relative: strip the configured workspace root; EXACTLY
  //    two remaining segments are `{owner}/{repo}` — the two-level (portable-cloned)
  //    checkout that lives directly under the workspace root. We require exactly two
  //    so an OLDER per-user-layered path (`<default-workspace>/{email}/{owner}/{repo}`,
  //    three segments) falls through to the legacy anchor below and resolves correctly,
  //    rather than mis-reading `{email}/{owner}`. A single remaining segment is a FLAT
  //    clone (owner not derivable from the path) → falls through to null.
  const normWs = normalizeSlashes(workspaceDir);
  if (normWs && normalizedPath.startsWith(normWs + '/')) {
    const rel = normalizedPath
      .slice(normWs.length)
      .split('/')
      .filter((s) => s && s !== '~');
    if (rel.length === 2) {
      const [pathOwner, pathRepo] = rel;
      if (pathOwner && pathRepo && !RESERVED_OWNER_SEGMENTS.includes(pathOwner)) {
        return `${pathOwner}/${pathRepo}`;
      }
    }
  }

  // 2) Legacy fallback: anchor on the literal `claude-workspace` segment so paths
  //    persisted by older installs (default workspace) still resolve.
  const segments = normalizedPath.split('/').filter((s) => s && s !== '~');
  const workspaceIdx = segments.indexOf('claude-workspace');
  if (workspaceIdx === -1) return null;

  // Try with email (4 segments): claude-workspace/{email}/{owner}/{repo}
  if (segments.length > workspaceIdx + 3) {
    const pathOwner = segments[workspaceIdx + 2];
    const pathRepo = segments[workspaceIdx + 3];
    if (pathOwner && pathRepo && !RESERVED_OWNER_SEGMENTS.includes(pathOwner)) {
      return `${pathOwner}/${pathRepo}`;
    }
  }

  // Fallback: try without email (2 segments): claude-workspace/{owner}/{repo}
  if (segments.length > workspaceIdx + 2) {
    const pathOwner = segments[workspaceIdx + 1];
    const pathRepo = segments[workspaceIdx + 2];
    if (pathOwner && pathRepo && !RESERVED_OWNER_SEGMENTS.includes(pathOwner)) {
      return `${pathOwner}/${pathRepo}`;
    }
  }

  return null;
}
