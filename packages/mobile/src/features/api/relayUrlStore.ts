/**
 * The "sandbox base URL" the RN client routes ALL `/api/*` + Socket.IO traffic to.
 *
 * **Local-first model:** the base is now the STABLE per-PC relay
 * endpoint `<gatewayBase>/t/<pcId>` — derived from the connected PC id
 * ({@link getConnectedPcId}) + the fixed gateway URL, NOT a rotating sandbox URL.
 * The online gateway reverse-proxies that endpoint to the PC's CURRENT cloudflared
 * tunnel, re-pointing by `pcId`, so from the app's POV the base is
 * CONSTANT: a transport drop reconnects to the SAME endpoint with no re-resolve and
 * no QR re-link. `getRelayUrl()` is still the single reader every
 * consumer (the Socket.IO handshake, `RelayApiClient`, the health monitor) uses,
 * so they all route through the relay with zero edits — `useNativeSocket` is reused
 * unchanged.
 *
 * **Legacy fallback:** when no PC is connected, it falls back to the pre-pivot
 * sandbox URL persisted under {@link RELAY_URL_KEY} (the old provisioning path,
 * removed). This keeps the not-yet-removed provisioning code working
 * during the migration window.
 *
 * Persisted via `expo-secure-store` — NEVER plain AsyncStorage — alongside (but
 * separate from) the Portable `authToken` (`secureAuthStore.ts`). No React/Expo
 * coupling beyond `expo-secure-store` + the pure gateway-URL resolver, so it is
 * trivially unit-testable with a mocked SecureStore.
 */

import * as SecureStore from 'expo-secure-store';

import { getGatewayUrl } from '../auth/gatewayConfig';
import { getConnectedPcId, relayBaseForPc } from '../pc-connect/connectedPcStore';

/** SecureStore key for the LEGACY per-user sandbox base URL (pre-pivot). */
export const RELAY_URL_KEY = 'portable.sandboxUrl';

/** Persist the resolved sandbox base URL (LEGACY provisioning path only). */
export async function saveRelayUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(RELAY_URL_KEY, url);
}

/**
 * Resolve the sandbox base URL: the STABLE per-PC relay endpoint when a PC is
 * connected (`<gatewayBase>/t/<pcId>`), else the legacy stored sandbox URL.
 */
export async function getRelayUrl(): Promise<string | null> {
  // Stable per-PC relay base (local-first): once a PC is connected, the
  // base is `<gatewayBase>/t/<pcId>` — constant across the PC's rotating cloudflared
  // URL (the gateway re-points by pcId), so a drop reconnects to the SAME endpoint.
  try {
    const pcId = await getConnectedPcId();
    if (pcId) return relayBaseForPc(getGatewayUrl(), pcId);
  } catch {
    // Fall through to the legacy stored URL on any read/resolve failure.
  }
  try {
    return await SecureStore.getItemAsync(RELAY_URL_KEY);
  } catch {
    // A corrupt/undecryptable entry must not wedge startup — treat as absent.
    return null;
  }
}

/** Remove the persisted sandbox URL (sign-out / sandbox death → re-provision). */
export async function clearRelayUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(RELAY_URL_KEY);
}
