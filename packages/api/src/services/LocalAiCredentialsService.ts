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

/**
 * Namespaced LocalSecretStore key for the FULL Claude OAuth record (portable.dev#18:
 * login-from-phone). Holds `{accessToken, refreshToken?, expiresAt?, …}` as JSON so
 * the api can auto-refresh the ~8h access token. The plain CLAUDE_OAUTH_TOKEN_KEY
 * above survives as (a) the legacy fallback read and (b) a MIRROR of the record's
 * accessToken — the launcher's CredentialResolver/LocalCredentialGuidance read it.
 */
export const CLAUDE_OAUTH_RECORD_KEY = 'ai-credentials:claude-oauth-record';

/**
 * Namespaced LocalSecretStore key for a pasted Anthropic API key (the mobile
 * paste-token fallback). Preferred over the env `ANTHROPIC_API_KEY` because the
 * user set it explicitly and more recently than their shell env.
 */
export const ANTHROPIC_API_KEY_STORE_KEY = 'ai-credentials:anthropic-api-key';

export type LocalAiCredentialMode = 'claude-oauth' | 'api-key';

export type LocalAiCredential =
  | { mode: 'claude-oauth'; oauthToken: string }
  | { mode: 'api-key'; apiKey: string };

/** Where the active credential was resolved from (most-preferred first). */
export type LocalAiCredentialSource =
  | 'oauth-record'
  | 'legacy-token'
  | 'stored-api-key'
  | 'env-api-key'
  | 'none';

/** The persisted Claude OAuth credential set (see CLAUDE_OAUTH_RECORD_KEY). */
export interface ClaudeOAuthRecord {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when accessToken expires. Absent = long-lived / unknown. */
  expiresAt?: number;
  scopes?: string[];
  /** Claude account email captured at login (status display only). */
  email?: string;
  /** ISO timestamp of when the record was obtained/refreshed. */
  obtainedAt: string;
}

/** The refresh seam ensureFresh() delegates to (implemented by ClaudeOAuthService). */
export interface OAuthRefresher {
  refreshIfNeeded(): Promise<void>;
}

export class LocalAiCredentialsService {
  private readonly store: LocalSecretStore;
  private oauthRefresher?: OAuthRefresher;

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

  // -------------------------------------------------------------------------
  // OAuth record + stored API key (portable.dev#18 — login-from-phone)
  // -------------------------------------------------------------------------

  /** The full persisted Claude OAuth record, or null (absent / corrupt — never throws). */
  getOAuthRecord(): ClaudeOAuthRecord | null {
    try {
      const record = this.store.getJSON<ClaudeOAuthRecord>(CLAUDE_OAUTH_RECORD_KEY);
      const accessToken = record?.accessToken?.trim();
      return accessToken ? { ...record!, accessToken } : null;
    } catch {
      return null;
    }
  }

  /**
   * Persist the full Claude OAuth record AND mirror its accessToken into the
   * legacy plain key (the launcher's discovery/guidance read that key).
   */
  setOAuthRecord(record: ClaudeOAuthRecord): void {
    const accessToken = record.accessToken?.trim();
    if (!accessToken) {
      throw new Error(
        '[LocalAiCredentialsService] Refusing to store an OAuth record with an empty accessToken'
      );
    }
    this.store.setJSON(CLAUDE_OAUTH_RECORD_KEY, { ...record, accessToken });
    this.store.set(CLAUDE_OAUTH_TOKEN_KEY, accessToken);
  }

  /** Remove the OAuth record + the mirrored legacy key. True if anything was removed. */
  clearAllOAuth(): boolean {
    const removedRecord = this.store.delete(CLAUDE_OAUTH_RECORD_KEY);
    const removedLegacy = this.store.delete(CLAUDE_OAUTH_TOKEN_KEY);
    return removedRecord || removedLegacy;
  }

  /** A pasted Anthropic API key from the store, or null. */
  getStoredApiKey(): string | null {
    const key = this.store.get(ANTHROPIC_API_KEY_STORE_KEY)?.trim();
    return key && key.length > 0 ? key : null;
  }

  /** Persist a pasted Anthropic API key (encrypted at rest). */
  setStoredApiKey(apiKey: string): void {
    const trimmed = apiKey?.trim();
    if (!trimmed) {
      throw new Error('[LocalAiCredentialsService] Refusing to store an empty API key');
    }
    this.store.set(ANTHROPIC_API_KEY_STORE_KEY, trimmed);
  }

  /** Remove the pasted API key. */
  clearStoredApiKey(): boolean {
    return this.store.delete(ANTHROPIC_API_KEY_STORE_KEY);
  }

  /** Inject the refresh seam (ClaudeOAuthService) that ensureFresh() delegates to. */
  setOAuthRefresher(refresher: OAuthRefresher): void {
    this.oauthRefresher = refresher;
  }

  /**
   * Best-effort access-token renewal before a session/one-shot resolves the
   * credential. Delegates to the injected refresher; NEVER throws — on failure
   * the stale token falls through and the run's own auth error surfaces it.
   */
  async ensureFresh(): Promise<void> {
    if (!this.oauthRefresher) return;
    try {
      await this.oauthRefresher.refreshIfNeeded();
    } catch (err) {
      console.warn(
        `[LocalAiCredentialsService] OAuth refresh failed (continuing with stored token): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /** Which rung resolveCredential() would use right now (status surface). */
  credentialSource(): LocalAiCredentialSource {
    if (this.getOAuthRecord()) return 'oauth-record';
    if (this.getClaudeOAuthToken()) return 'legacy-token';
    if (this.getStoredApiKey()) return 'stored-api-key';
    if (process.env.ANTHROPIC_API_KEY?.trim()) return 'env-api-key';
    return 'none';
  }

  /**
   * Resolve the active AI credential, preferring a configured Claude OAuth credential
   * (full record, then the legacy plain token) over an API key (pasted/stored, then
   * the env `ANTHROPIC_API_KEY`). Throws (with actionable guidance) when nothing is
   * configured. The credential NEVER comes from a JWT claim.
   */
  resolveCredential(): LocalAiCredential {
    const record = this.getOAuthRecord();
    if (record) {
      return { mode: 'claude-oauth', oauthToken: record.accessToken };
    }

    const oauthToken = this.getClaudeOAuthToken();
    if (oauthToken) {
      return { mode: 'claude-oauth', oauthToken };
    }

    const storedApiKey = this.getStoredApiKey();
    if (storedApiKey) {
      return { mode: 'api-key', apiKey: storedApiKey };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) {
      return { mode: 'api-key', apiKey };
    }

    throw new Error(
      '[LocalAiCredentialsService] FATAL: No local Anthropic credential configured.\n\n' +
        'Pick ONE of:\n' +
        '  (a) Claude subscription OAuth — sign in from the Portable app (Settings →\n' +
        '      Claude Account) or run `claude setup-token` on this PC, or\n' +
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
