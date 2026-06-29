/**
 * Platform lifecycle adapters for the RN socket provider.
 *
 * The shared Socket.IO core (`@vgit2/shared/socket`) is intentionally
 * lifecycle-free: React Native injects `AppState` (foreground/background) +
 * `NetInfo` (connectivity). These thin structural interfaces let the provider
 * depend on a contract — not the native modules — so tests drive transitions
 * deterministically.
 */

import { AppState, type AppStateStatus } from 'react-native';

export type { AppStateStatus };

/** Structural view of React Native's `AppState` used by the provider. */
export interface AppStateLike {
  /** Current app state, if known synchronously. */
  readonly currentState?: AppStateStatus | null;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void
  ): { remove: () => void };
}

/**
 * Minimal NetInfo surface (a connectivity event source). Identical to the
 * `NetInfoLike` consumed by the TanStack Query online-manager bridge;
 * duplicated here so the socket feature has no cross-feature import.
 */
export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null }) => void): () => void;
}

/** Default AppState adapter (the real React Native module). */
export const defaultAppState: AppStateLike = AppState;

/**
 * Default NetInfo adapter. Lazily requires `@react-native-community/netinfo` so
 * the native module is only touched when the provider runs on a device (tests
 * always inject their own controller).
 */
export const defaultNetInfo: NetInfoLike = {
  addEventListener(listener) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const NetInfo = require('@react-native-community/netinfo').default as {
      addEventListener: (l: (s: { isConnected: boolean | null }) => void) => () => void;
    };
    return NetInfo.addEventListener(listener);
  },
};
