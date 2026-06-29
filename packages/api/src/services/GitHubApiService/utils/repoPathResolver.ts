/**
 * repoPathResolver (rev9 F1 / D27) — resolve a GitHub `owner`/`repo` to its REAL
 * on-disk path so every repo READ surface (file viewer, PR local branch, git
 * status/diff, quick actions) honors a FLAT clone (`<workspace>/<dir>` whose remote is
 * owner/repo, dir name irrelevant), not only the canonical two-level
 * `<workspace>/<owner>/<repo>` layout. Falls back to the canonical two-level path when
 * discovery is unavailable — IDENTICAL to the old `path.join(getUserWorkspaceDir,
 * owner, repo)` for a two-level clone, so wiring this in is a no-op for the default.
 */
import path from 'path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';

interface RepoPathResolver {
  resolveLocalRepoPath?: (userId: string, owner: string, repo: string) => Promise<string>;
}

export async function resolveRepoLocalPath(
  gitLocalService: RepoPathResolver | undefined,
  userId: string,
  owner: string,
  repo: string
): Promise<string> {
  if (gitLocalService?.resolveLocalRepoPath) {
    return gitLocalService.resolveLocalRepoPath(userId, owner, repo);
  }
  return path.join(getUserWorkspaceDir(userId), owner, repo);
}
