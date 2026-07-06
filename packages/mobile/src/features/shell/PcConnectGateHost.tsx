/**
 * PcConnectGateHost (QR pairing) — the app-shell's PC-connect gate.
 *
 * Replaces the old OnboardingGate + provisioning gate in the local-first ladder.
 * It sits between the Clerk sign-in gate
 * (StartupGate) and the SandboxSessionBoundary and decides whether the device is
 * already pointed at a PC:
 *
 *   - A PC is connected (`getConnectedPcId()` resolves a pcId) AND this device
 *     still holds that pcId's E2E key → render `children` (the rest of the
 *     authenticated ladder talks to the stable `<gatewayBase>/t/<pcId>` relay
 *     endpoint via `getRelayUrl()`). A pcId whose E2E key is missing (a pairing
 *     that predates portable.dev#13) first retries the Apple-reviewer fast path
 *     (the review device has no QR to scan — portable.dev#15) and only then is
 *     routed back to the scanner — E2E is mandatory on the relay data path, so
 *     without the key every `/api/*` request would throw `NoE2eKeyError` deep in
 *     the app.
 *   - No PC connected → an OPTIONAL Apple-reviewer pre-step: if
 *     `config.getReviewerCredentials` resolves a `{ gatewayBase, pcId, token,
 *     e2eKey }` payload, the dedicated App-Store reviewer is linked + connected
 *     WITHOUT the QR scanner; any non-reviewer (`null` / `403` / error) — or a
 *     keyless response, unusable under mandatory E2E — falls through.
 *   - Still no PC → mount {@link PcConnectGate}: pairing is QR-ONLY (the `/my-pcs`
 *     picker is dropped), so it goes straight to the scanner. A scanned QR is
 *     saved (its JWT keyed by `pcId`) then connected; a successful connect flips
 *     the host to `connected` and renders `children`. A scan that decodes but whose
 *     link/connect step fails switches AWAY from the scanner (`connecting` → `error`,
 *     mirroring {@link PcConnectModal}'s phases) instead of leaving it mounted — the
 *     camera shows a frozen "Code detected!" success state the instant a code decodes
 *     (see `QrCameraScanner`), so a failed link/connect must not strand the user
 *     staring at that false success with no way back in.
 *
 * Every collaborator is an injected seam ({@link PcConnectConfig}) so the gate
 * runs deterministically under RNTL with no native modules / Clerk. The device
 * build supplies the config via `buildPcConnectConfig` in the authenticated layout.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { LoadingSplash } from '../../components/LoadingSplash';
import {
  PcConnectErrorScreen,
  PcConnectGate,
  getConnectedPcId as defaultGetConnectedPcId,
  getE2eKey as defaultGetE2eKey,
  usePcConnectionStore,
  type PcConnectConfig,
} from '../pc-connect';

type Phase = 'checking' | 'connect' | 'connecting' | 'error' | 'connected';

const CONNECT_FAILED_MESSAGE =
  "Couldn't connect to your PC. Make sure `portable start` is running on your computer, then scan the QR again.";

export interface PcConnectGateHostProps {
  config: PcConnectConfig;
  children: ReactNode;
}

export function PcConnectGateHost({ config, children }: PcConnectGateHostProps) {
  const getConnectedPcId = config.getConnectedPcId ?? defaultGetConnectedPcId;
  const getE2eKey = config.getE2eKey ?? defaultGetE2eKey;
  const [phase, setPhase] = useState<Phase>('checking');

  // Resolve the connected-PC state once on mount. A persisted pcId means a
  // returning device → straight through to the app; none → try the reviewer fast
  // path, else show the QR gate.
  useEffect(() => {
    let alive = true;

    // Apple-reviewer pre-step: runs when NO PC is connected (and, portable.dev#15,
    // when a stored pairing is missing its E2E key) and the seam is supplied. A
    // `200` payload → link (save-only) + connect, skipping the QR scanner entirely;
    // `null` / any error → fall through to the normal QR flow. Reuses the
    // production `onLink` (= linkPc) + `onConnect` (= connectToPc) seams verbatim —
    // no new connect path.
    async function tryReviewerBypass(): Promise<boolean> {
      if (!config.getReviewerCredentials) return false;
      try {
        const creds = await config.getReviewerCredentials();
        if (!creds) return false;
        // The reviewer box publishes its E2E key with its JWT. A keyless response
        // (an outdated gateway/box) must NOT be linked: E2E is mandatory on the
        // relay data path, so that pairing would strand the app on a home every
        // `/api/*` call rejects — fall through to the QR gate instead.
        if (!creds.e2eKey) return false;
        await config.onLink({
          gatewayBase: creds.gatewayBase,
          pcId: creds.pcId,
          token: creds.token,
          e2eKey: creds.e2eKey,
        });
        return await config.onConnect(creds.pcId);
      } catch {
        return false;
      }
    }

    void (async () => {
      let pcId: string | null = null;
      try {
        pcId = await getConnectedPcId();
      } catch {
        // A corrupt/undecryptable entry must not wedge startup — fall through.
        pcId = null;
      }
      if (pcId) {
        // Self-heal the E2E migration gap (portable.dev#13): a device paired
        // BEFORE E2E existed holds a JWT for this pcId but no e2eKey. Since E2E
        // is mandatory on the relay data path, EVERY `/api/*` request would then
        // throw `NoE2eKeyError` deep in the app (a dead home, no way out). Detect
        // the missing key HERE and route to the QR scanner for a fresh pairing
        // (the new QR carries the e2eKey) instead of dead-ending at request time.
        let hasKey = false;
        try {
          hasKey = (await getE2eKey(pcId)) !== null;
        } catch {
          // An unreadable keychain entry is treated as absent → re-scan (the same
          // fail-open-to-scanner posture as a corrupt pcId above).
          hasKey = false;
        }
        if (hasKey) {
          if (alive) setPhase('connected');
          return;
        }
        // Missing key: the dedicated review device has no camera path out of the
        // scanner, so retry the reviewer fast path FIRST (it re-links the JWT
        // together with the freshly-published key, portable.dev#15). Non-reviewers
        // resolve `null` fast (403) and land on the scanner exactly as before.
        const healed = await tryReviewerBypass();
        if (alive) setPhase(healed ? 'connected' : 'connect');
        return;
      }
      const bypassed = await tryReviewerBypass();
      if (alive) setPhase(bypassed ? 'connected' : 'connect');
    })();

    return () => {
      alive = false;
    };
  }, [getConnectedPcId, getE2eKey, config]);

  // Return to the QR scanner on an explicit disconnect (Runtime tab → "Disconnect").
  // `disconnectPc` clears the stored pcId + per-PC JWT first, then bumps this signal;
  // we react only to a CHANGE (not to a non-zero value) so a host remount after a
  // later reconnect can never spuriously re-open the scanner.
  const disconnectSignal = usePcConnectionStore((s) => s.disconnectSignal);
  const lastDisconnectRef = useRef(disconnectSignal);
  useEffect(() => {
    if (disconnectSignal === lastDisconnectRef.current) return;
    lastDisconnectRef.current = disconnectSignal;
    setPhase('connect');
  }, [disconnectSignal]);

  if (phase === 'checking') {
    return <LoadingSplash testID="pc-connect-checking" message="Looking for your PC…" />;
  }

  if (phase === 'connected') {
    return <>{children}</>;
  }

  if (phase === 'connecting') {
    return <LoadingSplash testID="pc-connect-connecting" message="Connecting to your PC…" />;
  }

  if (phase === 'error') {
    return (
      <PcConnectErrorScreen message={CONNECT_FAILED_MESSAGE} onRetry={() => setPhase('connect')} />
    );
  }

  return (
    <PcConnectGate
      onLink={config.onLink}
      onLinkFailed={() => setPhase('error')}
      onConnected={(pcId) => {
        // The QR's JWT is now saved for this pcId (onLink). Switch away from the
        // scanner immediately — it's already showing a paused "Code detected!"
        // success state, so this must resolve to a real outcome, not silently
        // leave that frozen screen up. connectToPc (via the config seam) persists
        // the connected pcId on a validated relay endpoint; an unhealthy/unlinked
        // PC resolves `false` → the error screen's "Try again" returns to the
        // landing for a fresh scan (a tunnel rotation re-points automatically on
        // the next attempt).
        setPhase('connecting');
        void config
          .onConnect(pcId)
          .then((ready) => setPhase(ready ? 'connected' : 'error'))
          .catch(() => setPhase('error'));
      }}
    />
  );
}
