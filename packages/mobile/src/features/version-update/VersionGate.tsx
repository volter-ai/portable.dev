/**
 * VersionGate — the OUTERMOST gate of the app shell. On cold
 * launch it checks the app version against the gateway minimum BEFORE any auth /
 * onboarding / provisioning runs.
 *
 *   - `checking`         → the branded splash (the check is a fast public fetch)
 *   - `update-required`  → the app (`children`) with the dismissible
 *                          {@link UpdateAvailableCard} over it — unless a recent
 *                          "Later" snooze ({@link shouldShowUpdatePrompt}) is
 *                          still active. The app is NEVER hard-blocked (#1522).
 *   - `ok` (or fail-open) → the rest of the app (`children`)
 *
 * The check FAILS OPEN (any network error / timeout / unparseable data resolves
 * to `ok`), so a flaky network or a version-service outage never blocks the app.
 * A thin view over {@link useVersionGate}, mirroring {@link StartupGate}.
 *
 * The show/snooze decision is LATCHED once, when the version verdict first
 * resolves — deliberately not re-derived from the live clock on every render.
 * VersionGate re-renders on ordinary navigation (it sits above the whole app
 * tree), so a per-render `Date.now()` check would pop the modal mid-task the
 * instant a 24h snooze elapsed. Latching confines reappearance to cold starts,
 * matching the feature contract; only an explicit "Later" hides the card after.
 */

import { useEffect, useState } from 'react';

import { LoadingSplash } from '../../components/LoadingSplash';
import { UpdateAvailableCard } from './UpdateAvailableCard';
import { shouldShowUpdatePrompt, useUpdatePromptStore } from './updatePromptStore';
import { useVersionGate, type VersionGateDeps } from './useVersionGate';

export interface VersionGateProps {
  /** The app tree to render once the version check resolves (always rendered
   *  on `ok` AND `update-required` — the update prompt only overlays it). */
  children: React.ReactNode;
  /**
   * Version-check dependencies. Omitted in production (the default reads the
   * bundled app version + the gateway minimum); tests inject `getMinimumVersion`.
   */
  deps?: VersionGateDeps;
}

export function VersionGate({ children, deps }: VersionGateProps) {
  const { status } = useVersionGate(deps ?? {});
  const now = deps?.now ?? Date.now;

  // `null` until the verdict resolves; then latched to whether the update prompt
  // is due (snooze window elapsed). A "Later" flips it to `false` for the rest
  // of this session AND persists the 24h snooze for the next cold start.
  const [promptDue, setPromptDue] = useState<boolean | null>(null);

  useEffect(() => {
    if (status === 'update-required' && promptDue === null) {
      const { dismissedAt } = useUpdatePromptStore.getState();
      setPromptDue(shouldShowUpdatePrompt(dismissedAt, now()));
    }
    // Latch ONCE on the update-required transition — `dismissedAt`/`now` are read
    // at that instant only, never re-evaluated on later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleLater = () => {
    useUpdatePromptStore.getState().dismiss(now()); // persist the 24h snooze
    setPromptDue(false); // and hide for the rest of this session
  };

  if (status === 'checking') {
    return <LoadingSplash testID="version-gate-loading" />;
  }

  return (
    <>
      {children}
      {status === 'update-required' && promptDue === true && (
        <UpdateAvailableCard onLater={handleLater} onUpdate={deps?.onUpdate} />
      )}
    </>
  );
}
