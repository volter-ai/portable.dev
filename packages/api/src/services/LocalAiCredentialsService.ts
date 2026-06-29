import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * Local-first AI credentials
 *
 * In local-first mode the PC is the runtime, so the Anthropic credential is the
 * user's OWN — never a JWT claim, never a remote billing proxy. The user
 * picks ONE of two first-class modes:
 *
 *   (a) `claude-oauth` — a Claude *subscription* OAuth token (minted by Claude's own
 *       `claude setup-token` / OAuth flow). It is persisted in the local encrypted
 *       store and handed to the Claude Agent SDK / native CLI via `CLAUDE_CODE_OAUTH_TOKEN`.
 *   (b) `api-key` — a raw `ANTHROPIC_API_KEY` read from local config (`.env`/process env).
 *
 * Resolution prefers a configured Claude OAuth token, then falls back to
 * `ANTHROPIC_API_KEY`. `applyToProcessEnv()` wires the chosen credential into
 * `process.env` for the SDK and the spawned CLI child, and always clears any
 * `ANTHROPIC_BASE_URL` override so calls hit the default `https://api.anthropic.com`.
 *
 * The OAuth token shares the SAME `LocalSecretStore` as connection credentials
 * and the device-token signing secret, under a namespaced
 * key — reuse the single store instance from `server.ts`, don't build a second one.
 */

/** Default Anthropic API endpoint — used when no explicit base URL is configured. */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Namespaced LocalSecretStore key for the persisted Claude subscription OAuth token. */
export const CLAUDE_OAUTH_TOKEN_KEY = 'ai-credentials:claude-oauth-token';

export type LocalAiCredentialMode = 'claude-oauth' | 'api-key';

export type LocalAiCredential =
  | { mode: 'claude-oauth'; oauthToken: string }
  | { mode: 'api-key'; apiKey: string };

export class LocalAiCredentialsService {
  private readonly store: LocalSecretStore;

  constructor(store: LocalSecretStore) {
    this.store = store;
  }

  /** Returns the persisted Claude subscription OAuth token, or null if none is configured. */
  getClaudeOAuthToken(): string | null {
    return this.store.get(CLAUDE_OAUTH_TOKEN_KEY) ?? null;
  }

  /** True when a Claude subscription OAuth token is configured (mode (a)). */
  hasClaudeOAuthToken(): boolean {
    return this.store.has(CLAUDE_OAUTH_TOKEN_KEY);
  }

  /** Persist a Claude subscription OAuth token (encrypted at rest in the LocalSecretStore). */
  setClaudeOAuthToken(token: string): void {
    const trimmed = token?.trim();
    if (!trimmed) {
      throw new Error('[LocalAiCredentialsService] Refusing to store an empty Claude OAuth token');
    }
    this.store.set(CLAUDE_OAUTH_TOKEN_KEY, trimmed);
  }

  /** Remove the persisted Claude OAuth token (revert to ANTHROPIC_API_KEY mode if set). */
  clearClaudeOAuthToken(): boolean {
    return this.store.delete(CLAUDE_OAUTH_TOKEN_KEY);
  }

  /**
   * Resolve the active AI credential, preferring a configured Claude OAuth token over a
   * raw `ANTHROPIC_API_KEY`. Throws (with actionable guidance) when neither is configured.
   * The credential NEVER comes from a JWT claim.
   */
  resolveCredential(): LocalAiCredential {
    const oauthToken = this.getClaudeOAuthToken();
    if (oauthToken) {
      return { mode: 'claude-oauth', oauthToken };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      return { mode: 'api-key', apiKey };
    }

    throw new Error(
      '[LocalAiCredentialsService] FATAL: No local Anthropic credential configured.\n\n' +
        'Pick ONE of:\n' +
        '  (a) Claude subscription OAuth — run the Claude OAuth flow and store the token\n' +
        '      (LocalAiCredentialsService.setClaudeOAuthToken), or\n' +
        '  (b) Set ANTHROPIC_API_KEY=sk-ant-xxxxx in your local .env\n\n' +
        'AI credentials are local-first in this build — they never come from a JWT claim.'
    );
  }

  /**
   * Apply the resolved credential to `process.env` so both the in-process Anthropic
   * client and the spawned native CLI child pick it up, and clear any `ANTHROPIC_BASE_URL`
   * override so traffic hits the default `https://api.anthropic.com`. Returns the mode used.
   */
  applyToProcessEnv(): LocalAiCredentialMode {
    const credential = this.resolveCredential();

    // Default base URL: never leave a stale base-URL override pinned from a prior
    // request. Deleting the override makes the SDK fall back to api.anthropic.com.
    delete process.env.ANTHROPIC_BASE_URL;

    if (credential.mode === 'claude-oauth') {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = credential.oauthToken;
      // A stale API key would otherwise take precedence in the CLI — clear it.
      delete process.env.ANTHROPIC_API_KEY;
      return 'claude-oauth';
    }

    process.env.ANTHROPIC_API_KEY = credential.apiKey;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return 'api-key';
  }
}
