import crypto from 'crypto';
import os from 'os';

import { generateAuthToken, JWT_EXPIRATION, type AuthTokenPayload } from '@vgit2/shared/jwt';

import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * Pairing identity + the local data-path JWT secret.
 *
 * Clerk is GONE from the PC. The launcher now OWNS the data-path credential: it
 * mints the pairing JWT itself with the repo's existing `@vgit2/shared/jwt`
 * (`generateAuthToken`, HS256), and the api validates it locally
 * (`verifyAuthToken`). The gateway never holds the secret and never sees the
 * JWT — it only relays.
 *
 * Two pieces live here:
 *   - {@link ensureJwtSecret} — read `JWT_SECRET` from env or the shared
 *     `LocalSecretStore`; generate + persist a strong random secret on first
 *     boot if absent. The secret never leaves the PC. This is what makes BOTH
 *     the launcher's mint and the api's verify work (verify is SKIPPED when
 *     `JWT_SECRET` is empty, so local-first REQUIRES it set).
 *   - {@link resolvePairingIdentity} + {@link mintPairingToken} — a
 *     STABLE local identity (`userId = pcId`, `username = hostname` — or the
 *     GitHub login when known — `email = local@<host>`). `username` is MANDATORY
 *     (the Socket.IO handshake rejects a JWT without it). The value only needs
 *     to be stable (SQLite keys all data off it), not Clerk-issued.
 *
 * The secret shares the SAME `LocalSecretStore` instance as the device-token /
 * Claude OAuth / GitHub token secrets, under a namespaced key.
 */

/** Namespaced LocalSecretStore key for the persisted local JWT secret. */
export const JWT_SECRET_KEY = 'launcher:jwt-secret';

/** Bytes of entropy for a generated JWT secret (256-bit → 64 hex chars). */
const JWT_SECRET_BYTES = 48;

/**
 * Ensure a local `JWT_SECRET` exists and return it. Precedence:
 *   1. `JWT_SECRET` in the provided env (explicit operator override / .env).
 *   2. The value persisted in the shared {@link LocalSecretStore}.
 *   3. A freshly generated strong random secret, persisted for next boot.
 *
 * The resolved secret is what the launcher mints the pairing JWT with AND what
 * it forwards to the api child (so both sides share one secret). It never
 * leaves the PC.
 */
export function ensureJwtSecret(
  store: LocalSecretStore,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromEnv = env.JWT_SECRET?.trim();
  if (fromEnv) {
    // Persist the operator-provided secret so a later boot without the env var
    // still validates the already-issued pairings.
    if (store.get(JWT_SECRET_KEY)?.trim() !== fromEnv) {
      store.set(JWT_SECRET_KEY, fromEnv);
    }
    return fromEnv;
  }

  const existing = store.get(JWT_SECRET_KEY)?.trim();
  if (existing) return existing;

  const generated = crypto.randomBytes(JWT_SECRET_BYTES).toString('hex');
  store.set(JWT_SECRET_KEY, generated);
  return generated;
}

/** The stable local identity the launcher mints the pairing JWT for. */
export interface PairingIdentity {
  /** Stable user id the api scopes all data by (= pcId). */
  userId: string;
  /** MANDATORY — the Socket.IO handshake rejects a JWT without it. */
  username: string;
  /** Email/sub the api uses for SQLite scoping (no real mailbox needed). */
  email: string;
}

/** Options for {@link resolvePairingIdentity}. */
export interface ResolvePairingIdentityOptions {
  /** Stable routing id — becomes `userId` (and feeds the synthesized email host). */
  pcId: string;
  /** The connected GitHub login, when the launcher already has it (preferred username). */
  githubLogin?: string;
  /** Override the hostname source (tests). Defaults to {@link os.hostname}. */
  hostname?: string;
}

/** Strip a hostname down to a stable, email-safe token. */
function safeHost(hostname: string): string {
  const cleaned = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'portable-pc';
}

/**
 * Resolve the STABLE local pairing identity. Prefers the connected GitHub
 * login for `username` when the launcher already has it; otherwise the machine
 * hostname. `userId = pcId` and `email = local@<host>` keep all api data scoped
 * to one stable identity across reboots. `username` is always non-empty.
 */
export function resolvePairingIdentity(options: ResolvePairingIdentityOptions): PairingIdentity {
  let host = options.hostname;
  if (host === undefined) {
    try {
      host = os.hostname();
    } catch {
      host = 'portable-pc';
    }
  }
  const hostToken = safeHost(host);
  const githubLogin = options.githubLogin?.trim();
  const username = githubLogin && githubLogin.length > 0 ? githubLogin : hostToken;

  return {
    userId: options.pcId,
    username,
    email: `local@${hostToken}`,
  };
}

/**
 * Mint the data-path JWT carried in the pairing QR. It is a plain user
 * token (`generateAuthToken`) signed with the local `JWT_SECRET`; the api
 * validates it with `verifyAuthToken`. `username` is always present (handshake
 * requirement). Defaults to the {@link JWT_EXPIRATION} (72h) sliding window; the
 * api renews actively-used tokens via `X-Renewed-Token`.
 */
export function mintPairingToken(
  identity: PairingIdentity,
  jwtSecret: string,
  options: { expiresIn?: string | number } = {}
): string {
  const payload: Omit<AuthTokenPayload, 'iat' | 'exp' | 'jti' | 'sub' | 'role' | 'aud'> = {
    userId: identity.userId,
    username: identity.username,
    email: identity.email,
  };
  return generateAuthToken(payload, jwtSecret, {
    expiresIn: options.expiresIn ?? JWT_EXPIRATION,
  });
}
