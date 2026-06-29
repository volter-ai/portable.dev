/**
 * Clerk token cache backed by `expo-secure-store`.
 *
 * Clerk stores the active session token in memory by default. For a production
 * app we persist it in the device keychain / EncryptedSharedPreferences via
 * `expo-secure-store` so the native Clerk session survives app restarts. The
 * Portable JWT (`authToken`) is a SEPARATE secret and also
 * lives in SecureStore — never plain AsyncStorage.
 */

import * as SecureStore from 'expo-secure-store';

import type { TokenCache } from '@clerk/clerk-expo';

/**
 * SecureStore disallows some characters in keys (only alphanumerics, `.`, `-`,
 * `_`). Clerk uses keys like `__clerk_client_jwt` which are already safe, but we
 * normalise defensively so an unexpected key can never throw at runtime.
 */
function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export const tokenCache: TokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(safeKey(key));
    } catch {
      // A corrupt/undecryptable entry must not wedge sign-in — treat as absent.
      return null;
    }
  },
  async saveToken(key: string, token: string): Promise<void> {
    await SecureStore.setItemAsync(safeKey(key), token);
  },
  clearToken(key: string): void {
    void SecureStore.deleteItemAsync(safeKey(key));
  },
};
