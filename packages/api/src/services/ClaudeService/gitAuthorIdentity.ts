/**
 * Git author identity resolution.
 *
 * Portable commits used to be authored with the JWT `username`, which on the Clerk
 * auth path is the Clerk display name (or an email-derived handle), NOT the user's
 * GitHub login. That misattributed every commit in GitHub history — wrong name, no
 * avatar, no profile link, no contribution credit — while the legacy direct GitHub
 * OAuth path (which uses `user.login`) got it right, so the two auth paths disagreed.
 *
 * The fix resolves the author from the user's ACTIVE GitHub connection (the GitHub
 * `login`) whenever one exists. This is intentionally done at git-config time inside
 * the sandbox rather than at JWT-mint time, because:
 *   - the production native/web JWT is minted by the gateway BEFORE the user connects
 *     GitHub, so the login is simply not known yet at mint time; and
 *   - resolving here makes attribution identical regardless of which auth path
 *     (Clerk vs. direct GitHub OAuth) or client (native mobile)
 *     minted the JWT — satisfying the "consistent across paths" requirement.
 *
 * The `<login>@users.noreply.github.com` email is what links the commit back to the
 * GitHub account. When no GitHub connection exists yet, resolution falls back to the
 * JWT username so commits are never blocked and never attributed to "Claude".
 */

/**
 * Minimal structural surface of `ConnectionsService` used for author resolution.
 * Kept structural (no `ConnectionsService` import) so the resolver stays decoupled
 * and unit-testable with a plain fake object.
 */
export interface GitHubLoginResolver {
  getActiveGitHubConnection(
    userId: string,
    authToken?: string
  ): Promise<{ type: string; connection?: unknown } | null | undefined>;
  getConnectionAccountInfo(
    connection: unknown,
    options?: { forceRefresh?: boolean; authToken?: string }
  ): Promise<{ username?: string | null } | null | undefined>;
}

export interface GitAuthorIdentity {
  /** Author/committer name written to git config + `GIT_AUTHOR_NAME`. */
  name: string;
  /** Author/committer email (`<name>@users.noreply.github.com`). */
  email: string;
  /**
   * Where `name` came from: `'github'` = the user's active GitHub connection login
   * (the correct, link-back attribution), `'fallback'` = the JWT username (the PC
   * hostname on the launcher path). Callers MUST NOT clobber a repo's existing git
   * owner with a `'fallback'` identity — see {@link chooseGitIdentityToWrite}.
   */
  source: 'github' | 'fallback';
}

/** The GitHub no-reply email that links a commit to the `login` account. */
export function gitNoReplyEmail(username: string): string {
  return `${username}@users.noreply.github.com`;
}

/**
 * Resolve the GitHub `login` of the user's active GitHub connection, or `null` when
 * there is none / it can't be determined. NEVER throws — any failure (no connection,
 * network error, missing service) resolves to `null` so the caller falls back to the
 * JWT username. Both lookups are cache-backed in `ConnectionsService`
 * (`getActiveGitHubConnection` is memoized; `getConnectionAccountInfo` caches the
 * account info for 24h), so this does not hit GitHub on the hot path.
 */
export async function resolveGitHubLogin(
  connectionsService: GitHubLoginResolver | undefined,
  userId: string,
  authToken: string | undefined
): Promise<string | null> {
  if (!connectionsService) return null;

  try {
    const active = await connectionsService.getActiveGitHubConnection(userId, authToken);
    if (!active || active.type === 'none' || !active.connection) {
      return null;
    }

    const accountInfo = await connectionsService.getConnectionAccountInfo(active.connection, {
      authToken,
    });

    const login = accountInfo?.username?.trim();
    return login ? login : null;
  } catch (error) {
    console.warn(
      `[gitAuthorIdentity] [${userId}] Failed to resolve GitHub login for git author; ` +
        `falling back to JWT username:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Resolve the git author identity for commits: the GitHub `login` of the user's
 * active GitHub connection (preferred), else `fallbackUsername` (the JWT username).
 * The email is always the GitHub no-reply address for the resolved name.
 */
export async function resolveGitAuthorIdentity(
  connectionsService: GitHubLoginResolver | undefined,
  params: { userId: string; authToken?: string; fallbackUsername: string }
): Promise<GitAuthorIdentity> {
  const { userId, authToken, fallbackUsername } = params;
  const login = await resolveGitHubLogin(connectionsService, userId, authToken);
  const name = login ?? fallbackUsername;
  return { name, email: gitNoReplyEmail(name), source: login ? 'github' : 'fallback' };
}

/** A repo's effective git identity (its local override OR its inherited global). */
export interface ExistingGitIdentity {
  name: string;
  email: string;
}

/**
 * Decide the identity for a repo's commits and WHETHER to write it into the repo's
 * `git config` — without ever clobbering the repo owner. A real GitHub login is
 * written (correct attribution); the `'fallback'` identity is written ONLY when the
 * repo has no identity of its own, otherwise the existing owner is kept. Pure.
 */
export function chooseGitIdentityToWrite(
  resolved: GitAuthorIdentity,
  existing: ExistingGitIdentity | null
): { name: string; email: string; write: boolean } {
  if (resolved.source === 'github') {
    return { name: resolved.name, email: resolved.email, write: true };
  }
  if (existing) {
    return { name: existing.name, email: existing.email, write: false };
  }
  return { name: resolved.name, email: resolved.email, write: true };
}
