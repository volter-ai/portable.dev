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
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';

export interface QrCameraScannerProps {
  /** Receives the RAW decoded QR string (validated/parsed by the parent). */
  onScan: (raw: string) => void;
  /** Close the camera (back to manual entry / the picker). */
  onClose: () => void;
}

export default function QrCameraScanner({ onScan, onClose }: QrCameraScannerProps) {
  const { theme } = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // A scan fires `onBarcodeScanned` repeatedly while the code is in frame; latch
  // so the parent only ever receives the FIRST decode.
  const scannedRef = useRef(false);
  // Ask for permission at most once per mount.
  const askedRef = useRef(false);

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

  return (
    <View style={styles.container} testID="qr-camera">
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          console.warn(
            '[QRDBG] onBarcodeScanned fired, len=',
            data?.length,
            'head=',
            String(data).slice(0, 40)
          );
          if (scannedRef.current) return;
          scannedRef.current = true;
          onScan(data);
        }}
      />
      <View style={styles.controls}>
        <Text style={styles.caption}>Scan the QR code shown on your computer</Text>
        <Pressable testID="qr-camera-close" onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
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
