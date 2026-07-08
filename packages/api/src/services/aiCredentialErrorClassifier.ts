import { randomUUID } from 'crypto';

import { AI_CREDENTIAL_INVALID_CODE } from '@vgit2/shared/types';

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

/**
 * Dead-credential error classification (portable.dev#18).
 *
 * When a Claude run fails because the user's Anthropic credential is expired /
 * revoked / invalid, the mobile app should show a recoverable "sign in again"
 * CTA instead of a generic failure. `claude:error` already carries an optional
 * inline `errorBlock`; this module recognizes auth-flavored failure text and
 * builds that block with `code: 'ai_credential_invalid'` — the mobile
 * ErrorBlock renders a "Sign in with Claude" button for that code.
 *
 * Deliberately conservative: only auth-specific phrasings match. A generic
 * "401"/"unauthorized" alone could be GitHub or a repo tool failing.
 */

/** The `code` the mobile ErrorBlock turns into a sign-in CTA (single-sourced in shared). */
export { AI_CREDENTIAL_INVALID_CODE };

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /oauth token.*(expired|revoked|invalid)/i,
  /please run \/login/i,
  /authentication[_ ]?error/i,
  /invalid (x-)?api[- ]?key/i,
  /invalid bearer token/i,
  /api key.*(expired|revoked|invalid|not found)/i,
  /credential.*(expired|revoked|invalid)/i,
  /no local anthropic credential/i,
];

/** True when the run-error text reads as an Anthropic credential failure. */
export function isAiCredentialError(errorText: string | undefined | null): boolean {
  if (!errorText) return false;
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(errorText));
}

/**
 * Build the inline `errorBlock` for a credential failure, or undefined when the
 * text is not credential-shaped (the caller emits a plain `claude:error`).
 */
export function buildAiCredentialErrorBlock(
  errorText: string | undefined | null
): ClaudeStreamBlock | undefined {
  if (!isAiCredentialError(errorText)) return undefined;
  return {
    type: 'error',
    blockId: randomUUID(),
    title: 'Claude sign-in needed',
    // Covers BOTH the never-configured and the expired/revoked cases (no "again",
    // which would be wrong for a first-time user who has no credential yet).
    message: "Portable couldn't run the AI — your Claude credential is missing or invalid.",
    action: 'Sign in from Settings → Claude Account.',
    code: AI_CREDENTIAL_INVALID_CODE,
    details: errorText ?? undefined,
  };
}
