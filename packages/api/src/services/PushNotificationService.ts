import {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  debugLog,
} from '@vgit2/shared/constants';
import webpush from 'web-push';

import type { DbAdapter } from '../db/DbAdapter.js';
import type { NotifyPayload, NotifyRequest, NotifyResponse } from '@vgit2/shared/types';

/**
 * Whether a gateway per-token error string marks the device token as gone, so it
 * should be pruned locally. The FCM analogue of an HTTP 410/404 web-push removal:
 * firebase-admin reports a stale/unknown token with one of the `messaging/*`
 * registration-token codes (or the legacy `NotRegistered`). Matched loosely +
 * case-insensitively so a wrapped/prefixed gateway error string still prunes.
 */
export function isUnregisteredPushError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes('registration-token-not-registered') ||
    e.includes('invalid-registration-token') ||
    e.includes('invalid-argument') ||
    e.includes('not-registered') ||
    e.includes('notregistered') ||
    e.includes('unregistered')
  );
}

/**
 * Push Notification Service
 *
 * Owns the PC's push subscriptions (SQLite) and delivers background
 * notifications when the app is closed. Two delivery paths:
 *
 * - **PRIMARY (live): native Expo/FCM via the gateway** — {@link notifyViaGateway}
 *   reads the user's stored `fcmToken`s and delegates the actual send to the public
 *   gateway (`POST /api/notify`), which fans out via firebase-admin. The mobile Expo
 *   RN app (the only client) subscribes with `{ endpoint, platform, fcmToken }` — a
 *   native subscription, NO VAPID keys — so this is the only path that fires in
 *   practice.
 * - **DORMANT FALLBACK: Web Push / VAPID** — {@link sendNotification} (Web Push
 *   Protocol RFC 8030 + VAPID) is RETAINED but effectively dead: it self-disables
 *   when VAPID keys are unset (the local-first common case → early return), and the
 *   legacy client that used to subscribe with `p256dh`/`auth` keys + read
 *   `GET /api/push/vapid-public-key` was removed, so there are no
 *   web-push subscribers and no live caller of the VAPID public-key endpoint. Kept as
 *   a non-throwing fallback only; do NOT treat the browser/VAPID flow as a live client.
 *
 * Features (apply to both paths): multi-device support, automatic cleanup of stale
 * subscriptions (web-push 410/404 ⇔ FCM unregistered-token pruning), and graceful
 * degradation when not configured (logs but never crashes).
 */
export class PushNotificationService {
  private configured: boolean = false;

  /**
   * @param dbAdapter - persistence for push subscriptions (the PC owns subscriptions).
   * @param fetchImpl - injectable fetch seam (gateway delegation + tests). Defaults to
   *   the global `fetch`.
   */
  constructor(
    private dbAdapter: DbAdapter,
    private fetchImpl: typeof fetch = fetch
  ) {
    console.log('[PushNotificationService] Initializing push notification service...');

    // Validate configuration
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
      console.warn(
        '[PushNotificationService] ⚠️  VAPID keys not configured - push notifications disabled'
      );
      console.warn(
        '[PushNotificationService] Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT in .env'
      );
      this.configured = false;
      return;
    }

    try {
      // Configure web-push with VAPID keys
      console.log('[PushNotificationService] Configuring web-push with VAPID details...');
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

      this.configured = true;
      console.log(
        '[PushNotificationService] ✓ Successfully initialized with VAPID subject:',
        VAPID_SUBJECT
      );
      debugLog('[PushNotificationService] Initialized with VAPID subject:', VAPID_SUBJECT);
    } catch (error) {
      console.error('[PushNotificationService] ✗ Failed to initialize web-push:', error);
      console.error('[PushNotificationService] Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.configured = false;
    }
  }

  /**
   * Save a push subscription for a user
   */
  async saveSubscription(
    userId: string,
    subscription: {
      endpoint: string;
      keys?: {
        p256dh: string;
        auth: string;
      };
      platform?: 'web' | 'ios' | 'android';
      fcmToken?: string;
      deviceInfo?: any;
    },
    authToken?: string
  ): Promise<boolean> {
    return await this.dbAdapter.savePushSubscription(userId, subscription, authToken);
  }

  /**
   * Remove a push subscription
   */
  async removeSubscription(userId: string, endpoint: string, authToken?: string): Promise<boolean> {
    return await this.dbAdapter.removePushSubscription(userId, endpoint, authToken);
  }

  /**
   * Get all push subscriptions for a user
   */
  async getUserSubscriptions(
    userId: string,
    authToken?: string
  ): Promise<
    Array<{
      userId: string;
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
      fcmToken?: string;
      deviceInfo?: any;
    }>
  > {
    return await this.dbAdapter.getUserPushSubscriptions(userId, authToken);
  }

