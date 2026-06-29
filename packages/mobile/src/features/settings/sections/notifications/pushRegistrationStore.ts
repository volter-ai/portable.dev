/**
 * Per-DEVICE push-registration slice. The backend's `GET /api/push/settings`
 * `enabled` flag is USER-level (true whenever ANY subscription row exists), so
 * it can NOT tell whether THIS device registered its APNs/FCM token. Native RN
 * has no OS-level lookup, so the device's registered endpoint is persisted HERE
 * after a successful `POST /api/push/subscribe` and cleared on
 * `POST /api/push/unsubscribe` — the Notifications settings status derives from
 * this, never from the user-level flag (a fresh install must show "Disabled"
 * even when the user has another subscription active). MMKV persist (non-secret
 * device-local state — the `blockedOrgsStore`/`themeStore` pattern).
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../../../state/storage';

/** MMKV persist key for the per-device push registration. */
export const PUSH_REGISTRATION_PERSIST_KEY = 'portable.pushRegistration';

export interface PushRegistrationState {
  /** The device token registered with `POST /api/push/subscribe`, or null. */
  registeredEndpoint: string | null;
  setRegisteredEndpoint: (endpoint: string) => void;
  clearRegisteredEndpoint: () => void;
  /**
   * Whether the one-time push-permission prompt has already been shown to this
   * device. Set `true` when {@link PushPermissionPrompt} actually displays the
   * modal, so the prompt never appears more than once — even across app
   * restarts. Persisted to MMKV alongside `registeredEndpoint`.
   */
  permissionAsked: boolean;
  markPermissionAsked: () => void;
}

export const usePushRegistrationStore = create<PushRegistrationState>()(
  persist(
    (set) => ({
      registeredEndpoint: null,
      setRegisteredEndpoint: (endpoint) => set({ registeredEndpoint: endpoint }),
      clearRegisteredEndpoint: () => set({ registeredEndpoint: null }),
      permissionAsked: false,
      markPermissionAsked: () => set({ permissionAsked: true }),
    }),
    {
      name: PUSH_REGISTRATION_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
