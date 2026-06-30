/**
 * QrCameraScanner — the live `expo-camera` QR reader.
 *
 * DEVICE-ONLY: it imports the native camera module, so — exactly like
 * {@link CameraCapture} — it is loaded LAZILY (`React.lazy`/dynamic import in
 * {@link QRScannerGate}) and never enters the Jest module graph. The on-device
 * scan path is part of the deferred device-acceptance pass; the Jest tests cover
 * the manual-entry + parse/error paths through `QRScannerGate`.
 *
 * It is purely a CAMERA → raw-string seam: it scans a QR, hands the raw decoded
 * string up via `onScan`, and never parses/validates (that is `parseQrPayload`,
 * owned by `QRScannerGate`) — keeping the native dependency isolated to this one
 * file.
 *
 * A bracketed viewfinder frame is drawn over the live preview so the user knows
 * exactly where to hold the code (the single biggest lever for real-world scan
 * success — an unframed preview lets people hold the code too far/too close/off
 * to a side, which is the main reason this felt less reliable than the iOS system
 * scanner). The moment a code decodes, `pausePreview()` freezes the feed, the
 * corners + a checkmark turn green, and the device vibrates — without that, the
 * scan had already succeeded but the screen gave no sign of it while the parent's
 * async pairing/connect chain ran, which read as "it isn't detecting."
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, Vibration, View } from 'react-native';

import { Icon, useAppTheme } from '../../theme';

export interface QrCameraScannerProps {
  /** Receives the RAW decoded QR string (validated/parsed by the parent). */
  onScan: (raw: string) => void;
  /** Close the camera (back to manual entry / the picker). */
  onClose: () => void;
}

const CORNER_LENGTH = 32;
const CORNER_THICKNESS = 3;

export default function QrCameraScanner({ onScan, onClose }: QrCameraScannerProps) {
  const { theme } = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // A scan fires `onBarcodeScanned` repeatedly while the code is in frame; latch
  // so the parent only ever receives the FIRST decode.
  const scannedRef = useRef(false);
  // Ask for permission at most once per mount.
  const askedRef = useRef(false);
  const cameraRef = useRef<CameraView>(null);
  // Drives the success visuals (the ref above is the synchronous guard; this is
  // just for render).
  const [scanned, setScanned] = useState(false);

  // Request camera permission the moment the scanner opens — BEFORE any CameraView is
  // mounted — so the OS prompt is the first thing the user sees and the camera hardware
  // is never accessed without a granted permission. If the user declines, the
  // `!permission.granted` fallback below (Open Settings / Enter code manually) renders.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !askedRef.current) {
      askedRef.current = true;
      void requestPermission();
    }
  }, [permission, requestPermission]);

  if (!permission) {
    return <View style={styles.container} testID="qr-camera-loading" />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.permission} testID="qr-camera-permission">
        <Text style={styles.permissionText}>
          Camera access is needed to scan the pairing QR code.
        </Text>
        <Pressable
          testID="qr-camera-grant"
          style={[styles.button, { backgroundColor: theme.colors.primary }]}
          onPress={() =>
            permission.canAskAgain ? void requestPermission() : void Linking.openSettings()
          }
        >
          <Text style={styles.buttonText}>
            {permission.canAskAgain ? 'Grant access' : 'Open Settings'}
          </Text>
        </Pressable>
        <Pressable testID="qr-camera-cancel" onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const handleBarcodeScanned = ({ data }: BarcodeScanningResult) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanned(true);
    Vibration.vibrate(40);
    void cameraRef.current?.pausePreview().catch(() => undefined);
    onScan(data);
  };

  const cornerStyle = scanned ? { borderColor: theme.colors.success } : null;

  return (
    <View style={styles.container} testID="qr-camera">
      <View style={styles.cameraArea}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.mask} />
          <View style={styles.frameRow}>
            <View style={styles.mask} />
            <View style={styles.frame}>
              <View style={[styles.corner, styles.cornerTopLeft, cornerStyle]} />
              <View style={[styles.corner, styles.cornerTopRight, cornerStyle]} />
              <View style={[styles.corner, styles.cornerBottomLeft, cornerStyle]} />
              <View style={[styles.corner, styles.cornerBottomRight, cornerStyle]} />
              {scanned && <Icon name="check" size={36} color={theme.colors.success} />}
            </View>
            <View style={styles.mask} />
          </View>
          <View style={styles.mask} />
        </View>
      </View>
      <View style={styles.controls}>
        <Text style={styles.caption}>
          {scanned ? 'Code detected!' : 'Scan the QR code shown on your computer'}
        </Text>
        <Pressable testID="qr-camera-close" onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

// The camera viewfinder is immersive OS-style chrome (black scrim, white text/
// brackets) by design — like every system camera/scanner UI, it deliberately does
// NOT follow the user's selected app theme/brightness (the same exemption as
// `signInTheme.ts`). `theme.colors.success` is the one themed color in this file,
// used only for the genuinely semantic "scan succeeded" state.
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  cameraArea: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, flexDirection: 'column' },
  mask: { flex: 1, backgroundColor: '#0000008C' },
  frameRow: { flexDirection: 'row' },
  frame: {
    width: '72%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  corner: {
    position: 'absolute',
    width: CORNER_LENGTH,
    height: CORNER_LENGTH,
    borderColor: '#fff',
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
  },
  controls: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingBottom: 48,
    paddingTop: 16,
  },
  caption: { color: '#fff', fontSize: 14, textAlign: 'center', opacity: 0.9 },
  permission: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  permissionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  button: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  buttonText: { color: '#fff', fontWeight: '700' },
  cancelText: { color: '#fff', fontSize: 15 },
});
