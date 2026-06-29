/**
 * First-touch UTM + report-once bookkeeping, MMKV-persisted
 * (non-secret — the `usageTrackingStore`/`pushRegistrationStore` leaf-store pattern).
 *
 * `utm` survives an app kill so a campaign captured on the cold start that
 * OPENED the app is still reported on a later launch (e.g. before the user
 * signed in). `reportedUserId` stops us re-reporting for a user we've already
 * attributed — it re-reports on a different sign-in, and a FAILED report leaves
 * it unset so the next launch retries.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../state/storage';

import type { UtmFields } from './utm';

export interface UtmAttributionState {
  /** First-touch captured campaign (null until a campaign deep link arrives). */
  utm: UtmFields | null;
  /** userId we've SUCCESSFULLY reported attribution for (report-once guard). */
  reportedUserId: string | null;
  /** First-touch: record the campaign only if none is captured yet. */
  captureFirstTouch: (incoming: UtmFields) => void;
  /** Mark the user as attributed — call ONLY after a successful report. */
  markReported: (userId: string) => void;
  reset: () => void;
}

/** MMKV persist key for the UTM attribution slice. */
export const UTM_ATTRIBUTION_PERSIST_KEY = 'portable.utmAttribution';

function hasCampaign(utm: UtmFields | null | undefined): boolean {
  return !!utm && (!!utm.utm_source || !!utm.utm_campaign);
}

export const useUtmAttributionStore = create<UtmAttributionState>()(
  persist(
    (set, get) => ({
      utm: null,
      reportedUserId: null,
      captureFirstTouch: (incoming) => {
        if (hasCampaign(get().utm)) return; // first-touch — never overwrite a captured campaign
        if (!hasCampaign(incoming)) return; // ignore non-campaign URLs
        set({ utm: incoming });
      },
      markReported: (userId) => set({ reportedUserId: userId }),
      reset: () => set({ utm: null, reportedUserId: null }),
    }),
    {
      name: UTM_ATTRIBUTION_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
      // Persist only data, never the action functions.
      partialize: (s) => ({ utm: s.utm, reportedUserId: s.reportedUserId }),
    }
  )
);
