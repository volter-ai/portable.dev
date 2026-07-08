import { createHash, randomBytes } from 'crypto';

import type { ClaudeOAuthRecord, LocalAiCredentialsService } from './LocalAiCredentialsService.js';

/**
 * Claude-account OAuth service (portable.dev#18 — sign in from the phone).
 *
 * Implements the SAME OAuth 2.0 authorization-code + PKCE flow Claude Code's own
 * `/login` uses, driven from the mobile app: `startLogin()` mints the authorize
 * URL the phone opens in its browser; the callback page shows the user a
 * `CODE#STATE` string; `completeLogin()` exchanges it (this service holds the
 * PKCE verifier, so the pasted code is useless to anyone else) and persists the
 * full record via {@link LocalAiCredentialsService.setOAuthRecord}.
 *
 * `refreshIfNeeded()` is the auto-renew half: the ~8h access token is renewed
 * with the stored refresh token inside a small expiry buffer, single-flighted,
 * and NEVER throws (a failed refresh keeps the old record; the run's own auth
 * error + the mobile dead-credential CTA take over). It is injected into
 * `LocalAiCredentialsService.setOAuthRefresher` so every session start /
 * one-shot self-heals via `ensureFresh()`.
 *
 * ⚠️ The endpoints/client id below are the ones the Claude Code CLI itself uses
 * (not officially documented). They are deliberately confined to THIS module;
 * the paste-token fallback (`pasteToken`) survives any upstream change.
 *
 * All effects are injected seams (`fetchImpl`, `now`) so tests run with fakes.
 */

/** Claude's OAuth authorize page (the URL the phone opens). */
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
/** Token exchange + refresh endpoint (form-encoded, NOT JSON). */
export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** The manual-copy callback page that displays `CODE#STATE` to the user. */
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** Claude Code's public OAuth client id. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** The scopes Claude Code requests. */
export const CLAUDE_OAUTH_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

/** How long a started login stays completable. */
export const LOGIN_ATTEMPT_TTL_MS = 10 * 60_000;
/** Refresh when the access token expires within this window. */
export const REFRESH_BUFFER_MS = 5 * 60_000;
/** Token-endpoint timeout — generous: it is known to take 40-60s under load. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 120_000;

export type ClaudeOAuthErrorCode =
  | 'invalid_code'
  | 'state_mismatch'
  | 'no_pending_login'
  | 'exchange_failed'
  | 'invalid_token';

/** Typed failure the routes map onto 4xx/5xx bodies. */
export class ClaudeOAuthError extends Error {
  readonly code: ClaudeOAuthErrorCode;

  constructor(code: ClaudeOAuthErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeOAuthError';
    this.code = code;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type NowImpl = () => number;

export interface ClaudeOAuthServiceOptions {
  fetchImpl?: FetchImpl;
  now?: NowImpl;
}

interface PendingLogin {
  verifier: string;
  state: string;
  createdAt: number;
}

/** The token endpoint's response shape (exchange AND refresh grants). */
interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account?: { email_address?: string };
  error?: string;
  error_description?: string;
}

const base64url = (buf: Buffer): string => buf.toString('base64url');

export class ClaudeOAuthService {
  private readonly credentials: LocalAiCredentialsService;
  private readonly fetchImpl: FetchImpl;
  private readonly now: NowImpl;
  /** ONE pending login at a time — a new start supersedes the previous. */
  private pending?: PendingLogin;
  /** Single-flight guard for concurrent refreshes. */
  private refreshInFlight?: Promise<void>;

