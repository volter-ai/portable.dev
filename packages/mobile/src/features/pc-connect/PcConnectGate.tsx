/**
 * PcConnectGate (QR pairing) — the post-Clerk-sign-in PC-connect gate.
 *
 * Connection is QR-ONLY: the `/my-pcs` Clerk-authed
 * discovery is dropped, so there is no PC picker. The gate is **landing-first**:
 * after sign-in (and after a Runtime-tab "Disconnect") it shows the
 * {@link PcConnectLanding} intro ("Connect your PC" + steps + a "Scan QR code"
 * button) — NOT the live camera. The camera ({@link QRScannerGate}) opens ONLY when
 * the user taps "Scan QR code", so we never touch the camera / fire the OS permission
 * prompt without an explicit action. A scanned, validated {@link QrLinkPayload}
 * (`{ gatewayBase, pcId, token }`) → `onLink` saves the QR's data-path JWT keyed by
 * `pcId` (no gateway round-trip) → `onConnected(pcId)` lets the host point the app at
 * `<gatewayBase>/t/<pcId>`; cancelling the camera returns to the landing.
 *
 * `onLink` / `onConnected` are injectable seams so the flow renders deterministically
 * under RNTL with no native modules.
 */

import { useState } from 'react';

import type { QrLinkPayload } from '@vgit2/shared/types';

import { PcConnectLanding } from './PcConnectLanding';
import { QRScannerGate } from './QRScannerGate';

export interface PcConnectGateProps {
  /**
   * Persist the scanned QR's data-path JWT keyed by `pcId` (save-only, no gateway
   * round-trip). Resolves on success.
   */
  onLink: (payload: QrLinkPayload) => Promise<void>;
  /**
   * Connect to the just-linked PC: point the app at
   * `<gatewayBase>/t/<pcId>` and render the authenticated tree. Optional — when
   * omitted the host owns the connect after `onLink` resolves.
   */
  onConnected?: (pcId: string) => void;
}

export function PcConnectGate({ onLink, onConnected }: PcConnectGateProps) {
  // Landing-first: the camera opens only after the user taps "Scan QR code".
  const [scanning, setScanning] = useState(false);

  if (!scanning) {
    return <PcConnectLanding onScan={() => setScanning(true)} />;
  }

  return (
    <QRScannerGate
      onCancel={() => setScanning(false) /* back to the landing */}
      onPayload={(payload) => {
        // Save the QR's JWT (parent-owned, save-only); on success the device now
        // holds the credential for this pcId, so connect straight. A failed save
        // keeps the user on the scanner to retry.
        console.warn('[QRDBG] onPayload → linking pcId=', payload.pcId);
        void onLink(payload)
          .then(() => {
            console.warn('[QRDBG] onLink OK → onConnected(', payload.pcId, ')');
            return onConnected?.(payload.pcId);
          })
          .then(() => console.warn('[QRDBG] onConnected resolved'))
          .catch((e) => {
            console.warn('[QRDBG] onLink/onConnected THREW:', String(e?.message ?? e));
          });
      }}
    />
  );
}
