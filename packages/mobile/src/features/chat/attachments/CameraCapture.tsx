/**
 * CameraCapture — full-screen camera capture via `expo-camera`.
 * DEVICE-ONLY: it imports the native camera module, so it is loaded LAZILY (via
 * `React.lazy`/dynamic import in {@link AttachmentBar}) and never enters the Jest
 * module graph (the integration test covers the library-pick + upload path; the
 * camera path is the device-only final-pass acceptance per the PRD).
 *
 * Mirrors the voice adapter pattern: this is the only file importing `expo-camera`,
 * and it normalises the captured photo into the framework-free `PickedFile`.
 */

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../../theme';

import type { PickedFile } from './attachment';

export interface CameraCaptureProps {
  /** Receives the captured photo (already a local file URI). */
  onCapture: (file: PickedFile) => void;
  /** Close the camera without capturing. */
  onClose: () => void;
}

export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const { theme } = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView | null>(null);

  if (!permission) {
    return <View style={styles.container} testID="camera-loading" />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.permission} testID="camera-permission">
        <Text style={styles.permissionText}>Camera access is needed to take a photo.</Text>
        <Pressable
          testID="camera-grant"
          style={[styles.button, { backgroundColor: theme.colors.primary }]}
          onPress={() => void requestPermission()}
        >
          <Text style={styles.buttonText}>Grant access</Text>
        </Pressable>
        <Pressable testID="camera-cancel" onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const capture = async () => {
    const ref = cameraRef.current;
    if (!ref) return;
    const photo = await ref.takePictureAsync({ quality: 0.9 });
    if (!photo?.uri) return;
    onCapture({
      uri: photo.uri,
      name: `photo-${photo.uri.split('/').pop() ?? 'capture.jpg'}`,
      mimeType: 'image/jpeg',
      width: photo.width,
      height: photo.height,
      source: 'camera',
    });
  };

  return (
    <View style={styles.container} testID="camera-capture">
      <CameraView ref={cameraRef} style={styles.camera} facing="back" />
      <View style={styles.controls}>
        <Pressable testID="camera-close" onPress={onClose}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable testID="camera-shutter" style={styles.shutter} onPress={() => void capture()} />
        <View style={styles.spacer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 48,
    paddingTop: 16,
  },
  shutter: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: '#9ca3af',
  },
  spacer: { width: 60 },
  permission: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
  },
  permissionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  button: {
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: { color: '#fff', fontWeight: '700' },
  cancelText: { color: '#fff', fontSize: 15 },
});