  constructor(credentials: LocalAiCredentialsService, options: ClaudeOAuthServiceOptions = {}) {
    this.credentials = credentials;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Login (phone-driven PKCE + paste-code)
  // -------------------------------------------------------------------------

  /** Mint a fresh PKCE attempt and return the authorize URL for the phone browser. */
  startLogin(): { authorizeUrl: string } {
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    this.pending = { verifier, state, createdAt: this.now() };

    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      scope: CLAUDE_OAUTH_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return { authorizeUrl: `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString()}` };
  }

  /**
   * Exchange the user-pasted `CODE#STATE` (the `#STATE` suffix is optional —
   * the pending attempt's state is used either way) and persist the record.
   */
  async completeLogin(codeInput: string): Promise<{ email?: string }> {
    const pending = this.pending;
    if (!pending || this.now() - pending.createdAt > LOGIN_ATTEMPT_TTL_MS) {
      this.pending = undefined;
      throw new ClaudeOAuthError(
        'no_pending_login',
        'No login in progress (or it expired) — tap "Sign in with Claude" again.'
      );
    }

    const [rawCode, pastedState] = codeInput.trim().split('#', 2);
    const code = rawCode?.trim();
    if (!code) {
      throw new ClaudeOAuthError('invalid_code', 'The pasted code is empty.');
    }
    if (pastedState !== undefined && pastedState.trim() !== pending.state) {
      throw new ClaudeOAuthError(
        'state_mismatch',
        'The pasted code belongs to a different login attempt — start again and paste the newest code.'
      );
    }

    const response = await this.postTokenEndpoint({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: pending.verifier,
      state: pending.state,
    });

    const record = this.buildRecord(response);
    this.credentials.setOAuthRecord(record);
    this.pending = undefined;
    return { email: record.email };
  }

  // -------------------------------------------------------------------------
  // Auto-refresh (the OAuthRefresher seam)
  // -------------------------------------------------------------------------

  /**
   * Renew the access token when it expires within {@link REFRESH_BUFFER_MS}.
   * No-op without a refresh token / an expiry (long-lived `setup-token` /
   * pasted tokens). Single-flighted; NEVER throws — a failed refresh keeps the
   * previous record and is only logged.
   */
  async refreshIfNeeded(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const record = this.credentials.getOAuthRecord();
    if (!record?.refreshToken || record.expiresAt === undefined) return;
    if (record.expiresAt - this.now() > REFRESH_BUFFER_MS) return;

    this.refreshInFlight = this.doRefresh(record).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(record: ClaudeOAuthRecord): Promise<void> {
    try {
      const response = await this.postTokenEndpoint({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken!,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      });
      // Keep prior refreshToken/email when the refresh response omits them.
      this.credentials.setOAuthRecord({
        ...record,
        ...this.buildRecord(response),
        refreshToken: response.refresh_token ?? record.refreshToken,
        email: response.account?.email_address ?? record.email,
      });
      console.log('[ClaudeOAuthService] Access token refreshed');
    } catch (err) {
      console.warn(
        `[ClaudeOAuthService] Token refresh failed (keeping the stored token): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Status / paste fallback / sign-out
  // -------------------------------------------------------------------------

  /** Credential metadata for the mobile status card — NEVER token values. */
  status(): {
    mode: 'claude-oauth' | 'api-key' | 'none';
    source: ReturnType<LocalAiCredentialsService['credentialSource']>;
    hasRefreshToken: boolean;
    email?: string;
    expiresAt?: number;
  } {
    let mode: 'claude-oauth' | 'api-key' | 'none' = 'none';
    try {
      mode = this.credentials.resolveCredential().mode;
    } catch {
      mode = 'none';
    }
    const record = this.credentials.getOAuthRecord();
    return {
      mode,
      source: this.credentials.credentialSource(),
      hasRefreshToken: Boolean(record?.refreshToken),
      ...(record?.email ? { email: record.email } : {}),
      ...(record?.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    };
  }

  /**
   * The paste fallback: an `sk-ant-oat…` token (from `claude setup-token` run
   * anywhere) becomes an OAuth record with no refresh token; any other
   * `sk-ant-…` value is stored as an API key. Anything else is rejected.
   */
  pasteToken(tokenInput: string): { mode: 'claude-oauth' | 'api-key' } {
    const token = tokenInput?.trim();
    if (!token || !token.startsWith('sk-ant-')) {
      throw new ClaudeOAuthError(
        'invalid_token',
        'That does not look like an Anthropic credential (expected sk-ant-…).'
      );
    }
    if (token.startsWith('sk-ant-oat')) {
      this.credentials.setOAuthRecord({
        accessToken: token,
        obtainedAt: new Date(this.now()).toISOString(),
      });
      return { mode: 'claude-oauth' };
    }
    this.credentials.setStoredApiKey(token);
    return { mode: 'api-key' };
  }

  /** Clear every stored credential (env fallback remains). True if anything was removed. */
  signOut(): boolean {
    this.pending = undefined;
    const clearedOAuth = this.credentials.clearAllOAuth();
    const clearedApiKey = this.credentials.clearStoredApiKey();
    return clearedOAuth || clearedApiKey;
  }

  // -------------------------------------------------------------------------
  // Token endpoint plumbing
  // -------------------------------------------------------------------------

  private async postTokenEndpoint(params: Record<string, string>): Promise<TokenEndpointResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ClaudeOAuthError(
        'exchange_failed',
        `Could not reach the Claude token endpoint: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let data: TokenEndpointResponse;
    try {
      data = (await response.json()) as TokenEndpointResponse;
    } catch {
      data = {};
    }
    if (!response.ok || !data.access_token) {
      throw new ClaudeOAuthError(
        'exchange_failed',
        `Token request rejected (HTTP ${response.status}): ${
          data.error_description || data.error || 'no access token in response'
        }`
      );
    }
    return data;
  }

  private buildRecord(response: TokenEndpointResponse): ClaudeOAuthRecord {
    return {
      accessToken: response.access_token!,
      ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
      ...(response.expires_in !== undefined
        ? { expiresAt: this.now() + response.expires_in * 1000 }
        : {}),
      ...(response.scope ? { scopes: response.scope.split(' ') } : {}),
      ...(response.account?.email_address ? { email: response.account.email_address } : {}),
      obtainedAt: new Date(this.now()).toISOString(),
    };
  }
}