  /**
   * Send a push notification to all of a user's devices
   *
   * @param userId - User to notify
   * @param payload - Notification data
   * @param authToken - JWT token for RLS authentication
   */
  async sendNotification(
    userId: string,
    payload: {
      title: string;
      body: string;
      chatId?: string;
      tag?: string;
      icon?: string;
      badge?: string;
    },
    authToken?: string
  ): Promise<void> {
    try {
      // Early return if not configured - graceful degradation
      if (!this.configured) {
        console.log(
          '[PushNotificationService] Service not configured - skipping push notification'
        );
        return;
      }

      console.log(`[PushNotificationService] Sending notification for user ${userId}`, {
        title: payload.title,
        chatId: payload.chatId,
        tag: payload.tag,
      });

      let subscriptions;
      try {
        subscriptions = await this.getUserSubscriptions(userId, authToken);
      } catch (error) {
        console.error('[PushNotificationService] Failed to get user subscriptions:', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (subscriptions.length === 0) {
        console.log(`[PushNotificationService] No push subscriptions for user ${userId}`);
        return;
      }

      console.log(
        `[PushNotificationService] Sending notification to ${subscriptions.length} device(s) for user ${userId}`
      );

      const notificationPayload = JSON.stringify(payload);

      // Send to all user's devices (multi-device support)
      const sendPromises = subscriptions.map(async (subscription) => {
        try {
          console.log(
            `[PushNotificationService] Attempting to send to: ${subscription.endpoint.substring(0, 50)}...`
          );

          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            notificationPayload
          );

          console.log(
            `[PushNotificationService] ✓ Successfully sent to device: ${subscription.endpoint.substring(0, 50)}...`
          );
        } catch (error: any) {
          // Handle expired subscriptions
          if (error.statusCode === 410 || error.statusCode === 404) {
            console.log(
              `[PushNotificationService] Subscription expired (${error.statusCode}), removing: ${subscription.endpoint.substring(0, 50)}...`
            );
            try {
              await this.removeSubscription(userId, subscription.endpoint, authToken);
            } catch (removeError) {
              console.error('[PushNotificationService] Failed to remove expired subscription:', {
                endpoint: subscription.endpoint.substring(0, 50) + '...',
                error: removeError instanceof Error ? removeError.message : String(removeError),
              });
            }
          } else {
            // Log detailed error information
            console.error('[PushNotificationService] ✗ Failed to send push notification:', {
              endpoint: subscription.endpoint.substring(0, 50) + '...',
              errorName: error.name || 'Unknown',
              errorMessage: error.message || String(error),
              statusCode: error.statusCode,
              body: error.body,
              headers: error.headers,
            });

            // If error has stack trace, log it separately for better debugging
            if (error.stack) {
              console.error('[PushNotificationService] Error stack trace:', error.stack);
            }
          }
        }
      });

      await Promise.allSettled(sendPromises);
      console.log(`[PushNotificationService] Completed sending notifications for user ${userId}`);
    } catch (error) {
      // Top-level error handler - should never crash the application
      console.error('[PushNotificationService] ✗ CRITICAL: Unexpected error in sendNotification:', {
        userId,
        payload: JSON.stringify(payload),
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Log to stdout for production monitoring
      process.stdout.write(
        `[PushNotificationService] CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  /**
   * Deliver a push notification to the user's native (Expo/FCM) devices by
   * delegating the actual send to the public gateway (the only online service
   * that holds the FCM credential) — local-first push.
   *
   * The PC owns the subscriptions: this reads the user's stored `fcmToken`s and
   * POSTs `{ pcId, tokens, payload }` to `<PORTABLE_RELAY_URL>/api/notify`. The
   * gateway fans the message out via firebase-admin and returns a per-token
   * result; tokens the gateway reports as unregistered are pruned locally
   * (the same cleanup the local 410/404 web-push path performs).
   *
   * Best-effort by contract — NEVER throws. When `PORTABLE_RELAY_URL` /
   * `PORTABLE_PC_ID` are unset (a non-launcher run, e.g. bare `bun run dev`),
   * this no-ops gracefully. The local web-push/VAPID path is kept as a dormant
   * fallback (see {@link sendNotification}).
   */
  async notifyViaGateway(
    userId: string,
    payload: NotifyPayload,
    authToken?: string
  ): Promise<void> {
    try {
      const relayBase = process.env.PORTABLE_RELAY_URL?.trim();
      const pcId = process.env.PORTABLE_PC_ID?.trim();

      // Non-launcher run: no gateway to delegate to → no-op (web-push fallback only).
      if (!relayBase || !pcId) {
        return;
      }

      let subscriptions;
      try {
        subscriptions = await this.getUserSubscriptions(userId, authToken);
      } catch (error) {
        console.error('[PushNotificationService] notifyViaGateway: failed to read subscriptions:', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Collect distinct FCM tokens and remember which endpoint(s) each maps to,
      // so a token the gateway reports as dead can be pruned by endpoint.
      const endpointsByToken = new Map<string, string[]>();
      for (const sub of subscriptions) {
        const token = sub.fcmToken?.trim();
        if (!token) continue;
        const endpoints = endpointsByToken.get(token) ?? [];
        endpoints.push(sub.endpoint);
        endpointsByToken.set(token, endpoints);
      }

      const tokens = [...endpointsByToken.keys()];
      if (tokens.length === 0) {
        // No native FCM device registered → nothing to delegate.
        return;
      }

      const requestBody: NotifyRequest = { pcId, tokens, payload };
      const url = `${relayBase.replace(/\/+$/, '')}/api/notify`;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        // Gateway unreachable — swallow (push is best-effort, must not crash chat exec).
        console.warn('[PushNotificationService] notifyViaGateway: gateway unreachable:', {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!response.ok) {
        console.warn(
          `[PushNotificationService] notifyViaGateway: gateway returned ${response.status}`
        );
        return;
      }

      let result: NotifyResponse;
      try {
        result = (await response.json()) as NotifyResponse;
      } catch (error) {
        console.warn('[PushNotificationService] notifyViaGateway: invalid gateway response:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // Prune tokens the gateway reports as unregistered (FCM equivalent of a
      // 410/404 web-push subscription) so they don't pile up on the PC.
      for (const tokenResult of result.results ?? []) {
        if (tokenResult.ok || !isUnregisteredPushError(tokenResult.error)) {
          continue;
        }
        const endpoints = endpointsByToken.get(tokenResult.token) ?? [];
        for (const endpoint of endpoints) {
          try {
            await this.removeSubscription(userId, endpoint, authToken);
            console.log(
              `[PushNotificationService] notifyViaGateway: pruned unregistered device (${endpoint.substring(0, 50)}...)`
            );
          } catch (removeError) {
            console.error(
              '[PushNotificationService] notifyViaGateway: failed to prune dead subscription:',
              {
                endpoint: endpoint.substring(0, 50) + '...',
                error: removeError instanceof Error ? removeError.message : String(removeError),
              }
            );
          }
        }
      }
    } catch (error) {
      // Top-level guard: notifyViaGateway must NEVER throw (push is best-effort).
      console.error('[PushNotificationService] notifyViaGateway: unexpected error:', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get the VAPID public key for client subscription
   */
  getVapidPublicKey(): string | undefined {
    return VAPID_PUBLIC_KEY;
  }

  /**
   * Check if push notifications are configured
   */
  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Get notification settings for a user
   */
  async getNotificationSettings(
    userId: string,
    authToken?: string
  ): Promise<{ enabled: boolean; taskComplete: boolean; notifyWhen: 'always' | 'offline' }> {
    const settings = await this.dbAdapter.getNotificationSettings(userId, authToken);
    if (!settings) {
      return { enabled: false, taskComplete: true, notifyWhen: 'always' };
    }
    return settings;
  }

  /**
   * Update notification settings for a user
   */
  async updateNotificationSettings(
    userId: string,
    settings: Partial<{
      enabled: boolean;
      taskComplete: boolean;
      notifyWhen: 'always' | 'offline';
    }>,
    authToken?: string
  ): Promise<boolean> {
    return this.dbAdapter.updateNotificationSettings(userId, settings, authToken);
  }

  /**
   * Send push notification only if user is offline (no active Socket.IO connections)
   *
   * @param userId - User to notify
   * @param payload - Notification data
   * @param authToken - JWT token for RLS authentication
   * @param isUserOnline - Optional callback to check if user has active connections
   */
  async sendIfOffline(
    userId: string,
    payload: {
      title: string;
      body: string;
      chatId?: string;
      data?: any;
    },
    authToken?: string,
    isUserOnline?: (userId: string) => boolean
  ): Promise<void> {
    try {
      // Get user's notification settings to check notifyWhen preference
      const settings = await this.dbAdapter.getNotificationSettings(userId, authToken);
      const notifyWhen = settings?.notifyWhen || 'always';

      // If notifyWhen is 'offline', check online status before sending
      if (notifyWhen === 'offline' && isUserOnline) {
        const online = isUserOnline(userId);
        if (online) {
          console.log(
            `[PushNotificationService] User ${userId} is online (notifyWhen=offline), skipping push notification`
          );
          return;
        }
        console.log(
          `[PushNotificationService] User ${userId} is offline, sending push notification`
        );
      } else if (notifyWhen === 'always') {
        console.log(
          `[PushNotificationService] User ${userId} notifyWhen=always, sending push notification`
        );
      }

      const notifyPayload: NotifyPayload = {
        title: payload.title,
        body: payload.body,
        chatId: payload.chatId,
        tag: payload.chatId ? `claude-${payload.chatId}` : 'claude-notification',
        icon: '/icons/icon-192.png',
      };

      // Primary delivery: native Expo/FCM devices via the gateway relay.
      // No-ops gracefully when not launcher-hosted (PORTABLE_RELAY_URL unset).
      await this.notifyViaGateway(userId, notifyPayload, authToken);

      // Dormant fallback: local web-push/VAPID. Self-disables when VAPID keys are
      // unset (the local-first common case → sendNotification early-returns).
      await this.sendNotification(
        userId,
        {
          title: payload.title,
          body: payload.body,
          chatId: payload.chatId,
          tag: payload.chatId ? `claude-${payload.chatId}` : 'claude-notification',
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
        },
        authToken
      );
    } catch (error) {
      console.error('[PushNotificationService] Error in sendIfOffline:', error);
    }
  }
}
