/**
 * Secure storage for the Portable `authToken`.
 *
 * The Portable JWT minted by the gateway's `/clerk-exchange` is a sensitive
 * credential (it grants backend access), so it
 * is persisted ONLY in the device keychain / EncryptedSharedPreferences via
 * `expo-secure-store` — NEVER in plain AsyncStorage. This is a SEPARATE secret
 * from the native Clerk session token cached by `tokenCache.ts`.
 *
 * No React/Expo-runtime coupling beyond `expo-secure-store`, so it is trivially
 * unit-testable with a mocked SecureStore.
 */

import * as SecureStore from 'expo-secure-store';

/** SecureStore key for the Portable `authToken` (alphanumerics/`.`/`-`/`_` only). */
export const AUTH_TOKEN_KEY = 'portable.authToken';

/** Persist the Portable `authToken` to the device keychain. */
export async function saveAuthToken(authToken: string): Promise<void> {
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, authToken);
}

/** Read the Portable `authToken` from the keychain (null if absent/corrupt). */
export async function getAuthToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  } catch {
    // A corrupt/undecryptable entry must not wedge startup — treat as absent.
    return null;
  }
}

/** Remove the Portable `authToken` from the keychain (sign-out / revocation). */
export async function clearAuthToken(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
}
