/**
 * usageTrackingStore — persisted cumulative foreground usage + the store-review
 * "already asked" flag (drives `useStoreReviewPrompt`).
 *
 * MMKV-persisted (non-secret, the `pushRegistrationStore` / `blockedOrgsStore`
 * leaf-store pattern) so the accumulated time SURVIVES an app kill: we only ask
 * for a store review once the user has spent a meaningful amount of time in the
 * app, and that budget accrues across launches. MMKV's synchronous storage means
 * the persisted value is hydrated by the time `getState()` runs on mount.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../state/storage';

/** MMKV persist key for the usage-tracking slice. */
export const USAGE_TRACKING_PERSIST_KEY = 'portable.usageTracking';

export interface UsageTrackingState {
  /** Cumulative foreground ("active") milliseconds across all app sessions. */
  activeMs: number;
  /**
   * Epoch ms when the native store-review prompt was last requested, or null
   * when never asked. Kept as a timestamp (not a boolean) so a future
   * "re-ask after N months" policy needs no migration.
   */
  reviewRequestedAt: number | null;
  /** Add a foreground segment to the cumulative total. */
  addActiveMs: (ms: number) => void;
  /** Record that the store-review prompt was requested at `at` (epoch ms). */
  markReviewRequested: (at: number) => void;
  /** Clear all tracking state (diagnostics / tests). */
  reset: () => void;
}

export const useUsageTrackingStore = create<UsageTrackingState>()(
  persist(
    (set) => ({
      activeMs: 0,
      reviewRequestedAt: null,
      addActiveMs: (ms) => {
        if (!(ms > 0)) return;
        set((s) => ({ activeMs: s.activeMs + ms }));
      },
      markReviewRequested: (at) => set({ reviewRequestedAt: at }),
      reset: () => set({ activeMs: 0, reviewRequestedAt: null }),
    }),
    {
      name: USAGE_TRACKING_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
