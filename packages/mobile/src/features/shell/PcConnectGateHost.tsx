/**
 * PcConnectGateHost (QR pairing) — the app-shell's PC-connect gate.
 *
 * Replaces the old OnboardingGate + provisioning gate in the local-first ladder.
 * It sits between the Clerk sign-in gate
 * (StartupGate) and the SandboxSessionBoundary and decides whether the device is
 * already pointed at a PC:
 *
 *   - A PC is connected (`getConnectedPcId()` resolves a pcId) → render
 *     `children` (the rest of the authenticated ladder talks to the stable
 *     `<gatewayBase>/t/<pcId>` relay endpoint via `getRelayUrl()`).
 *   - No PC connected → an OPTIONAL Apple-reviewer pre-step: if
 *     `config.getReviewerCredentials` resolves a `{ gatewayBase, pcId, token }`
 *     triple, the dedicated App-Store reviewer is linked + connected WITHOUT the QR
 *     scanner; any non-reviewer (`null` / `403` / error) falls through.
 *   - Still no PC → mount {@link PcConnectGate}: pairing is QR-ONLY (the `/my-pcs`
 *     picker is dropped), so it goes straight to the scanner. A scanned QR is
 *     saved (its JWT keyed by `pcId`) then connected; a successful connect flips
 *     the host to `connected` and renders `children`.
 *
 * Every collaborator is an injected seam ({@link PcConnectConfig}) so the gate
 * runs deterministically under RNTL with no native modules / Clerk. The device
 * build supplies the config via `buildPcConnectConfig` in the authenticated layout.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { LoadingSplash } from '../../components/LoadingSplash';
import {
  PcConnectGate,
  getConnectedPcId as defaultGetConnectedPcId,
  usePcConnectionStore,
  type PcConnectConfig,
} from '../pc-connect';

type Phase = 'checking' | 'connect' | 'connected';

export interface PcConnectGateHostProps {
  config: PcConnectConfig;
  children: ReactNode;
}

export function PcConnectGateHost({ config, children }: PcConnectGateHostProps) {
  const getConnectedPcId = config.getConnectedPcId ?? defaultGetConnectedPcId;
  const [phase, setPhase] = useState<Phase>('checking');

  // Resolve the connected-PC state once on mount. A persisted pcId means a
  // returning device → straight through to the app; none → try the reviewer fast
  // path, else show the QR gate.
  useEffect(() => {
    let alive = true;

    // Apple-reviewer pre-step: only runs when NO PC is connected and the seam
    // is supplied. A `200` triple → link (save-only) + connect, skipping the QR
    // scanner entirely; `null` / any error → fall through to the normal QR flow.
    // Reuses the production `onLink` (= linkPc) + `onConnect` (= connectToPc) seams
    // verbatim — no new connect path.
    async function tryReviewerBypass(): Promise<boolean> {
      if (!config.getReviewerCredentials) return false;
      try {
        const creds = await config.getReviewerCredentials();
        if (!creds) return false;
        await config.onLink({
          gatewayBase: creds.gatewayBase,
          pcId: creds.pcId,
          token: creds.token,
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
        if (alive) setPhase('connected');
        return;
      }
      const bypassed = await tryReviewerBypass();
      if (alive) setPhase(bypassed ? 'connected' : 'connect');
    })();

    return () => {
      alive = false;
    };
  }, [getConnectedPcId, config]);

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

  return (
    <PcConnectGate
      onLink={config.onLink}
      onConnected={(pcId) => {
        // The QR's JWT is now saved for this pcId (onLink). connectToPc (via the
        // config seam) persists the connected pcId on a validated relay endpoint;
        // only then do we render the app. An unhealthy/unlinked PC resolves
        // `false` → stay on the scanner so the user can re-scan (a rotation
        // re-points automatically).
        void config
          .onConnect(pcId)
          .then((ready) => {
            if (ready) setPhase('connected');
          })
          .catch(() => {
            /* Stay on the scanner; the user can retry. */
          });
      }}
    />
  );
}
