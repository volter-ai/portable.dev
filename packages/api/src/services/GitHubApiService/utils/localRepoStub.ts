/**
 * localRepoStub — a minimal GitHub-repo-shaped object for a locally-present repo that
 * GitHub doesn't (or can't) return.
 *
 * Two cases need it: (1) a `portable link`'d repo with NO GitHub remote gets the
 * synthetic `local/<name>` full name (`LOCAL_PLACEHOLDER_OWNER`), which can NEVER resolve
 * via `octokit.repos.get` (→ 404); (2) a real repo whose remote was deleted/renamed.
 * In both, the repo IS on disk, so the repos LIST (`RepoHandler.fetchReposWithLocalStatus`)
 * and the repo DETAIL (`GitHubApiService.handleGetRepo`) synthesize this stub and run it
 * through the SAME local enrichment instead of failing — otherwise the mobile repo page
 * shows "COULDN'T LOAD THE REPOSITORY".
 */

/** Owner placeholder for a locally-present repo with no resolvable GitHub remote
 *  (mirrors `UserHandler`/`GitLocalService` `LOCAL_PLACEHOLDER_OWNER`). */
export const LOCAL_PLACEHOLDER_OWNER = 'local';

/** Stable non-colliding id for a synthesized local-repo stub (negative so it can
 *  never clash with a real GitHub numeric id). */
export function stubRepoId(fullName: string): number {
  let h = 0;
  for (let i = 0; i < fullName.length; i++) h = (h * 31 + fullName.charCodeAt(i)) | 0;
  return -(Math.abs(h) || 1);
}

/**
 * A minimal GitHub-repo-shaped stub for a locally-present repo. owner.type defaults to
 * 'User' — irrelevant to the owner filter, which always exempts local repos.
 */
export function makeLocalRepoStub(ownerLogin: string, repoName: string): Record<string, unknown> {
  const fullName = `${ownerLogin}/${repoName}`;
  return {
    id: stubRepoId(fullName),
    name: repoName,
    full_name: fullName,
    owner: {
      login: ownerLogin,
      id: 0,
      type: 'User',
      avatar_url: '',
      html_url: `https://github.com/${ownerLogin}`,
    },
    private: false,
    description: null,
    html_url: `https://github.com/${fullName}`,
    homepage: null,
    fork: false,
    language: null,
    default_branch: 'main',
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    size: 0,
    created_at: null,
    updated_at: null,
    pushed_at: null,
  };
}
