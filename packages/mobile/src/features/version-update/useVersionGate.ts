/**
 * useVersionGate — ViewModel for the cold-start version-update gate. On mount
 * it reads the app's own version, fetches the gateway minimum
 * (the public `GET /api/min-version-v2`), and resolves a tri-state the gate view
 * renders against:
 *   - `checking`         — the check is in flight (the gate shows a splash)
 *   - `ok`               — the app meets the minimum, OR the check failed open
 *   - `update-required`  — the app is behind on major.minor → a newer version is
 *                          available; the gate overlays the dismissible
 *                          "Update available" card (never a hard block, #1522)
 *
 * Every I/O seam is injectable so the hook unit-tests with no network / native
 * modules. The default reads the version from `expo-constants` (baked into the
 * JS bundle from `app.json` at build time) and the minimum from a `GatewayClient`
 * built off the configured gateway URL. Mirrors the `useStartupGate` shape.
 */

import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';

import { runVersionGate, type RunVersionGateDeps } from './versionCheck';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { GatewayClient } from '../../services/gatewayClient';

export type VersionGateStatus = 'checking' | 'ok' | 'update-required';

export interface VersionGateDeps extends Partial<
  Pick<RunVersionGateDeps, 'maxAttempts' | 'baseDelayMs' | 'timeoutMs' | 'sleep'>
> {
  /** This build's version (default: `Constants.expoConfig.version` from app.json). */
  appVersion?: string;
  /** Fetch the gateway minimum version (default: `GatewayClient.getMinVersion`). */
  getMinimumVersion?: () => Promise<string>;
  /** Gateway client used to build the default `getMinimumVersion`. */
  gateway?: GatewayClient;
  /**
   * Store-open action for the {@link UpdateAvailableCard} (default: open the
   * platform store via `Linking`). Surfaced here so the gate can thread it down.
   */
  onUpdate?: () => void;
  /**
   * Clock for the "Later" snooze window (default `Date.now`; tests inject a
   * fixed epoch to drive the reappear-after-24h behavior deterministically).
   */
  now?: () => number;
}

/** Read this build's own version (baked into the bundle from app.json). */
export function getCurrentAppVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

export function useVersionGate(deps: VersionGateDeps = {}): { status: VersionGateStatus } {
  const [status, setStatus] = useState<VersionGateStatus>('checking');

  // Read deps via a ref so the check runs ONCE even though the deps object
  // identity changes across renders (a one-shot launch decision, like useStartupGate).
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = depsRef.current;
        const appVersion = d.appVersion ?? getCurrentAppVersion();
        const getMinimumVersion =
          d.getMinimumVersion ??
          (() => {
            // Build the gateway client lazily so an injected `getMinimumVersion`
            // (tests) never touches the gateway-URL / dev-mode store.
            const gateway = d.gateway ?? new GatewayClient({ gatewayUrl: getGatewayUrl() });
            return gateway.getMinVersion().then((r) => r.minimumVersion);
          });

        const verdict = await runVersionGate({
          appVersion,
          getMinimumVersion,
          maxAttempts: d.maxAttempts,
          baseDelayMs: d.baseDelayMs,
          timeoutMs: d.timeoutMs,
          sleep: d.sleep,
        });
        if (cancelled) return;
        setStatus(verdict);
      } catch {
        // runVersionGate already fails open; this is belt-and-braces.
        if (!cancelled) setStatus('ok');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount — deps are read via depsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status };
}
