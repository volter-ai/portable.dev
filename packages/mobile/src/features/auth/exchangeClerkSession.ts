/**
 * Clerk → Portable authToken exchange flow.
 *
 * After native Clerk sign-in the app holds a native Clerk session
 * JWT (the `useAuth().getToken()` output — a signed JWT, ~60s lifetime, NOT a
 * `sess_...` session ID; fetch it fresh right before calling, never cache it).
 * This flow exchanges it, server-side, for the Portable credentials by calling
 * `POST /auth/mobile/react-native/clerk-exchange` via {@link GatewayClient}:
 *
 *   1. Identity-check + mint happens entirely on the gateway: it decodes the JWT's
 *      `sid` claim and validates it AUTHORITATIVELY via the Clerk API
 *      (`sessions.getSession`) — the exact path the web `/clerk/callback` flow uses
 *      (the JWT signature is not checked; the API call is the source of truth). Then
 *      `ClerkAuthService` mints a PLAIN identity authToken via `createAuthToken`.
 *      **This is a provisioning-free identity mint** — NO extra billing
 *      tokens are embedded and there is NO allowlist gating. The data-path
 *      JWT the PC's `/api` actually validates is the SEPARATE QR-carried PC-minted
 *      token (scanned during PC-connect), not this identity authToken.
 *   2. The returned `authToken` is persisted to `expo-secure-store` (NEVER plain
 *      AsyncStorage) so it survives app restarts.
 *   3. The non-secret identity — `userId`, `username`, `email` — is returned to
 *      the caller.
 *
 * Pure logic, no React/Expo coupling beyond `secureAuthStore`, so it is driven
 * end-to-end in tests with a mocked gateway `fetch` + mocked SecureStore.
 */

import { saveAuthToken } from './secureAuthStore';

import type { GatewayClient } from '../../services/gatewayClient';

/** Identity surfaced to the app after a successful exchange (authToken excluded — it is secret). */
export interface ClerkExchangeResult {
  userId: string;
  username: string;
  email: string;
}

/**
 * Exchange a native Clerk session token for the Portable `authToken` + identity.
 *
 * The minted `authToken` is written to SecureStore as a side effect; it is NOT
 * returned, so callers can never accidentally route it to insecure storage.
 *
 * @throws GatewayHttpError when the gateway rejects the exchange (e.g. invalid
 *   session → 401), so callers can surface a sign-in error.
 */
export async function exchangeClerkSession(
  clerkSessionToken: string,
  gateway: GatewayClient
): Promise<ClerkExchangeResult> {
  const { authToken, userId, username, email } = await gateway.clerkExchange(clerkSessionToken);

  // Persist the secret to the keychain — never AsyncStorage.
  await saveAuthToken(authToken);

  return { userId, username, email };
}
