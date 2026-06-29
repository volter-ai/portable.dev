/**
 * Shared best-effort GitHub-login fetch for the launcher.
 *
 * Both launcher credential paths — the device-flow LOGIN
 * ({@link ./InteractiveCredentialLogin}) and the OS-credential DISCOVERY
 * ({@link ./CredentialResolver}) — must persist the GitHub `.login` into the
 * shared `github-oauth:token` store record so the launcher's JWT-username
 * fallback (`readStoredGitHubLogin`) and the api's commit-time resolver author
 * `portable` commits as the GitHub user instead of `os.hostname()`.
 *
 * This mirrors `LocalGitHubAuthService.fetchLogin` (`packages/api`) but is
 * self-contained — the launcher CANNOT import `@vgit2/api`. A failed / non-2xx
 * fetch resolves `undefined` and NEVER throws, so a missing login degrades to
 * the hostname behavior in `resolvePairingIdentity`.
 */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** GitHub REST endpoint for the authenticated user (its `.login` is the handle). */
export const GITHUB_USER_URL = 'https://api.github.com/user';

/**
 * Best-effort resolve the GitHub login (`.login`) for a freshly granted token.
 * `GET https://api.github.com/user` with the standard headers; a non-2xx
 * response, a parse failure, or any thrown error all resolve `undefined`.
 */
export async function fetchGitHubLogin(
  token: string,
  fetchImpl: FetchImpl
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'portable-launcher',
      },
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { login?: unknown };
    const login = typeof data.login === 'string' ? data.login.trim() : '';
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}
