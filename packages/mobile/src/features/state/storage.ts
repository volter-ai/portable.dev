/**
 * Zustand `persist` storage backends with a strict secret/non-secret split.
 *
 * The mobile global client-state MUST split storage by
 * sensitivity:
 *
 *   - SECRETS (auth identity / sandbox URL / Clerk-linked state) → `expo-secure-store`
 *     (device keychain / EncryptedSharedPreferences). NEVER plain AsyncStorage.
 *   - NON-SECRETS (chat drafts, AI-style + UI prefs, the offline message queue) →
 *     `react-native-mmkv` (fast synchronous on-device KV).
 *
 * Both backends are exposed as Zustand `StateStorage` implementations (wrap with
 * `createJSONStorage`). The MMKV instance is created lazily so a Jest mock of
 * `react-native-mmkv` is installed before any native constructor runs, and so the
 * native JSI module is never touched at import time.
 */

import * as SecureStore from 'expo-secure-store';
import { createMMKV, type MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/**
 * SecureStore keys accept only `[A-Za-z0-9._-]`. All persist names below are
 * already safe, but sanitise defensively so a future key can never throw.
 */
function sanitizeSecureKey(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Async `StateStorage` backed by `expo-secure-store`. Used by the auth /
 * sandbox-URL / Clerk slice — anything sensitive. Reads tolerate a corrupt entry
 * (treated as absent) so a bad keychain value can never wedge hydration.
 */
export const secureStateStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await SecureStore.getItemAsync(sanitizeSecureKey(name))) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    await SecureStore.setItemAsync(sanitizeSecureKey(name), value);
  },
  removeItem: async (name) => {
    await SecureStore.deleteItemAsync(sanitizeSecureKey(name));
  },
};

/** MMKV id namespacing all non-secret mobile state. */
export const MMKV_ID = 'portable.mmkv';

let mmkvInstance: MMKV | null = null;

/** Lazily construct (and memoise) the MMKV instance — never at import time. */
export function getMmkv(): MMKV {
  if (!mmkvInstance) {
    mmkvInstance = createMMKV({ id: MMKV_ID });
  }
  return mmkvInstance;
}

/**
 * Synchronous `StateStorage` backed by `react-native-mmkv`. Used by the
 * chat-drafts / AI-style / UI-pref / offline-queue slices — never for secrets.
 */
export const mmkvStateStorage: StateStorage = {
  getItem: (name) => getMmkv().getString(name) ?? null,
  setItem: (name, value) => {
    getMmkv().set(name, value);
  },
  removeItem: (name) => {
    getMmkv().remove(name);
  },
};
