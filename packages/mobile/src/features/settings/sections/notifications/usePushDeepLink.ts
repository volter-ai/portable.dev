/**
 * usePushDeepLink — a tapped push notification opens the target chat.
 *
 * Three lifecycle cases, all funnelled through one `router.push`:
 *  - **Cold start** (app launched BY the tap): `getLastNotificationResponseAsync()`
 *    returns the response that launched the app, even though we register late —
 *    so the cold-start tap is never lost.
 *  - **Warm/hot start** (app already alive, tap from the tray or a foreground
 *    alert): `addNotificationResponseReceivedListener` fires.
 *
 * The target chat id lives in `notification.request.content.data.chatId` — the
 * SAME field the backend `PushNotificationService` sends (`data.chatId`). No
 * chatId → the chats list.
 *
 * `expo-notifications` is lazy-`require`d (the `pushAdapter.ts` seam) so importing
 * this hook never pulls the native module into the Jest/Metro graph; types come
 * from `import type` (Babel-erased).
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';

import type * as ExpoNotifications from 'expo-notifications';

/** Static surface of the `expo-notifications` module (type-only). */
type NotificationsModule = typeof ExpoNotifications;

/** Lazily resolve `expo-notifications` (never at import time). */
function getNotifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- intentional lazy native require.
  return require('expo-notifications') as NotificationsModule;
}

/** The chat tab route (the chat screen lives inside the `(tabs)` group). */
function chatRoute(chatId: string): string {
  return `/(app)/(tabs)/chat/${chatId}`;
}

/** The chats list route (fallback when a notification carries no chatId). */
const CHATS_ROUTE = '/(app)/(tabs)/chats';

/** Read the chatId a notification response carries (`data.chatId`), if any. */
function chatIdFromResponse(response: ExpoNotifications.NotificationResponse): string | undefined {
  const chatId = response.notification.request.content.data?.chatId;
  return typeof chatId === 'string' && chatId.length > 0 ? chatId : undefined;
}

/** Navigate to the target chat, or the chats list when there is no chatId. */
function navigateToChatOrList(
  router: { push: (href: string) => void },
  chatId: string | undefined
): void {
  router.push(chatId ? chatRoute(chatId) : CHATS_ROUTE);
}

export interface UsePushDeepLinkDeps {
  /** Injectable router (default: `useRouter()` from expo-router). */
  router?: { push: (href: string) => void };
}

/**
 * Wires push-notification taps → in-app navigation. Call it once near the root of
 * the authenticated tree (inside {@link PushSetupLayer}) so every launch — cold,
 * warm, or hot — opens the target chat when the user taps a notification.
 */
export function usePushDeepLink(deps?: UsePushDeepLinkDeps): void {
  const routerFromHook = useRouter();
  const router = deps?.router ?? routerFromHook;

  useEffect(() => {
    let cancelled = false;
    const notifications = getNotifications();

    // Cold start: a response may already be waiting (the tap that launched us).
    void notifications.getLastNotificationResponseAsync().then((response) => {
      if (cancelled || !response) return;
      navigateToChatOrList(router, chatIdFromResponse(response));
    });

    // Warm/hot start: new taps while the app is alive.
    const subscription = notifications.addNotificationResponseReceivedListener((response) => {
      navigateToChatOrList(router, chatIdFromResponse(response));
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
    // `router` is stable across renders (expo-router guarantees it); mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
