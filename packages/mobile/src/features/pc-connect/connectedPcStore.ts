/**
 * connectedPcStore — the CHOSEN PC the app is currently pointed at.
 *
 * In the local-first model the app talks to ONE stable per-PC endpoint:
 * `<gatewayBase>/t/<pcId>` (the online gateway reverse-proxies to that PC's
 * CURRENT cloudflared tunnel). The PC's underlying tunnel URL rotates,
 * but the gateway re-points by `pcId`, so from the app's point of view the base is
 * CONSTANT — a transport drop reconnects to the SAME endpoint with no re-resolve
 * and no QR re-link.
 *
 * This store persists the chosen `pcId` (NOT a rotating URL). {@link relayBaseForPc}
 * derives the stable base from it + the fixed gateway URL; `getRelayUrl()`
 * (`relayUrlStore`) reads it so EVERY existing consumer (the Socket.IO handshake,
 * `RelayApiClient`, the health monitor) routes to the relay with zero edits.
 *
 * Picking another PC = overwrite this with `connectToPc` (picker); the
 * per-PC DEVICE TOKEN that authenticates the relay data path lives separately, keyed
 * by `pcId`, in {@link './deviceTokenStore'} — it is PRESERVED across a re-provision,
 * so a sandbox-death epoch remount reconnects rather than re-links.
 *
 * It is NOT a secret (it is only a routing key — the secret is the device token), but
 * it lives in `expo-secure-store` alongside the device token for a single per-PC
 * storage surface. No React/Expo-runtime coupling beyond `expo-secure-store`, so it
 * is trivially unit-testable with a mocked SecureStore.
 */

import * as SecureStore from 'expo-secure-store';

/** SecureStore key for the currently-connected PC id (the relay routing key). */
export const CONNECTED_PC_KEY = 'portable.connectedPcId';

/**
 * Build the STABLE per-PC relay base: `<gatewayBase>/t/<pcId>`. The `pcId` is a
 * routing key (not a secret); `encodeURIComponent` keeps an exotic id path-safe.
 * Pure — reused by `getRelayUrl()` and the `relayHealthUrl` health probe so the
 * base shape can never drift between them.
 */
export function relayBaseForPc(gatewayBase: string, pcId: string): string {
  return `${gatewayBase.replace(/\/$/, '')}/t/${encodeURIComponent(pcId)}`;
}

/** Persist the chosen PC (written on a successful connect/link). */
export async function saveConnectedPcId(pcId: string): Promise<void> {
  await SecureStore.setItemAsync(CONNECTED_PC_KEY, pcId);
}

/** Read the currently-connected PC id (null when the app is not pointed at a PC). */
export async function getConnectedPcId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(CONNECTED_PC_KEY);
  } catch {
    // A corrupt/undecryptable entry must not wedge startup — treat as absent
    // (the user re-picks a PC from the list).
    return null;
  }
}

/** Forget the connected PC (sign-out / explicit re-pick). Device tokens are kept. */
export async function clearConnectedPcId(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTED_PC_KEY);
}
