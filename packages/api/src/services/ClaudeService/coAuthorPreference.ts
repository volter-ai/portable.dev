/**
 * AI co-author trailer preference resolution.
 *
 * The Claude Agent SDK appends an AI `Co-Authored-By:` trailer to every commit it
 * makes (its `includeCoAuthoredBy` option defaults to `true`). Some users don't want
 * an AI co-author in their git history — company policy, a clean `git blame`,
 * open-source contribution norms, or personal preference — so we add a per-user
 * toggle persisted in `user_themes.theme_config.userSettings` (`includeCoAuthoredBy`,
 * written by the client via `POST /api/user-settings`). This resolver reads that
 * preference at session start so `ExecutionHandler` can pass it straight to the SDK
 * `query()` options.
 *
 * Resolved here (per session, on the PC) rather than baked into the JWT for the
 * same reason as the git AUTHOR identity: the production JWT is minted by the
 * gateway BEFORE the user has any settings, and resolving here makes the behaviour
 * identical across auth paths (Clerk vs. direct GitHub OAuth) and clients (native
 * mobile). This is the separate, sibling concern to [[gitAuthorIdentity]]:
 * that one controls who the commit is AUTHORED by; this one controls whether an AI
 * CO-AUTHOR trailer is appended.
 *
 * The resolved boolean ALSO gates the Portable brand co-author hook ([[coAuthorHook]]):
 * when ON, `ExecutionHandler` installs a `prepare-commit-msg` hook that adds a SECOND
 * trailer (`Co-Authored-By: Portable Dev <portable@volter.ai>`) alongside the SDK's
 * Claude one; when OFF, both are absent (this resolver disables the SDK trailer, the
 * hook is removed) — so an opted-out commit carries no co-author at all.
 *
 * Default is ALWAYS to INCLUDE the trailer (the SDK default — behaviour unchanged for
 * everyone who never touched the toggle). Only an explicit stored `false` disables it.
 * NEVER throws: any read failure resolves to `true` (the safe, no-regression default).
 */

/**
 * Minimal structural surface of the DB adapter used to read user settings. Kept
 * structural (no `DbAdapter` import) so the resolver stays decoupled and
 * unit-testable with a plain fake object — `ChatService.dbAdapter` satisfies it.
 */
export interface UserSettingsReader {
  getTheme(userEmail: string, authToken?: string): Promise<Record<string, unknown> | null>;
}

/**
 * Resolve whether the AI co-author trailer should be added to commits for this user.
 * Returns `true` (include) unless the user has explicitly stored `false`. Never
 * throws — any failure (no reader, no row, network/DB error) resolves to `true`.
 */
export async function resolveIncludeCoAuthoredBy(
  reader: UserSettingsReader | undefined,
  params: { userId: string; authToken?: string }
): Promise<boolean> {
  const { userId, authToken } = params;
  if (!reader) return true;

  try {
    const themeConfig = await reader.getTheme(userId, authToken);
    const userSettings = (themeConfig?.userSettings ?? null) as {
      includeCoAuthoredBy?: boolean;
    } | null;

    // Only an explicit `false` disables the trailer; undefined/true → include.
    return userSettings?.includeCoAuthoredBy === false ? false : true;
  } catch (error) {
    console.warn(
      `[coAuthorPreference] [${userId}] Failed to read co-author preference; ` +
        `defaulting to include the AI co-author:`,
      error instanceof Error ? error.message : String(error)
    );
    return true;
  }
}
