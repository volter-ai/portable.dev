/**
 * Startup-gate ViewModel (MVVM ViewModel-as-hook).
 *
 * On cold launch it decides whether the persisted credentials can be trusted
 * and exposes a tri-state the gate view renders against:
 *   - `checking`       — the startup checks are in flight (show a splash/spinner)
 *   - `authenticated`  — a trustworthy token is present → land the user in the app
 *   - `needs-sign-in`  — no token, a fresh install, or stale credentials → sign-in
 *
 * The decision runs three steps, in order:
 *
 *   1. FRESH-INSTALL CHECK (`installMarker.ts`) — iOS Keychain survives an app
 *      reinstall but MMKV does not, so a missing install marker means any
 *      Keychain credentials belong to a PREVIOUS install (possibly another
 *      environment — the dev-mode flag also lives in MMKV and resets to
 *      prod). Wipe them (`forceSignOut`) and re-auth. Deterministic, offline-safe.
 *   2. TOKEN PRESENCE — no persisted authToken → sign-in (unchanged behavior).
 *   3. AUTH PREFLIGHT (`preflightAuth.ts`) — validate the token against the
 *      CURRENT gateway via `GET /me`. An authoritative rejection (401/403, or
 *      the gateway's SPA HTML ⇒ RN routes absent) wipes and re-auths; network
 *      failures stay FAIL-OPEN (`indeterminate` → authenticated) so an offline
 *      returning user is never signed out.
 *
 * This used to also run an in-place credential migration; that
 * path was removed (an upgrading user re-authenticates once via Clerk).
 *
 * Keeping this logic in a hook keeps {@link StartupGate} a thin view, matching
 * the `useSignInViewModel` pattern.
 */

import { useEffect, useRef, useState } from 'react';

import { forceSignOut } from './forceSignOut';
import { getGatewayUrl } from './gatewayConfig';
import { hasInstallMarker, writeInstallMarker } from './installMarker';
import { preflightAuthToken, type PreflightResult } from './preflightAuth';
import { getAuthToken } from './secureAuthStore';
import { GatewayClient } from '../../services/gatewayClient';

export type StartupGateStatus = 'checking' | 'authenticated' | 'needs-sign-in';

export interface StartupGateState {
  status: StartupGateStatus;
  /** Rationale for a `needs-sign-in` outcome (startup logging / debugging). */
  reason?: string;
}

export interface StartupGateDeps {
  /** Read the persisted RN authToken (default: SecureStore `getAuthToken`). */
  getRnAuthToken?: () => Promise<string | null>;
  /** Fresh-install detection (default: the MMKV install marker is absent). */
  isFreshInstall?: () => boolean;
  /** Record that this install has launched (default: write the MMKV marker). */
  markInstalled?: () => void;
  /** Validate the token against the gateway (default: `GET /me` preflight). */
  preflight?: (authToken: string) => Promise<PreflightResult>;
  /** Wipe persisted credentials (default: `forceSignOut` incl. Clerk client JWT). */
  wipeCredentials?: () => Promise<void>;
}

function defaultPreflight(authToken: string): Promise<PreflightResult> {
  return preflightAuthToken({
    gateway: new GatewayClient({ gatewayUrl: getGatewayUrl() }),
    authToken,
  });
}

function defaultWipe(): Promise<void> {
  return forceSignOut({ clearClerkClientJwt: true });
}

export function useStartupGate(deps: StartupGateDeps = {}): StartupGateState {
  const [state, setState] = useState<StartupGateState>({ status: 'checking' });

  // Capture deps in a ref so the check runs once even though the deps object
  // identity changes across renders (this is a one-shot launch decision).
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = depsRef.current;
        const getToken = d.getRnAuthToken ?? getAuthToken;
        const isFresh = d.isFreshInstall ?? (() => !hasInstallMarker());
        const markInstalled = d.markInstalled ?? writeInstallMarker;
        const preflight = d.preflight ?? defaultPreflight;
        const wipe = d.wipeCredentials ?? defaultWipe;

        // 1. Fresh install → any Keychain residue is a previous install's.
        if (isFresh()) {
          markInstalled();
          await wipe();
          if (cancelled) return;
          setState({
            status: 'needs-sign-in',
            reason: 'fresh install — cleared stale Keychain credentials',
          });
          return;
        }

        // 2. No persisted token → sign-in (nothing is ever written here).
        const token = await getToken();
        if (cancelled) return;
        if (!token) {
          setState({ status: 'needs-sign-in', reason: 'no persisted RN authToken' });
          return;
        }

        // 3. Authoritative preflight. ONLY an `auth-dead` verdict wipes —
        // network failures fail OPEN so offline returning users stay in.
        const verdict = await preflight(token);
        if (cancelled) return;
        if (verdict === 'auth-dead') {
          await wipe();
          if (cancelled) return;
          setState({
            status: 'needs-sign-in',
            reason: 'gateway rejected the persisted credentials',
          });
          return;
        }

        setState({ status: 'authenticated' });
      } catch (err) {
        // Any unexpected failure resolves to the SAFE outcome: re-auth (nothing
        // is ever written on this path → no half-authenticated state).
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'needs-sign-in', reason: `startup check failed: ${message}` });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount — deps are read via depsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
