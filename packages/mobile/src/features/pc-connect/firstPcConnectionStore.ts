/**
 * firstPcConnectionStore — the one-shot guard for the first-PC-connection report,
 * MMKV-persisted (non-secret — the `usageTrackingStore` / `utmStore`
 * leaf-store pattern).
 *
 * The activation report (`POST /first-pc-connection`) is idempotent server-side,
 * but we still gate it per `pcId` on-device so a healthy reconnect to a PC the user
 * already paired with does not re-fire a pointless request on every launch. The set
 * SURVIVES an app kill (MMKV) so the guard holds across launches; it is keyed by
 * `pcId` (not a boolean) so connecting a SECOND PC still reports its first
 * connection. MMKV's synchronous storage means the persisted value is hydrated by
 * the time `getState()` runs.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../state/storage';

/** MMKV persist key for the first-PC-connection guard slice. */
export const FIRST_PC_CONNECTION_PERSIST_KEY = 'portable.firstPcConnection';

export interface FirstPcConnectionState {
  /** pcIds whose first connection we've SUCCESSFULLY reported (one-shot per pcId). */
  reportedPcIds: Record<string, true>;
  /** True when this pcId's first connection has already been reported. */
  hasReported: (pcId: string) => boolean;
  /** Mark a pcId reported — call ONLY after a successful report. */
  markReported: (pcId: string) => void;
  /** Clear all guards (diagnostics / tests). */
  reset: () => void;
}

export const useFirstPcConnectionStore = create<FirstPcConnectionState>()(
  persist(
    (set, get) => ({
      reportedPcIds: {},
      hasReported: (pcId) => !!get().reportedPcIds[pcId],
      markReported: (pcId) => set((s) => ({ reportedPcIds: { ...s.reportedPcIds, [pcId]: true } })),
      reset: () => set({ reportedPcIds: {} }),
    }),
    {
      name: FIRST_PC_CONNECTION_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
      // Persist only the guard set, never the action functions.
      partialize: (s) => ({ reportedPcIds: s.reportedPcIds }),
    }
  )
);
