/**
 * PcConnectModal (QR pairing) — a full-screen RE-SCAN flow reachable from
 * INSIDE the app, after the initial pairing.
 *
 * The boot-time {@link PcConnectGate} only mounts the scanner when NO pcId is
 * persisted, so once a device is pointed at a PC there is no way back to the
 * scanner — yet the PC connection is volatile (the gateway's TunnelRegistry is
 * in-memory and lapses when the launcher stops or the gateway restarts; a token
 * minted with a mismatched `JWT_SECRET` 401s). This modal gives a reachable
 * "Connect PC" affordance: scan the pairing QR again → {@link resetAndLinkPc}
 * (drop any stale pairing, then save the fresh JWT + E2E key) →
 * {@link connectToPc connect} (which now ALSO validates the token, see
 * {@link verifyTunnelAddress}) → on success the app is re-pointed at the PC.
 *
 * It replaced the misleading "Connect GitHub" repos-error button on Home + Repos
 * (the failure there is the PC connection, not GitHub) and backs the always-on
 * Settings → "Connect PC" entry.
 *
 * Every I/O seam is injectable so it unit-tests with no native module: the default
 * scanner ({@link QRScannerGate}) lazy-loads `expo-camera` only when RENDERED, so a
 * test that injects `renderScanner` never pulls the camera into the Jest graph.
 *
 * testIDs: `pc-connect-modal` (root), `pc-connect-connecting`, `pc-connect-error`,
 * `pc-connect-retry`, `pc-connect-cancel`. The scanner exposes its own `qr-scanner*`.
 */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { QrLinkPayload } from '@vgit2/shared/types';

import { getGatewayUrl } from '../auth/gatewayConfig';
import { Icon, useAppTheme } from '../../theme';

import { connectToPc, type ConnectToPcResult, type ConnectToPcReason } from './connectToPc';
import { resetAndLinkPc } from './linkPc';
import { QRScannerGate } from './QRScannerGate';

type Phase = 'scan' | 'connecting' | 'error';

/** Props for the scanner seam (so tests inject a fake that just fires `onPayload`). */
export interface PcConnectScannerProps {
  onPayload: (payload: QrLinkPayload) => void;
  onCancel: () => void;
}

export interface PcConnectModalProps {
  /** Show the modal. Renders `null` when false (deterministic `queryByTestId`). */
  visible: boolean;
  /** Close the modal (Cancel, or a successful connect). */
  onDismiss: () => void;
  /** Fired after a successful connect — the app is now pointed at the PC. */
  onConnected?: () => void;
  /**
   * Fired ONLY on a user-initiated cancel (the Cancel control or the scanner's
   * back-out) — NOT on the auto-close after a successful connect. The stuck
   * "Can't reach your PC" recovery wires this to {@link disconnectPc} so giving up
   * on a re-scan clears the stale pairing and returns to the connect landing,
   * instead of bouncing back to the same dead screen. Optional — when omitted a
   * cancel just closes (the Settings/Home/Repos re-scan: the app is working, so a
   * cancel must NOT drop a live pairing).
   */
  onCancel?: () => void;
  /** Seam: persist the scanned QR's JWT. Default: {@link saveDeviceToken}. */
  link?: (payload: QrLinkPayload) => Promise<void>;
  /**
   * Seam: connect using the just-stored token. Default: {@link connectToPc} against
   * the canonical `getGatewayUrl()` (parity with the boot `buildPcConnectConfig`).
   */
  connect?: (pcId: string) => Promise<ConnectToPcResult>;
  /** Seam: render the QR scanner. Default: {@link QRScannerGate} (lazy camera). */
  renderScanner?: (props: PcConnectScannerProps) => ReactNode;
}

/** Friendly copy for a non-ready connect result (never the raw reason code). */
function messageForReason(reason?: ConnectToPcReason): string {
  if (reason === 'unhealthy') {
    return "Your PC isn't responding (or it rejected this pairing code). Make sure `portable start` is running on your computer, then scan the QR again.";
  }
  // 'no-token' should not happen right after a scan (we just saved it) — be safe.
  return "Couldn't connect to your PC. Scan the pairing QR shown in the launcher terminal again.";
}

export function PcConnectModal({
  visible,
  onDismiss,
  onConnected,
  onCancel,
  link,
  connect,
  renderScanner,
}: PcConnectModalProps) {
  const { theme } = useAppTheme();
  const [phase, setPhase] = useState<Phase>('scan');
  const [error, setError] = useState<string | null>(null);

  // Default re-scan persistence: the SINGLE shared resetAndLinkPc — wipe any
  // existing pairing first (treat a re-scan as a fresh disconnect + connect) then
  // save the fresh QR's JWT AND E2E key. This is what fixes the "No E2E key for
  // the connected PC" error on re-pair; every reconnection screen uses this same
  // default, so the save can never drift out of sync again (portable.dev#13).
  const doLink = link ?? (async (p: QrLinkPayload) => void (await resetAndLinkPc(p)));
  const doConnect = connect ?? ((id: string) => connectToPc(id, { gatewayBase: getGatewayUrl() }));
  const scanner = renderScanner ?? ((p: PcConnectScannerProps) => <QRScannerGate {...p} />);

  const reset = () => {
    setPhase('scan');
    setError(null);
  };
  // close() is the success-path auto-close: reset + dismiss, NEVER `onCancel`.
  const close = () => {
    reset();
    onDismiss();
  };
  // cancel() is the user backing out (Cancel control / scanner back-out / hardware
  // back): fire the cancel seam (so the stuck recovery can clear the stale pairing)
  // THEN close. Distinct from close() so a successful connect never fires onCancel.
  const cancel = () => {
    onCancel?.();
    close();
  };

  const handlePayload = (payload: QrLinkPayload) => {
    setError(null);
    setPhase('connecting');
    void (async () => {
      try {
        await doLink(payload);
        const result = await doConnect(payload.pcId);
        if (result.ready) {
          onConnected?.();
          close();
          return;
        }
        setError(messageForReason(result.reason));
        setPhase('error');
      } catch {
        setError(
          "Couldn't connect to your PC. Make sure `portable start` is running on your computer, then scan again."
        );
        setPhase('error');
      }
    })();
  };

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={cancel}>
      <View
        style={[styles.root, { backgroundColor: theme.colors.background }]}
        testID="pc-connect-modal"
      >
        {phase === 'scan' ? scanner({ onPayload: handlePayload, onCancel: cancel }) : null}

        {phase === 'connecting' ? (
          <View style={styles.centered} testID="pc-connect-connecting">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.caption, { color: theme.colors.textSecondary }]}>
              Connecting to your PC…
            </Text>
          </View>
        ) : null}

        {phase === 'error' ? (
          <View style={styles.centered} testID="pc-connect-error">
            <Icon name="warning" size={28} color={theme.colors.danger} />
            <Text style={[styles.title, { color: theme.colors.text }]}>Couldn&apos;t connect</Text>
            <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{error}</Text>
            <Pressable
              testID="pc-connect-retry"
              accessibilityRole="button"
              onPress={reset}
              style={[styles.button, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={styles.buttonText}>Scan again</Text>
            </Pressable>
            <Pressable testID="pc-connect-cancel" accessibilityRole="button" onPress={cancel}>
              <Text style={[styles.cancelText, { color: theme.colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  caption: { fontSize: 14, textAlign: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 360 },
  button: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  cancelText: { fontSize: 14, paddingVertical: 12 },
});
