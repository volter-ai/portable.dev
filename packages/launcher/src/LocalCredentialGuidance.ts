import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * Local credential boot guidance.
 *
 * The api owns the local Anthropic + GitHub device-flows in-process
 * (`LocalAiCredentialsService` / `LocalGitHubAuthService`). The launcher does
 * NOT duplicate that device-flow logic — it just surfaces, during BOOT (before
 * Ink owns the terminal), whether each credential is already configured and, if
 * not, prints clear terminal guidance so the user knows to authenticate. It
 * deliberately does NOT hard-block: an API-key-based Anthropic credential or an
 * env-provided GitHub token is enough, and the user can also link GitHub later
 * from the app, so a missing credential is a WARNING, not a fatal error.
 *
 * The checks mirror the api's resolvers exactly (same env vars + the same
 * namespaced `LocalSecretStore` keys), reusing the single store instance the
 * launcher already has open.
 */

/** LocalSecretStore key the api persists the Claude OAuth token under. */
export const CLAUDE_OAUTH_TOKEN_KEY = 'ai-credentials:claude-oauth-token';
/** LocalSecretStore key the api persists the GitHub device-flow token under. */
export const GITHUB_TOKEN_KEY = 'github-oauth:token';

export interface CredentialStatus {
  /** True when a Claude OAuth token OR ANTHROPIC_API_KEY is configured. */
  anthropicConfigured: boolean;
  /** Which Anthropic credential resolved (for the log line). */
  anthropicMode: 'claude-oauth' | 'api-key' | 'none';
  /** True when a GitHub token is stored OR provided via env. */
  githubConfigured: boolean;
}

/**
 * Resolve which local credentials are present, mirroring the api's resolvers:
 *   - Anthropic: a persisted Claude OAuth token (preferred) → `ANTHROPIC_API_KEY`.
 *   - GitHub: a persisted device-flow token → `GITHUB_TOKEN`/`GITHUB_OAUTH_TOKEN` env.
 */
export function resolveCredentialStatus(
  store: LocalSecretStore,
  env: NodeJS.ProcessEnv = process.env
): CredentialStatus {
  const hasClaudeOAuth = !!store.get(CLAUDE_OAUTH_TOKEN_KEY)?.trim();
  const hasApiKey = !!env.ANTHROPIC_API_KEY?.trim();
  const anthropicMode: CredentialStatus['anthropicMode'] = hasClaudeOAuth
    ? 'claude-oauth'
    : hasApiKey
      ? 'api-key'
      : 'none';

  const hasGithubToken =
    !!store.get(GITHUB_TOKEN_KEY)?.trim() ||
    !!env.GITHUB_TOKEN?.trim() ||
    !!env.GITHUB_OAUTH_TOKEN?.trim();

  return {
    anthropicConfigured: hasClaudeOAuth || hasApiKey,
    anthropicMode,
    githubConfigured: hasGithubToken,
  };
}

/**
 * Print boot-time credential guidance to the terminal (plain logs, before Ink).
 * Never throws and never hard-blocks — a missing credential is a clear WARNING
 * the user can resolve via the app / their own config.
 */
export function reportCredentialGuidance(
  store: LocalSecretStore,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env
): CredentialStatus {
  const status = resolveCredentialStatus(store, env);

  if (status.anthropicConfigured) {
    log(`[launcher] ✓ Anthropic credential ready (${status.anthropicMode})`);
  } else {
    log(
      '[launcher] ⚠ No Anthropic credential configured — Claude calls will fail until you set one.'
    );
    log('[launcher]   Pick ONE:');
    log(
      '[launcher]     (a) Claude subscription: run `claude setup-token` and store the OAuth token, or'
    );
    log('[launcher]     (b) Set ANTHROPIC_API_KEY=sk-ant-… in your local .env, then restart.');
  }

  if (status.githubConfigured) {
    log('[launcher] ✓ GitHub access ready');
  } else {
    log(
      '[launcher] ⚠ GitHub not connected yet — connect it in the Portable app (Settings → GitHub),'
    );
    log('[launcher]   or run the GitHub device flow locally (GITHUB_OAUTH_CLIENT_ID required).');
  }

  return status;
}
