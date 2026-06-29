/**
 * dataPathToken (QR pairing) — the per-request credential for the RELAY DATA PATH.
 *
 * In the local-first model the app authenticates to its PC over the hosted relay
 * (`<gatewayBase>/t/<pcId>`) with the **data-path JWT** carried in the pairing QR
 * (`QrLinkPayload.token`, stored per `pcId` at link time), NOT the enriched
 * Portable authToken the pre-pivot provisioning flow minted. This resolver is
 * the SINGLE funnel for that credential:
 *
 *   - A PC is connected ({@link getConnectedPcId}) → present THAT PC's stored JWT
 *     ({@link getDeviceToken}). The PC validates the JWT locally, so the legacy
 *     Portable authToken is deliberately NEVER sent to a per-PC relay endpoint (it
 *     would not validate anyway) — a missing JWT resolves to `null`.
 *   - No PC connected → fall back to the legacy Portable authToken
 *     ({@link getAuthToken}). This keeps the not-yet-removed provisioning path
 *     (the AppShell gate ladder) working during the migration
 *     window, exactly like {@link getRelayUrl}'s legacy-URL fallback.
 *
 * Every data-path consumer reads through this one funnel — the Socket.IO handshake
 * ({@link useNativeSocket}), the {@link RelayApiClient} Bearer, and the file-viewer
 * raw-bytes header — so repointing the credential reaches all of them with zero
 * per-call-site edits (the {@link getRelayUrl} repoint pattern). Gateway-facing
 * calls (`/refresh`, …) keep using `getAuthToken` / the Clerk session token directly —
 * they are NOT on the relay data path.
 *
 * No React/Expo coupling beyond `expo-secure-store`, so it is trivially unit-testable
 * with a mocked SecureStore.
 */

import { getAuthToken } from '../auth/secureAuthStore';
import { getConnectedPcId } from './connectedPcStore';
import { getDeviceToken, saveDeviceToken } from './deviceTokenStore';

/**
 * Resolve the credential for the relay data path: the connected PC's data-path JWT,
 * else the legacy Portable authToken (no PC connected). `null` when neither exists.
 */
export async function resolveDataPathToken(): Promise<string | null> {
  // A corrupt/undecryptable connected-pc entry must not wedge the data path —
  // treat it as "no PC connected" and fall back to the legacy authToken.
  const pcId = await getConnectedPcId().catch(() => null);
  // Connected PC → the relay expects this PC's data-path JWT (or nothing). Never
  // leak the legacy Portable authToken to a per-PC relay endpoint.
  if (pcId) return getDeviceToken(pcId);
  // No PC connected → legacy provisioning path.
  return getAuthToken();
}

/**
 * Persist a JWT renewed by the PC (relay `X-Renewed-Token` header) as the new
 * data-path credential for the currently-connected PC. The PC slides the JWT before
 * expiry and returns the fresh one on the response; this writes it back keyed by the
 * connected `pcId` so the next request + the next socket handshake pick it up — the
 * device-path analog of the legacy gateway `/refresh` persistence (there is NO
 * `/refresh` on the PC). A no-op when no PC is connected (the legacy authToken path
 * keeps its own `/refresh` behavior); never throws.
 */
export async function persistRenewedDataPathToken(token: string): Promise<void> {
  const pcId = await getConnectedPcId().catch(() => null);
  if (!pcId) return;
  await saveDeviceToken(pcId, token).catch(() => {
    /* A keychain write failure must not break the in-flight request. */
  });
}
