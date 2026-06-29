/**
 * Notifications settings ViewModel (MVVM hook) — drives the notification-settings
 * state machine over the native push path.
 *
 * Status derivation = device permission state (via the injectable
 * {@link PushAdapter}) + whether THIS DEVICE registered its token — the
 * MMKV-persisted {@link usePushRegistrationStore} written on a successful
 * subscribe and cleared on unsubscribe. ⚠️ The `GET /api/push/settings`
 * `enabled` flag is USER-level (true when ANY subscription exists on the user's
 * account) and is deliberately NOT used for this device's status —
 * a fresh install must show "Disabled" until it registers its own APNs/FCM
 * token, even for a user with another subscription active. There is no
 * `not-supported` status — native always supports push.
 *
 * Native flow:
 *  - enable  = requestPermission → `adapter.getDeviceToken()` (the **FCM
 *    registration token** via `@react-native-firebase/messaging` on BOTH
 *    platforms — see {@link createExpoPushAdapter}; the backend delivers native
 *    pushes only via FCM) → `POST /api/push/subscribe` with the
 *    body (`subscription: { endpoint, platform, fcmToken }` + `deviceInfo`).
 *  - disable = `POST /api/push/unsubscribe { endpoint: <token> }`.
 *  - notifyWhen = `PUT /api/push/settings { notifyWhen }` (local mutation with
 *    an optimistic update folded into the shared `pushSettings` query cache).
 *
 * Every I/O seam is injectable ({@link NotificationsViewModelDeps}); defaults
 * are the real expo adapter, `Linking.openSettings`, `Platform.OS`, and the
 * authed sandbox client from `useApi()`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../../../api/ApiProvider';
import { usePushSettings, type PushNotificationSettings } from '../../../api/hooks';
import { queryKeys } from '../../../api/keys';

import { createExpoPushAdapter, type PushAdapter, type PushPermissionState } from './pushAdapter';
import { usePushRegistrationStore } from './pushRegistrationStore';

/** Statuses minus `not-supported` (never applies on native). */
export type NotificationStatus = 'loading' | 'enabled' | 'disabled' | 'denied';

export type NotifyWhen = 'always' | 'offline';

export interface NotificationsViewModelDeps {
  /** Device permission + token seam (default: the real expo adapter). */
  adapter?: PushAdapter;
  /** Open the OS app-settings page (default: `Linking.openSettings`). */
  openSettings?: () => void | Promise<void>;
  /** Platform tag sent to the backend (default: `Platform.OS`). */
  platform?: string;
  /** Clock for the `deviceInfo.timestamp` (default: `() => new Date()`). */
  now?: () => Date;
}

export interface NotificationsViewModel {
  status: NotificationStatus;
  /** Enable/Disable request in flight (drives the busy button label). */
  isToggling: boolean;
  /** Enable (subscribe) or disable (unsubscribe) push for this device. */
  toggle: () => Promise<void>;
  notifyWhen: NotifyWhen;
  isUpdatingNotifyWhen: boolean;
  setNotifyWhen: (value: NotifyWhen) => void;
  /** Denied path: deep-link into the OS notification settings. */
  openSystemSettings: () => void;
}

