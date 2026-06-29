/**
 * VersionGate — the OUTERMOST gate of the app shell. On cold
 * launch it checks the app version against the gateway minimum BEFORE any auth /
 * onboarding / provisioning runs.
 *
 *   - `checking`         → the branded splash (the check is a fast public fetch)
 *   - `update-required`  → the full-screen blocking {@link UpdateRequiredScreen}
 *   - `ok` (or fail-open) → the rest of the app (`children`)
 *
 * The check FAILS OPEN (any network error / timeout / unparseable data resolves
 * to `ok`), so a flaky network or a version-service outage never blocks the app.
 * A thin view over {@link useVersionGate}, mirroring {@link StartupGate}.
 */

import { LoadingSplash } from '../../components/LoadingSplash';
import { UpdateRequiredScreen } from './UpdateRequiredScreen';
import { useVersionGate, type VersionGateDeps } from './useVersionGate';

export interface VersionGateProps {
  /** The app tree to render once the version check passes (or fails open). */
  children: React.ReactNode;
  /**
   * Version-check dependencies. Omitted in production (the default reads the
   * bundled app version + the gateway minimum); tests inject `getMinimumVersion`.
   */
  deps?: VersionGateDeps;
}

export function VersionGate({ children, deps }: VersionGateProps) {
  const { status } = useVersionGate(deps ?? {});

  if (status === 'checking') {
    return <LoadingSplash testID="version-gate-loading" />;
  }

  if (status === 'update-required') {
    return <UpdateRequiredScreen onUpdate={deps?.onUpdate} />;
  }

  return <>{children}</>;
}
