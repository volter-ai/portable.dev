/**
 * StoreReviewTracker — the render-null mount point for `useStoreReviewPrompt`
 * (the `ThemeSync` precedent). The app-shell renders it inside `ApiProvider`,
 * INSIDE the gate ladder, so it only runs for a signed-in, fully-provisioned
 * user — foreground usage time therefore counts only while the user is in the
 * real app (never during sign-in / onboarding / provisioning).
 *
 * It remounts on a session-epoch bump; the persisted usage budget survives
 * the remount (MMKV), so nothing is lost.
 */

import { useStoreReviewPrompt, type UseStoreReviewPromptDeps } from './useStoreReviewPrompt';

export interface StoreReviewTrackerProps {
  /** Injectable ViewModel seams (clock / AppState / timers / request fn) for tests. */
  deps?: UseStoreReviewPromptDeps;
}

export function StoreReviewTracker({ deps }: StoreReviewTrackerProps = {}) {
  useStoreReviewPrompt(deps);
  return null;
}
