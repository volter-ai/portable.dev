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

/** Remove the data-path JWT for `pcId` (revoked / re-link). */
export async function clearDeviceToken(pcId: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyForPc(pcId));
}
