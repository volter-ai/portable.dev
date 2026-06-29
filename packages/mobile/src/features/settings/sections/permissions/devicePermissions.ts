/**
 * Device permission adapters — the ONLY module that touches the native
 * permission modules (`expo-notifications` / `expo-audio` / `expo-camera`).
 *
 * The native modules are loaded **lazily** via `require` inside the functions
 * (lazy-required — never a top-level `import` value), so importing this
 * file / `PermissionsScreen` does NOT pull the native modules into the
 * Jest/Metro module graph; only an actual `checkStatus`/`requestPermission`
 * call resolves them. TYPES come from `import type` (Babel-erased), so the
 * typecheck stays accurate without loading the modules.
 *
 * NOTHING is persisted — device permissions are OS state, re-checked on every
 * mount.
 */

import { Linking, Platform } from 'react-native';

// `PermissionResponse` is re-exported by every expo permission module; expo-audio
// is a direct dep, so its re-export is the safe type-only resolution path.
import type { PermissionResponse } from 'expo-audio';

/** The three permission types the native app can actually check/request today. */
export type ActiveDevicePermissionType = 'notifications' | 'camera' | 'microphone';

/** All card types — `geolocation` is the "Future Permissions" placeholder. */
export type DevicePermissionType = ActiveDevicePermissionType | 'geolocation';

/** Normalized OS permission status (`PermissionResult.status` minus `unavailable`). */
export type DevicePermissionStatus = 'granted' | 'denied' | 'prompt';

export interface DevicePermissionResult {
  status: DevicePermissionStatus;
}

export interface PermissionMetadata {
  name: string;
  description: string;
  /** Why the app needs this permission (appended to the description). */
  purpose: string;
  /** What features are blocked without it (UI-only documentation). */
  blockedFeatures: string[];
  /** Text glyph standing in for a FontAwesome icon (closed icon union rule). */
  glyph: string;
}

/** Device-permission metadata. */
export const PERMISSION_METADATA: Record<DevicePermissionType, PermissionMetadata> = {
  notifications: {
    name: 'Notifications',
    description: 'Permission to show notifications',
    purpose: 'to alert you when tasks are complete or important events occur',
    blockedFeatures: ['Background notifications', 'Task completion alerts', 'PR updates'],
    glyph: '🔔',
  },
  camera: {
    name: 'Camera',
    description: 'Access to your device camera',
    purpose: 'to capture photos and scan QR codes',
    blockedFeatures: ['Photo capture', 'QR code scanning', 'Video recording'],
    glyph: '📷',
  },
  microphone: {
    name: 'Microphone',
    description: 'Access to your device microphone',
    purpose: 'to record voice messages and use voice input features',
    blockedFeatures: ['Voice input', 'Audio recording', 'Voice commands'],
    glyph: '🎤',
  },
  geolocation: {
    name: 'Location',
    description: 'Access to your device location',
    purpose: 'to provide location-based features',
    blockedFeatures: ['Location tagging', 'Location-based services'],
    glyph: '📍',
  },
};

/** Card order: notifications → camera → microphone under "Active Permissions". */
export const ACTIVE_PERMISSION_TYPES: readonly ActiveDevicePermissionType[] = [
  'notifications',
  'camera',
  'microphone',
];

/** "Future Permissions": rendered disabled, status NEVER fetched. */
export const FUTURE_PERMISSION_TYPES: readonly DevicePermissionType[] = ['geolocation'];

// ── Lazy native module resolution ────────────────────────────────────────────

function getNotificationsModule(): typeof import('expo-notifications') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-notifications') as typeof import('expo-notifications');
}

function getAudioModule(): typeof import('expo-audio') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-audio') as typeof import('expo-audio');
}

function getCameraModule(): typeof import('expo-camera') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-camera') as typeof import('expo-camera');
}

/** Map an Expo `PermissionResponse` (`granted|denied|undetermined`) to the card status. */
function toResult(
  response: Pick<PermissionResponse, 'granted' | 'status'>
): DevicePermissionResult {
  if (response.granted || response.status === 'granted') return { status: 'granted' };
  if (response.status === 'denied') return { status: 'denied' };
  return { status: 'prompt' };
}

/**
 * Check the current OS permission status for an active type. Geolocation is
 * intentionally NOT accepted (future cards never fetch status).
 */
export async function checkStatus(
  type: ActiveDevicePermissionType
): Promise<DevicePermissionResult> {
  switch (type) {
    case 'notifications':
      return toResult(await getNotificationsModule().getPermissionsAsync());
    case 'microphone':
      return toResult(await getAudioModule().getRecordingPermissionsAsync());
    case 'camera':
      // expo-camera exposes the imperative permission fns on the `Camera` object
      // (the top-level exports are the hook variants only).
      return toResult(await getCameraModule().Camera.getCameraPermissionsAsync());
  }
}

/** Show the native OS permission prompt for an active type. */
export async function requestPermission(
  type: ActiveDevicePermissionType
): Promise<DevicePermissionResult> {
  switch (type) {
    case 'notifications':
      return toResult(await getNotificationsModule().requestPermissionsAsync());
    case 'microphone':
      return toResult(await getAudioModule().requestRecordingPermissionsAsync());
    case 'camera':
      return toResult(await getCameraModule().Camera.requestCameraPermissionsAsync());
  }
}

/**
 * Platform-specific re-enable instructions (the RN client always shows the
 * native-app text).
 */
export function getSettingsInstructions(): string {
  return Platform.OS === 'ios'
    ? 'Open Settings → Portable → enable the permission'
    : 'Open Settings → Apps → Portable → Permissions → enable the permission';
}

/**
 * Deep-link into the OS settings page for this app (the native counterpart to
 * an alert-with-instructions). `Linking` is react-native core, not a
 * native permission module — safe to reference at module scope.
 */
export function openSystemSettings(): void {
  void Linking.openSettings();
}
