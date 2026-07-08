/**
 * AI-credential management wire types (portable.dev#18).
 *
 * The PC api owns the user's Anthropic credential (Claude subscription OAuth or
 * a raw API key). These types cover the mobile "Claude Account" surface: status
 * reporting, the phone-driven OAuth login (PKCE + paste-code), the paste-a-token
 * fallback, and sign-out. Tokens themselves NEVER ride these payloads — the
 * status response carries metadata only.
 */

/**
 * The `code` stamped on a chat `error` block when a run fails because the AI
 * credential is expired/invalid — the mobile ErrorBlock renders a
 * "Sign in with Claude" CTA for it.
 */
export const AI_CREDENTIAL_INVALID_CODE = 'ai_credential_invalid';

/** Which credential mode the api would use right now. */
export type AiCredentialMode = 'claude-oauth' | 'api-key' | 'none';

/** Where the active credential was resolved from (most-preferred first). */
export type AiCredentialSource =
  | 'oauth-record'
  | 'legacy-token'
  | 'stored-api-key'
  | 'env-api-key'
  | 'none';

/** GET /api/ai-credentials/status */
export interface AiCredentialsStatusResponse {
  mode: AiCredentialMode;
  source: AiCredentialSource;
  /** True when a refresh token is stored (the api auto-renews the access token). */
  hasRefreshToken: boolean;
  /** Claude account email captured at login (claude-oauth only). */
  email?: string;
  /** Epoch ms when the access token expires (absent = long-lived / unknown). */
  expiresAt?: number;
}

/** POST /api/ai-credentials/login/start */
export interface AiCredentialsLoginStartResponse {
  /** The Claude authorization URL the phone opens in the system browser. */
  authorizeUrl: string;
}

/** POST /api/ai-credentials/login/complete request body. */
export interface AiCredentialsLoginCompleteRequest {
  /** The `CODE#STATE` string the user copied from the callback page. */
  code: string;
}

/** POST /api/ai-credentials/login/complete */
export interface AiCredentialsLoginCompleteResponse {
  ok: true;
  email?: string;
}

/** POST /api/ai-credentials/token request body (paste fallback). */
export interface AiCredentialsPasteTokenRequest {
  /** An `sk-ant-oat01-…` OAuth token or an `sk-ant-api…` API key. */
  token: string;
}

/** POST /api/ai-credentials/token */
export interface AiCredentialsPasteTokenResponse {
  ok: true;
  mode: Exclude<AiCredentialMode, 'none'>;
}

/** DELETE /api/ai-credentials */
export interface AiCredentialsSignOutResponse {
  ok: true;
  /** True when a stored credential was actually removed. */
  cleared: boolean;
}

/** Error body for the ai-credentials routes (4xx/5xx). */
export interface AiCredentialsErrorResponse {
  error: string;
  code:
    | 'invalid_code'
    | 'state_mismatch'
    | 'no_pending_login'
    | 'exchange_failed'
    | 'invalid_token'
    | 'invalid_request';
}