export function useNotificationsViewModel(
  deps: NotificationsViewModelDeps = {}
): NotificationsViewModel {
  const api = useApi();
  const queryClient = useQueryClient();

  const adapter = useMemo(() => deps.adapter ?? createExpoPushAdapter(), [deps.adapter]);
  const platform = deps.platform ?? Platform.OS;
  const now = deps.now ?? (() => new Date());

  const [permission, setPermission] = useState<PushPermissionState | null>(null);
  const [subscribedOverride, setSubscribedOverride] = useState<boolean | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [notifyWhenOverride, setNotifyWhenOverride] = useState<NotifyWhen | null>(null);

  // Initial device permission check. Any adapter failure degrades to
  // `undetermined` (→ 'disabled'), never an error wall.
  useEffect(() => {
    let cancelled = false;
    adapter.getPermissionState().then(
      (state) => {
        if (!cancelled) setPermission(state);
      },
      () => {
        if (!cancelled) setPermission('undetermined');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  // Server-side notification settings (notifyWhen). One fetch, no retry. NB the
  // response's user-level `enabled` flag is NOT consulted for this device's
  // status (see the header).
  const settingsQuery = usePushSettings({ retry: false });

  // THIS device's registration (persisted endpoint after a successful
  // subscribe). Only counts while permission is granted — a registered token
  // whose permission was later revoked in the OS cannot deliver.
  const registeredEndpoint = usePushRegistrationStore((s) => s.registeredEndpoint);
  const setRegisteredEndpoint = usePushRegistrationStore((s) => s.setRegisteredEndpoint);
  const clearRegisteredEndpoint = usePushRegistrationStore((s) => s.clearRegisteredEndpoint);
  const subscribed =
    permission === 'granted' && (subscribedOverride ?? registeredEndpoint !== null);

  const status: NotificationStatus =
    permission === null
      ? 'loading'
      : permission === 'denied'
        ? 'denied'
        : subscribed
          ? 'enabled'
          : 'disabled';

  const notifyWhen: NotifyWhen = notifyWhenOverride ?? settingsQuery.data?.notifyWhen ?? 'always';

  // PUT /api/push/settings — local mutation (no shared hook), optimistic
  // update; the shared pushSettings cache is patched on success so the next
  // reader sees the persisted value.
  const notifyWhenMutation = useMutation({
    mutationFn: (value: NotifyWhen) =>
      api.put<{ success: boolean }>('/api/push/settings', { notifyWhen: value }),
    onMutate: (value: NotifyWhen) => {
      setNotifyWhenOverride(value);
    },
    onSuccess: (_data, value) => {
      queryClient.setQueryData<PushNotificationSettings>(queryKeys.pushSettings(), (prev) =>
        prev ? { ...prev, notifyWhen: value } : prev
      );
    },
    onError: () => {
      // Roll the optimistic pick back to the server value.
      setNotifyWhenOverride(null);
    },
  });

  const { mutate: mutateNotifyWhen, isPending: isUpdatingNotifyWhen } = notifyWhenMutation;

  const setNotifyWhen = useCallback(
    (value: NotifyWhen) => {
      mutateNotifyWhen(value);
    },
    [mutateNotifyWhen]
  );

  const toggle = useCallback(async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      if (status === 'enabled') {
        // Disable: unsubscribe this device's token (prefer the endpoint we
        // actually registered; fall back to the live token).
        const token = registeredEndpoint ?? (await adapter.getDeviceToken());
        await api.post<{ success: boolean }>('/api/push/unsubscribe', { endpoint: token });
        clearRegisteredEndpoint();
        setSubscribedOverride(false);
        queryClient.setQueryData<PushNotificationSettings>(queryKeys.pushSettings(), (prev) =>
          prev ? { ...prev, enabled: false } : prev
        );
      } else {
        // Enable: permission → device token → subscribe.
        let perm = permission;
        if (perm !== 'granted') {
          perm = await adapter.requestPermission();
          setPermission(perm);
          if (perm !== 'granted') return; // denied/dismissed → status reflects it
        }
        const token = await adapter.getDeviceToken();
        await api.post<{ success: boolean }>('/api/push/subscribe', {
          subscription: { endpoint: token, platform, fcmToken: token },
          deviceInfo: { platform, timestamp: now().toISOString() },
        });
        // Persist THIS device's registration — the source of the status.
        setRegisteredEndpoint(token);
        setSubscribedOverride(true);
        queryClient.setQueryData<PushNotificationSettings>(queryKeys.pushSettings(), (prev) =>
          prev ? { ...prev, enabled: true } : prev
        );
      }
    } catch {
      // Toggle errors are swallowed (logged there); state unchanged.
    } finally {
      setIsToggling(false);
    }
  }, [
    adapter,
    api,
    clearRegisteredEndpoint,
    isToggling,
    now,
    permission,
    platform,
    queryClient,
    registeredEndpoint,
    setRegisteredEndpoint,
    status,
  ]);

  const openSettingsSeam = deps.openSettings;
  const openSystemSettings = useCallback(() => {
    if (openSettingsSeam) {
      void openSettingsSeam();
    } else {
      void Linking.openSettings();
    }
  }, [openSettingsSeam]);

  return {
    status,
    isToggling,
    toggle,
    notifyWhen,
    isUpdatingNotifyWhen,
    setNotifyWhen,
    openSystemSettings,
  };
}
