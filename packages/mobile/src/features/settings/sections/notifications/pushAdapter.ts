/**
 * Native push-notification device adapter — splits the two native concerns it
 * proxies and lazy-`require`s BOTH native modules, so importing this file — or
 * the ViewModel / screen that defaults to it — never pulls a native module into
 * the Jest/Metro graph:
 *
 *  - **Permission** (`getPermissionState` / `requestPermission`) → `expo-notifications`
 *    (UNUserNotificationCenter authorization). The rest of the push UX —
 *    foreground display handler, notification-tap deep-linking, the Android
 *    channel — also stays on `expo-notifications` (see `PushSetupLayer`).
 *  - **Device token** (`getDeviceToken`) → **`@react-native-firebase/messaging`**
 *    `getToken()`, which returns a real **FCM registration token** on BOTH iOS and
 *    Android. The backend delivers to native devices
 *    EXCLUSIVELY via Firebase Cloud Messaging (`admin.messaging().send({ token })`),
 *    so it needs an FCM token — NOT the raw APNs device token. On iOS,
 *    `expo-notifications`' `getDevicePushTokenAsync()` returns the raw APNs token
 *    (a hex string), which FCM rejects with `messaging/invalid-argument`; the
 *    Firebase iOS SDK performs the APNs→FCM exchange and yields the FCM token.
 *    One token implementation for both platforms.
 *
 * Firebase is wired via the `@react-native-firebase/app` Expo config plugin +
 * `GoogleService-Info.plist` / `google-services.json` (same Firebase project
 * `portable-6ac02` / bundle `dev.portable.app`, so the project's already-uploaded
 * APNs key delivers iOS pushes). The native
 * modules resolve lazily via `require(...)` inside the methods; TYPES come from
 * `import type` (Babel-erased), so typecheck stays accurate without loading them.
 *
 * The token is POSTed to `/api/push/subscribe` with the body
 * `subscription: { endpoint, platform, fcmToken }`, which the backend
 * accepts as a native subscription (no VAPID keys required).
 *
 * Device-only acceptance (a REAL FCM token from a physical device / dev-client
 * build + an actual APNs→FCM round-trip) is deferred to the established final
 * device pass — Jest and the simulator cannot mint real push tokens, and tests
 * inject a fake {@link PushAdapter} so neither native module is ever loaded.
 */

import { Platform } from 'react-native';

import type * as ExpoNotifications from 'expo-notifications';
import type * as RNFirebaseMessaging from '@react-native-firebase/messaging';

/** Static surface of the `expo-notifications` module (type-only). */
type NotificationsModule = typeof ExpoNotifications;

/** Static surface of the `@react-native-firebase/messaging` module (type-only). */
type MessagingModule = typeof RNFirebaseMessaging;

/** Tri-state device notification permission. */
export type PushPermissionState = 'granted' | 'denied' | 'undetermined';

/** The seam the ViewModel consumes — fakeable in Jest with zero native code. */
export interface PushAdapter {
  /** Current permission state WITHOUT prompting. */
  getPermissionState(): Promise<PushPermissionState>;
  /** Prompt the OS permission dialog; resolves with the resulting state. */
  requestPermission(): Promise<PushPermissionState>;
  /** The device's **FCM registration token** (both iOS and Android). */
  getDeviceToken(): Promise<string>;
}

/**
 * Lazily resolve `expo-notifications`. Kept out of module scope so the native
 * module never loads at import time (Jest / Metro graph stays clean).
 */
function getNotifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-notifications') as NotificationsModule;
}

/**
 * Lazily resolve `@react-native-firebase/messaging` (the FCM token source). Same
 * lazy-require rationale as {@link getNotifications}: tests inject a fake adapter
 * and never load it.
 */
function getMessaging(): MessagingModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('@react-native-firebase/messaging') as MessagingModule;
}

/**
 * Map an expo permission response to the tri-state. Structural param (`status`
 * is the expo-modules-core string enum, assignable to `string`) so no VALUE
 * import from the native module is needed.
 */
function toPermissionState(response: { granted: boolean; status: string }): PushPermissionState {
  if (response.granted || response.status === 'granted') return 'granted';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}

/** The production adapter over `expo-notifications` + `@react-native-firebase/messaging`. */
export function createExpoPushAdapter(): PushAdapter {
  return {
    async getPermissionState() {
      return toPermissionState(await getNotifications().getPermissionsAsync());
    },
    async requestPermission() {
      return toPermissionState(await getNotifications().requestPermissionsAsync());
    },
    async getDeviceToken() {
      const messaging = getMessaging();
      const instance = messaging.getMessaging();
      // iOS: the Firebase SDK can only mint the FCM token once the APNs token has
      // been set on the Messaging instance. `registerDeviceForRemoteMessages`
      // resolves only AFTER that token arrives (its delegate sets the APNs token
      // BEFORE resolving the promise), so ALWAYS await it on iOS — it is
      // idempotent. Do NOT gate on the sync `isDeviceRegisteredForRemoteMessages`
      // getter: it reflects `[UIApplication isRegisteredForRemoteNotifications]`,
      // which flips true the moment registration is REQUESTED at launch (Firebase
      // auto-init) — BEFORE the APNs token callback. Gating on it would skip the
      // await in the cold-start race and let `getToken` run with a nil APNs token
      // (→ a `messaging/invalid-argument`-class reject). No-op on Android.
      if (Platform.OS === 'ios') {
        await messaging.registerDeviceForRemoteMessages(instance);
      }
      // Real FCM registration token on both platforms — the value FCM
      // (`admin.messaging().send({ token })`) actually accepts.
      return await messaging.getToken(instance);
    },
  };
}
