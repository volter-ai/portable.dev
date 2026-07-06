/**
 * forceSignOut — the single local sign-out / credential-wipe composition.
 *
 * Clears every persisted credential AND every local trace of the signed-in user,
 * so a stale session can never be replayed against the wrong environment and a
 * DIFFERENT user signing in on the same device never inherits the previous user's
 * data:
 *
 *   - the Portable `authToken` (SecureStore, `secureAuthStore.ts`)
 *   - the sandbox base URL (SecureStore, `relayUrlStore.ts`)
 *   - the persisted non-secret identity slice (`useAuthStore.reset()` — the
 *     zustand persist middleware rewrites the cleared state to SecureStore)
 *   - every NON-secret MMKV store that holds user data (`wipeLocalUserData`):
 *     chat drafts + per-chat settings + AI-style prompt, the offline send queue,
 *     repo search prefs, blocked orgs, theme, and this device's push
 *     registration. (Server state — chats/repos/tasks in the
 *     TanStack Query cache + the in-memory socket stores — is dropped separately
 *     when the `(app)` provider tree unmounts on the `/sign-in` navigation.)
 *   - optionally the Clerk client JWT key (`clearClerkClientJwt`) — used by the
 *     fresh-install / auth-dead wipes where the cached Clerk session belongs to
 *     another Clerk instance; Clerk recreates a clean client when it is absent
 *   - optionally a live Clerk sign-out (`clerkSignOut`) — the Settings sign-out
 *     passes `useClerk().signOut`; the boot-time wipes can't (no hook context)
 *
 * DELIBERATELY PRESERVED (device/environment state, NOT the user's data):
 *   - the fresh-install marker (`installMarker.ts`) — clearing it would make the
 *     next boot treat this as a fresh install and re-wipe needlessly
 *   - the hidden dev-mode flag (`devModeStore.ts`) — gateway-environment targeting
 *   - the store-review usage timer (`usageTrackingStore.ts`) — device-level OS
 *     review-prompt cadence, capped by the OS per device anyway
 *   - the update-prompt snooze (`updatePromptStore.ts`) — device-level "Later"
 *     cadence for the outdated-build nudge, tied to the installed binary not the
 *     account
 *
 * Every step is isolated: one failed clear must never abort the rest (there is
 * no half-recovered state — at worst the next boot wipes again). The Settings
 * ViewModel's default sign-out delegates here so there is exactly ONE logout
 * composition in the app.
 */

import * as SecureStore from 'expo-secure-store';

import { clearAuthToken } from './secureAuthStore';
import { clearRelayUrl } from '../api/relayUrlStore';

/**
 * SecureStore key clerk-expo's token cache persists the client JWT under (see
 * `tokenCache.ts`). Deleted best-effort on a full wipe so the next boot's
 * ClerkProvider never rehydrates a cross-instance session.
 */
export const CLERK_CLIENT_JWT_KEY = '__clerk_client_jwt';

export interface ForceSignOutOptions {
  /** Also end the native Clerk session (Settings passes `useClerk().signOut`). */
  clerkSignOut?: () => Promise<void>;
  /** Also delete the persisted Clerk client JWT (fresh-install / auth-dead wipe). */
  clearClerkClientJwt?: boolean;
}

export async function forceSignOut(opts: ForceSignOutOptions = {}): Promise<void> {
  await clearAuthToken().catch(() => {});
  await clearRelayUrl().catch(() => {});

  try {
    // Lazy require keeps the zustand state slice out of this module's static
    // graph (the devModeStore pattern) — unit graphs that never mounted the
    // store still wipe the SecureStore-held secrets above.
    const { useAuthStore } = require('../state/authStore') as typeof import('../state/authStore');
    useAuthStore.getState().reset();
  } catch {
    // Store unavailable — the SecureStore secrets are already cleared.
  }

  wipeLocalUserData();

  if (opts.clearClerkClientJwt) {
    await SecureStore.deleteItemAsync(CLERK_CLIENT_JWT_KEY).catch(() => {});
  }

  if (opts.clerkSignOut) {
    await opts.clerkSignOut().catch(() => {});
  }
}

/**
 * Reset every NON-secret MMKV store that holds the signed-in user's local data.
 * Each reset is lazy-required + individually isolated (the `useAuthStore` pattern
 * above) so the zustand slices stay out of this module's static graph AND one
 * unavailable/failing store can never abort the rest of the sweep. Resetting the
 * in-memory zustand state is what matters — the synchronous MMKV `persist`
 * middleware then rewrites the cleared state to disk, so nothing survives.
 *
 * See the `forceSignOut` docblock for what is deliberately PRESERVED (the
 * install marker, dev-mode flag, store-review usage timer, and update-prompt
 * snooze — device state, not user data).
 */
export function wipeLocalUserData(): void {
  const resets: Array<() => void> = [
    () => {
      const { useChatStore } = require('../state/chatStore') as typeof import('../state/chatStore');
      useChatStore.getState().reset();
    },
    () => {
      const { useOfflineQueueStore } =
        require('../state/offlineQueueStore') as typeof import('../state/offlineQueueStore');
      useOfflineQueueStore.getState().clear();
    },
    () => {
      const { useReposStore } =
        require('../state/reposStore') as typeof import('../state/reposStore');
      useReposStore.getState().reset();
    },
    () => {
      const { useThemeStore } =
        require('../state/themeStore') as typeof import('../state/themeStore');
      useThemeStore.getState().reset();
    },
    () => {
      const { useBlockedOrgsStore } =
        require('../settings/sections/organizations/blockedOrgsStore') as typeof import('../settings/sections/organizations/blockedOrgsStore');
      useBlockedOrgsStore.getState().reset();
    },
    () => {
      const { usePushRegistrationStore } =
        require('../settings/sections/notifications/pushRegistrationStore') as typeof import('../settings/sections/notifications/pushRegistrationStore');
      usePushRegistrationStore.getState().clearRegisteredEndpoint();
    },
  ];

  for (const reset of resets) {
    try {
      reset();
    } catch {
      // Store unavailable / not in this graph — best-effort, never abort the sweep.
    }
  }
}
