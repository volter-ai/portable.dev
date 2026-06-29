/**
 * Dev-mode store — the hidden environment switch.
 *
 * `enabled === true` points the WHOLE app at the dev gateway
 * (`https://app.portable-dev.com`) and unlocks the Clerk email/password form on
 * the sign-in screen; `false` (the default) is production (`https://app.portable.dev`,
 * SSO-only sign-in). Toggled by tapping the sign-in brand header 10×.
 *
 * Persistence is MMKV (`portable.devMode`) — a plain non-secret flag — but NOT via
 * the zustand `persist` middleware: this store sits in `gatewayConfig`'s import
 * graph (≈ every feature), and `persist` rehydrates at import time, which would
 * force the `react-native-mmkv` Jest mock onto every test file. Instead the flag
 * is read/written through a lazy `getMmkv()` require wrapped in try/catch, so an
 * unmocked Jest environment silently degrades to prod mode instead of crashing
 * with the documented nitro-module error.
 *
 * Switching environments invalidates the persisted Portable credentials (the
 * authToken + sandbox URL belong to the OTHER gateway) — `setDevMode` clears them
 * fire-and-forget. The Clerk session cache is left alone: `ClerkAuthProvider`
 * remounts `ClerkProvider` (keyed on the mode) with the mode's publishable key.
 */

import { create } from 'zustand';

/** MMKV key holding the persisted flag (`'true'` / `'false'`). */
export const DEV_MODE_STORAGE_KEY = 'portable.devMode';

function readPersistedDevMode(): boolean {
  try {
    // Lazy require — never pull react-native-mmkv into the static import graph.
    const { getMmkv } = require('./storage') as typeof import('./storage');
    return getMmkv().getString(DEV_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false; // MMKV unavailable (unmocked Jest) → default to prod mode.
  }
}

function writePersistedDevMode(enabled: boolean): void {
  try {
    const { getMmkv } = require('./storage') as typeof import('./storage');
    getMmkv().set(DEV_MODE_STORAGE_KEY, String(enabled));
  } catch {
    // MMKV unavailable — the in-memory flag still drives this session.
  }
}

/**
 * A persisted authToken / sandbox URL was minted by the environment we are
 * LEAVING — clear both (fire-and-forget) so the gates re-run against the new
 * gateway instead of replaying cross-environment credentials. Lazy requires keep
 * `expo-secure-store` out of this module's static graph.
 */
function clearCrossEnvCredentials(): void {
  try {
    const { clearAuthToken } =
      require('../auth/secureAuthStore') as typeof import('../auth/secureAuthStore');
    void clearAuthToken().catch(() => {});
  } catch {
    // SecureStore unavailable — nothing persisted to clear.
  }
  try {
    const { clearRelayUrl } =
      require('../api/relayUrlStore') as typeof import('../api/relayUrlStore');
    void clearRelayUrl().catch(() => {});
  } catch {
    // SecureStore unavailable — nothing persisted to clear.
  }
}

export interface DevModeState {
  /** True while the app targets the dev gateway. */
  enabled: boolean;
  /** Set the mode explicitly (no-op when unchanged). */
  setDevMode: (enabled: boolean) => void;
  /** Flip the mode; returns the NEW value. */
  toggleDevMode: () => boolean;
}

export const useDevModeStore = create<DevModeState>()((set, get) => ({
  enabled: readPersistedDevMode(),
  setDevMode: (enabled) => {
    if (enabled === get().enabled) return;
    writePersistedDevMode(enabled);
    clearCrossEnvCredentials();
    set({ enabled });
  },
  toggleDevMode: () => {
    const next = !get().enabled;
    get().setDevMode(next);
    return next;
  },
}));

/**
 * Synchronous non-React reader — what `getGatewayUrl()` /
 * `getClerkPublishableKey()` consult on every call (no caching, mirroring the
 * `BaseUrlResolver` no-stale-cache guarantee).
 */
export function isDevModeEnabled(): boolean {
  return useDevModeStore.getState().enabled;
}
