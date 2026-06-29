/**
 * useUtmAttribution — capture campaign UTM from the app's launch/incoming deep
 * links and report attribution to the gateway ONCE per user.
 *
 * Mounted inside `ApiProvider` (past onboarding + provisioning), so it fires for
 * a freshly-onboarded user AND an already-onboarded one the moment they reach
 * home — the gateway then ensures their `user_attribution` row exists and marks
 * `first_use_at`, so mobile users finally count as "verified signups" (the
 * native app never visited the web landing page that creates the precapture
 * row, so without this they had no row and the UPDATE-only `first_use_at`
 * writers were silent no-ops).
 *
 * Every I/O seam is injectable so the layer is unit-testable with no native
 * module / network. Identity is read REACTIVELY from `authStore` (seed it in
 * tests), so a report fires as soon as the signed-in user is known.
 */

import { useEffect } from 'react';
import * as Linking from 'expo-linking';

import { useAuthStore } from '../state/authStore';

import { reportUtmAttribution, type ReportAttributionDeps } from './reportAttribution';
import { parseUtmFromUrl } from './utm';
import { useUtmAttributionStore } from './utmStore';

export interface UtmAttributionDeps {
  /** Read the cold-start deep link (default `Linking.getInitialURL`). */
  getInitialUrl?: () => Promise<string | null>;
  /** Subscribe to warm deep links; returns an unsubscribe (default expo-linking). */
  addUrlListener?: (handler: (url: string) => void) => { remove: () => void };
  /** Report attribution to the gateway (default `reportUtmAttribution`). */
  report?: (deps: ReportAttributionDeps) => Promise<boolean>;
  /** Injected straight through to the default `report`. */
  gateway?: ReportAttributionDeps['gateway'];
  getToken?: ReportAttributionDeps['getToken'];
}

function defaultAddUrlListener(handler: (url: string) => void): { remove: () => void } {
  const sub = Linking.addEventListener('url', ({ url }) => handler(url));
  return { remove: () => sub.remove() };
}

export function useUtmAttribution(deps: UtmAttributionDeps = {}): void {
  const getInitialUrl = deps.getInitialUrl ?? Linking.getInitialURL;
  const addUrlListener = deps.addUrlListener ?? defaultAddUrlListener;
  const report = deps.report ?? reportUtmAttribution;

  // Reactive identity — once the signed-in user is known the report fires.
  const userId = useAuthStore((s) => s.user?.userId) ?? null;

  useEffect(() => {
    let cancelled = false;

    const capture = (url: string | null) => {
      const utm = parseUtmFromUrl(url);
      if (utm) useUtmAttributionStore.getState().captureFirstTouch(utm);
    };

    // Warm deep links (app already open) — first-touch capture. Defensive: a
    // missing/unmocked Linking must never crash the authenticated tree.
    let sub: { remove: () => void } = { remove: () => {} };
    try {
      sub = addUrlListener((url) => capture(url));
    } catch {
      /* Linking unavailable — warm-link capture is best-effort */
    }

    void (async () => {
      // 1. Capture the cold-start deep link BEFORE reporting, so a campaign that
      //    OPENED the app is included in this same launch's report.
      try {
        capture(await getInitialUrl());
      } catch {
        /* no deep link / malformed */
      }
      if (cancelled) return;

      // 2. Report once per user (the row + first_use are write-once server-side;
      //    a failed report leaves `reportedUserId` unset → retried next launch).
      if (!userId) return;
      if (useUtmAttributionStore.getState().reportedUserId === userId) return;

      const ok = await report({
        utm: useUtmAttributionStore.getState().utm,
        gateway: deps.gateway,
        getToken: deps.getToken,
      });
      if (ok && !cancelled) useUtmAttributionStore.getState().markReported(userId);
    })();

    return () => {
      cancelled = true;
      sub.remove();
    };
    // Re-run when the signed-in user becomes known (null → userId). The layer
    // also remounts on a session-epoch bump, which is the right cadence
    // (a fresh report after re-provision is harmless — idempotent server-side
    // and gated by `reportedUserId`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
}
