/**
 * PushSetupLayer — global push-notification setup, mounted ONCE by `AppShell`
 * inside `ApiProvider` (after the gate ladder: authenticated, onboarded,
 * provisioned, server healthy — so `PushPermissionPrompt`'s subscribe POST has a
 * live sandbox + API client). A render layer that renders only the (initially
 * invisible) permission modal.
 *
 * On mount:
 *   1. `setNotificationHandler` — foreground notifications surface as alerts.
 *   2. `setNotificationChannelAsync('portable-notifications', …)` — Android only;
 *      the channel id the backend `FcmService` targets (`channelId:
 *      'portable-notifications'`).
 *   3. {@link usePushDeepLink} — notification taps → the target chat.
 *   4. {@link PushPermissionPrompt} — the one-time "Enable notifications" ask.
 *
 * `expo-notifications` is lazy-`require`d (the `pushAdapter.ts` seam), so importing
 * this layer never pulls the native module into the Jest/Metro graph.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';

import type * as ExpoNotifications from 'expo-notifications';

import { PushPermissionPrompt, type PushPermissionPromptDeps } from './PushPermissionPrompt';
import { usePushDeepLink, type UsePushDeepLinkDeps } from './usePushDeepLink';

/** Static surface of the `expo-notifications` module (type-only). */
type NotificationsModule = typeof ExpoNotifications;

/** The Android channel id the backend `FcmService` sends notifications on. */
export const PUSH_NOTIFICATION_CHANNEL_ID = 'portable-notifications';

/** Lazily resolve `expo-notifications` (never at import time). */
function getNotifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-notifications') as NotificationsModule;
}

export interface PushSetupLayerDeps {
  /** Override the prompt deps (adapter injection for tests). */
  prompt?: PushPermissionPromptDeps;
  /** Override the deep-link deps (router injection for tests). */
  deepLink?: UsePushDeepLinkDeps;
}

export interface PushSetupLayerProps {
  deps?: PushSetupLayerDeps;
}

/**
 * Coordinator that wires the global push-notification setup. Renders the
 * (initially hidden) one-time permission prompt; everything else is a side effect.
 */
export function PushSetupLayer({ deps }: PushSetupLayerProps = {}) {
  // Notification taps → navigation (cold + warm/hot start).
  usePushDeepLink(deps?.deepLink);

  useEffect(() => {
    const notifications = getNotifications();

    // Foreground notifications: show the banner + list entry (+ sound + badge).
    // SDK 56 replaced the deprecated `shouldShowAlert` with `shouldShowBanner`
    // + `shouldShowList` (both required).
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });

    // Android: configure the channel the backend targets.
    if (Platform.OS === 'android') {
      void notifications.setNotificationChannelAsync(PUSH_NOTIFICATION_CHANNEL_ID, {
        name: 'Portable Notifications',
        importance: notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#6366f1',
      });
    }
  }, []);

  return <PushPermissionPrompt deps={deps?.prompt} />;
}
