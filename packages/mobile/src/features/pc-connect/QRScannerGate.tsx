/**
 * QRScannerGate (QR pairing) — connect to a PC by SCANNING its pairing QR.
 *
 * The launcher's terminal (or its loopback pairing page) shows a QR encoding a
 * {@link QrLinkPayload} JSON (`{ gatewayBase, pcId, token }`). Connection is
 * SCAN-ONLY: the user never sees or types that payload, so there is no manual-entry
 * field — the gate goes straight to the live camera reader ({@link QrCameraScanner},
 * `expo-camera`).
 *
 * Every decode runs through {@link parseQrPayload}; a malformed payload surfaces a
 * `qr-scanner-error` screen with `qr-scanner-retry` (re-scan, no crash), and a valid
 * one is handed up via `onPayload` — the caller saves the QR's data-path JWT keyed
 * by `pcId` (save-only, no gateway round-trip).
 *
 * The camera reader is REQUIRED at render time (not a top-level import / `React.lazy`)
 * so `expo-camera` never enters the Jest module graph until the camera actually
 * renders — and so we avoid react-test-renderer 19's lazy/Suspense crash under
 * jest-expo (the FileViewer `loadPdfViewer` pattern). Tests `jest.mock` the module.
 *
 * testIDs: `qr-scanner` (root, present in every state), `qr-scanner-error`,
 * `qr-scanner-retry`, `qr-scanner-cancel`. The camera itself exposes `qr-camera*`
 * (see {@link QrCameraScanner}).
 */

import { useState } from 'react';
import type { ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { QrLinkPayload } from '@vgit2/shared/types';

import { Icon, useAppTheme } from '../../theme';

import { parseQrPayload } from './parseQrPayload';
import type { QrCameraScannerProps } from './QrCameraScanner';

// Device-only camera reader, loaded synchronously at render time so `expo-camera` is
// only pulled in once the camera branch actually mounts (and stays out of any
// consumer that never reaches it). See the file docstring.
function loadQrCameraScanner(): ComponentType<QrCameraScannerProps> {
  return require('./QrCameraScanner').default as ComponentType<QrCameraScannerProps>;
}

export interface QRScannerGateProps {
  /**
   * Receives a VALIDATED pairing payload scanned from the QR. The caller persists
   * the QR's data-path JWT keyed by `pcId` (`linkPc`, save-only).
   */
  onPayload: (payload: QrLinkPayload) => void;
  /** Back out of linking (cancel). */
  onCancel: () => void;
}

export function QRScannerGate({ onPayload, onCancel }: QRScannerGateProps) {
  const { theme } = useAppTheme();
  const [error, setError] = useState<string | null>(null);

  // Validate a decoded QR string; valid → bubble up, invalid → error+retry.
  const submit = (raw: string) => {
    const payload = parseQrPayload(raw);
    console.warn(
      '[QRDBG] parseQrPayload →',
      payload ? `OK pcId=${payload.pcId} gw=${payload.gatewayBase}` : 'NULL (invalid)'
    );
    if (!payload) {
      setError(
        "That QR code isn't a valid Portable pairing code. Run `portable start` on your computer and scan the QR shown in the terminal."
      );
      return;
    }
    setError(null);
    onPayload(payload);
  };

  if (error) {
    return (
      <View
        style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}
        testID="qr-scanner"
      >
        <View testID="qr-scanner-error" style={styles.errorBox}>
          <Icon name="warning" size={28} color={theme.colors.danger} />
          <Text style={[styles.errorTitle, { color: theme.colors.text }]}>
            Couldn&apos;t read that code
          </Text>
          <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>{error}</Text>
          <Pressable
            testID="qr-scanner-retry"
            onPress={() => setError(null)}
            style={[styles.button, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={styles.buttonText}>Scan again</Text>
          </Pressable>
          <Pressable testID="qr-scanner-cancel" onPress={onCancel} style={styles.cancel}>
            <Text style={[styles.cancelText, { color: theme.colors.textSecondary }]}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const QrCameraScanner = loadQrCameraScanner();
  return (
    <View style={styles.container} testID="qr-scanner">
      <QrCameraScanner onScan={submit} onClose={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorBox: { alignItems: 'center', gap: 12, maxWidth: 360 },
  errorTitle: { fontSize: 18, fontWeight: '700' },
  errorText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  button: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  cancel: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { fontSize: 14 },
});
