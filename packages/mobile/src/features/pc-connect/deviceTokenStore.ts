/**
 * Secure storage for the per-PC **data-path credential** (QR pairing).
 *
 * In the local-first model the device authenticates to a PC with the **data-path
 * JWT** the launcher mints locally with `@vgit2/shared/jwt` and the PC validates
 * locally on every request (`verifyAuthToken`). That JWT is carried inside
 * the pairing QR (`QrLinkPayload.token`) and stored here on a successful link
 * ({@link linkPc} → {@link saveDeviceToken}), then presented on every request +
 * the Socket.IO handshake. Because one device can connect to MULTIPLE PCs, the
 * credential is keyed by `pcId`.
 *
 * It is a SECRET, so it lives in the device keychain / EncryptedSharedPreferences
 * via `expo-secure-store` — NEVER plain AsyncStorage — alongside (but separate
 * from) the Clerk session (`tokenCache.ts`) and the legacy sandbox authToken.
 *
 * The exported names keep the historical `*DeviceToken` spelling to minimise
 * churn across the many call sites; the stored value is now the data-path JWT.
 *
 * No React/Expo-runtime coupling beyond `expo-secure-store`, so it is trivially
 * unit-testable with a mocked SecureStore.
 */

import * as SecureStore from 'expo-secure-store';

/** SecureStore key prefix for a per-PC data-path credential (the JWT). */
export const DEVICE_TOKEN_KEY_PREFIX = 'portable.deviceToken.';

/** SecureStore key prefix for a per-PC E2E pre-shared key (base64, from the QR). */
export const E2E_KEY_PREFIX = 'portable.e2eKey.';

/**
 * expo-secure-store keys must match `[A-Za-z0-9._-]+`, but a `pcId` is opaque
 * (`pc_<uuid>` today, but never assume) — sanitize any other char so an exotic
 * id can never produce an invalid key (which would throw on read/write).
 */
function keyForPc(pcId: string): string {
  return `${DEVICE_TOKEN_KEY_PREFIX}${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Persist the data-path JWT for `pcId` (written on a successful link/renewal). */
export async function saveDeviceToken(pcId: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(keyForPc(pcId), token);
}

/** Read the data-path JWT for `pcId` (null if this device has not linked it). */
export async function getDeviceToken(pcId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(keyForPc(pcId));
  } catch {
    // A corrupt/undecryptable entry must not wedge the picker — treat as absent
    // (the user simply re-links via QR).
    return null;
  }
}

/** True when this device already holds a data-path JWT for `pcId` (no QR needed). */
export async function hasDeviceToken(pcId: string): Promise<boolean> {
  return (await getDeviceToken(pcId)) !== null;
}

/** Remove the data-path JWT for `pcId` (revoked / re-link) AND its E2E key. */
export async function clearDeviceToken(pcId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyForPc(pcId));
  // The E2E PSK is only useful alongside the JWT — drop them together so every
  // existing clear path (disconnect, recovery re-scan) also forgets the key.
  try {
    await SecureStore.deleteItemAsync(e2eKeyForPc(pcId));
  } catch {
    /* best-effort — a stale E2E key is harmless without the pairing */
  }
}

/**
 * The E2E pre-shared key from the pairing QR (`QrLinkPayload.e2eKey`,
 * portable.dev#13). Same per-PC keychain treatment as the JWT: it is a SECRET
 * (anyone holding it + the JWT could impersonate the phone end-to-end).
 */
function e2eKeyForPc(pcId: string): string {
  return `${E2E_KEY_PREFIX}${pcId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Persist the per-PC E2E pre-shared key (written on a successful link). */
export async function saveE2eKey(pcId: string, e2eKey: string): Promise<void> {
  await SecureStore.setItemAsync(e2eKeyForPc(pcId), e2eKey);
}

/** Read the per-PC E2E pre-shared key (null when this device never linked it). */
export async function getE2eKey(pcId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(e2eKeyForPc(pcId));
  } catch {
    // Corrupt/undecryptable → treat as absent (the user re-links via QR).
    return null;
  }
}
