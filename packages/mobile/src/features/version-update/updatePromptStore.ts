/**
 * updatePromptStore — the persisted "Later" snooze for the dismissible
 * "Update available" card (#1522).
 *
 * MMKV-persisted (non-secret, the `usageTrackingStore` leaf-store pattern) so a
 * dismissal survives an app kill: the card must not nag on every relaunch, only
 * reappear once the snooze window has elapsed. Kept as a timestamp (not a
 * boolean) so the window policy can change with no migration. Device-level
 * state — deliberately NOT wiped by `forceSignOut` (same class as
 * `usageTrackingStore`).
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../state/storage';

/** MMKV persist key for the update-prompt slice. */
export const UPDATE_PROMPT_PERSIST_KEY = 'portable.updatePrompt';

/** How long a "Later" silences the update prompt (once per day, bank-style). */
export const UPDATE_PROMPT_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Is the update prompt due? True when never dismissed or the snooze window has
 * fully elapsed. A `dismissedAt` in the future (device clock rolled back) stays
 * snoozed — when in doubt, don't nag.
 */
export function shouldShowUpdatePrompt(dismissedAt: number | null, now: number): boolean {
  return dismissedAt === null || now - dismissedAt >= UPDATE_PROMPT_SNOOZE_MS;
}

export interface UpdatePromptState {
  /** Epoch ms of the last "Later" tap, or null when never dismissed. */
  dismissedAt: number | null;
  /** Record a "Later" dismissal at `at` (epoch ms). */
  dismiss: (at: number) => void;
  /** Clear the snooze (diagnostics / tests). */
  reset: () => void;
}

export const useUpdatePromptStore = create<UpdatePromptState>()(
  persist(
    (set) => ({
      dismissedAt: null,
      dismiss: (at) => set({ dismissedAt: at }),
      reset: () => set({ dismissedAt: null }),
    }),
    {
      name: UPDATE_PROMPT_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
