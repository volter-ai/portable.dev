/**
 * refreshAuthToken — re-issue a sliding 72h Portable `authToken`.
 *
 * The gateway endpoint `POST /auth/mobile/react-native/refresh` re-checks the
 * blacklist and mints a fresh sliding-72h
 * JWT via `renewAuthToken`. This helper drives that endpoint from RN: it reads
 * the CURRENT `authToken` from SecureStore, exchanges it for a fresh one, and
 * persists the result back to SecureStore so the next HTTP request and the next
 * socket handshake pick it up automatically.
 *
 * It is a pure async primitive (no React/Expo coupling beyond SecureStore,
 * which is injectable) so it can be unit-tested with a mocked gateway and used
 * both reactively (on a 401 — see {@link createAuthedFetch}) and proactively
 * (e.g. before opening the socket).
 */

import type { GatewayClient } from '../../services/gatewayClient';
import { getAuthToken, saveAuthToken } from './secureAuthStore';

/** Thrown when there is no stored `authToken` to refresh (user must re-login). */
export class NoAuthTokenError extends Error {
  constructor() {
    super('No stored authToken to refresh');
    this.name = 'NoAuthTokenError';
  }
}

/** Injectable persistence seams (default to the SecureStore-backed store). */
export interface RefreshTokenDeps {
  /** Read the current `authToken` (default: SecureStore `getAuthToken`). */
  getToken?: () => Promise<string | null>;
  /** Persist the refreshed `authToken` (default: SecureStore `saveAuthToken`). */
  saveToken?: (token: string) => Promise<void>;
}

/**
 * Refresh the stored `authToken` via the gateway and persist the new one.
 *
 * @returns the fresh `authToken` (already persisted to SecureStore).
 * @throws {NoAuthTokenError} when there is no token to refresh.
 * @throws {GatewayHttpError} when the gateway rejects the refresh (e.g. the
 *   token was revoked/blacklisted → 401); the stored token is left untouched.
 */
export async function refreshAuthToken(
  gateway: GatewayClient,
  deps: RefreshTokenDeps = {}
): Promise<string> {
  const read = deps.getToken ?? getAuthToken;
  const write = deps.saveToken ?? saveAuthToken;

  const current = await read();
  if (!current) throw new NoAuthTokenError();

  const { authToken } = await gateway.refreshAuthToken(current);
  await write(authToken);
  return authToken;
}
