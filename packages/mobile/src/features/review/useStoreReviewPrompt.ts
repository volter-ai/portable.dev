/**
 * useStoreReviewPrompt — the ViewModel that asks for a native store review once
 * the user has actually USED the app for a while (default 30 min of cumulative
 * foreground time), at a natural in-session moment.
 *
 * How it accumulates time without crying wolf:
 *   - Only FOREGROUND ("active") time counts. A periodic tick (default 30s)
 *     flushes the elapsed active segment into the persisted `usageTrackingStore`
 *     so the budget survives an app kill and keeps growing across launches.
 *   - AppState `background`/`inactive` freezes the clock (flush + stop counting);
 *     `active` resumes it. The request is only ever made while the app is
 *     foregrounded (a backgrounded prompt could not be shown anyway).
 *   - Once the cumulative budget crosses the threshold, it requests the OS prompt
 *     ONCE and records `reviewRequestedAt` so the user is never asked again
 *     (Apple/Google cap the real prompt frequency too — this is belt-and-braces).
 *   - If the request comes back unavailable (`false`), the persisted "asked" flag
 *     is left unset and the attempt is retried on the next cold start (a fresh
 *     mount) — so a device that only later gains the capability still gets asked,
 *     without hammering the API within a session.
 *
 * Every I/O seam is injectable (clock, AppState, timers, the request fn) so the
 * whole thing is unit-tested with a manual scheduler and no native modules.
 * Mounted (render-null) by `StoreReviewTracker` inside the authenticated tree, so
 * it only runs for a fully-provisioned, signed-in user — never during sign-in /
 * onboarding / provisioning.
 */

import { useEffect } from 'react';

import { AppStateLike, defaultAppState } from '../socket/lifecycle';

import { requestStoreReview } from './storeReview';
import { useUsageTrackingStore } from './usageTrackingStore';

/** 30 minutes of cumulative foreground usage before we ask for a review. */
export const DEFAULT_REVIEW_THRESHOLD_MS = 30 * 60 * 1000;
/** How often the active-time accumulator flushes + re-checks the threshold. */
export const DEFAULT_REVIEW_TICK_MS = 30 * 1000;

export interface UseStoreReviewPromptDeps {
  /** Cumulative foreground ms required before requesting a review (default 30 min). */
  thresholdMs?: number;
  /** Accumulator flush / threshold-check cadence while active (default 30s). */
  tickMs?: number;
  /** Monotonic-ish clock (default `Date.now`). */
  now?: () => number;
  /** AppState source (default React Native `AppState`). */
  appState?: AppStateLike;
  /**
   * Request the native prompt. Returns `true` iff the API actually ran (default
   * the lazy-`expo-store-review` `requestStoreReview`).
   */
  requestReview?: () => Promise<boolean>;
  /** Interval scheduler (default `setInterval`; injectable for deterministic tests). */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  /** Interval canceller (default `clearInterval`). */
  clearIntervalImpl?: (handle: unknown) => void;
}

export interface StoreReviewPromptStatus {
  /** Cumulative foreground ms tracked so far. */
  activeMs: number;
  /** Whether the store-review prompt has already been requested. */
  reviewRequested: boolean;
}

export function useStoreReviewPrompt(deps: UseStoreReviewPromptDeps = {}): StoreReviewPromptStatus {
  const activeMs = useUsageTrackingStore((s) => s.activeMs);
  const reviewRequestedAt = useUsageTrackingStore((s) => s.reviewRequestedAt);

  useEffect(() => {
    // Read deps once on mount (parity with the socket provider / health monitor).
    const thresholdMs = deps.thresholdMs ?? DEFAULT_REVIEW_THRESHOLD_MS;
    const tickMs = deps.tickMs ?? DEFAULT_REVIEW_TICK_MS;
    const now = deps.now ?? Date.now;
    const appState = deps.appState ?? defaultAppState;
    const requestReview = deps.requestReview ?? requestStoreReview;
    const setIntervalImpl =
      deps.setIntervalImpl ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
    const clearIntervalImpl = deps.clearIntervalImpl ?? ((h: unknown) => clearInterval(h as never));

    // Already asked — nothing to track (saves a timer + AppState listener).
    if (useUsageTrackingStore.getState().reviewRequestedAt != null) {
      return;
    }

    // The component only mounts when the authenticated tree renders ⇒ foreground.
    let activeSince: number | null = now();
    let isActive = true;
    let attempted = false;
    let requesting = false;
    let intervalHandle: unknown = null;

    const stopInterval = () => {
      if (intervalHandle != null) {
        clearIntervalImpl(intervalHandle);
        intervalHandle = null;
      }
    };

    /** Bank the current foreground segment into the persisted total. */
    const flush = () => {
      if (activeSince == null) return;
      const t = now();
      const elapsed = t - activeSince;
      activeSince = t;
      if (elapsed > 0) {
        useUsageTrackingStore.getState().addActiveMs(elapsed);
      }
    };

    const maybeRequest = async () => {
      if (requesting || attempted || !isActive) return;
      const state = useUsageTrackingStore.getState();
      if (state.reviewRequestedAt != null) {
        stopInterval();
        return;
      }
      if (state.activeMs < thresholdMs) return;
      attempted = true;
      requesting = true;
      try {
        const ran = await requestReview();
        if (ran) {
          useUsageTrackingStore.getState().markReviewRequested(now());
          stopInterval();
        }
      } finally {
        requesting = false;
      }
    };

    intervalHandle = setIntervalImpl(() => {
      flush();
      void maybeRequest();
    }, tickMs);

    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') {
        isActive = true;
        activeSince = now();
      } else if (next === 'background' || next === 'inactive') {
        flush();
        activeSince = null;
        isActive = false;
      }
    });

    return () => {
      flush(); // capture the final foreground segment before unmount.
      stopInterval();
      sub.remove();
    };
    // deps are read once on mount (the established read-once seam pattern).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { activeMs, reviewRequested: reviewRequestedAt != null };
}
