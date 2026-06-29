/**
 * projectKey — derive the stable key under which a chat's project remembers its
 * "last mode selected there" (the per-project sticky settings in `chatStore`).
 *
 * The key mirrors {@link groupChatsByProject}'s `projectOf` so a project resolves
 * to the SAME bucket whether keyed from a create-flow `owner/repo` or from an open
 * chat's `repo_path`: the GitHub `owner/repo` (lowercased) when known, else the
 * flat-clone disk basename (`name:<basename>`), else the workspace sentinel.
 *
 * Cross-surface alignment is best-effort (a flat clone created via `owner/repo`
 * but reopened by disk path can land on a different key); that is fine because
 * `setProjectChatSettings` ALSO updates the global last-used, so an unmatched
 * project still falls back to the most recent pick — never to best-practice.
 */

import { isWorkspaceChatTarget } from '@vgit2/shared/browserConstants';

import { getRepoBasename, getRepoFromPath } from '../home/homeHelpers';
import { WORKSPACE_PROJECT_KEY } from './groupChatsByProject';

export { WORKSPACE_PROJECT_KEY };

/** Project key for a create-flow target (`chat:create` owner/repo). */
export function projectKeyForOwnerRepo(owner: string, repo: string): string {
  if (isWorkspaceChatTarget(owner)) return WORKSPACE_PROJECT_KEY;
  return `${owner}/${repo}`.toLowerCase();
}

/** Project key for an existing chat, derived from its resolved `repo_path`. */
export function projectKeyFromRepoPath(repoPath?: string | null): string {
  const fullName = getRepoFromPath(repoPath ?? undefined);
  if (fullName) return fullName.toLowerCase();
  const basename = getRepoBasename(repoPath ?? undefined);
  if (basename) return `name:${basename.toLowerCase()}`;
  return WORKSPACE_PROJECT_KEY;
}
