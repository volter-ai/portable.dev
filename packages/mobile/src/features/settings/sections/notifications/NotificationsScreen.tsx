/**
 * Notifications settings screen (`/settings/notifications`) — thin view over
 * {@link useNotificationsViewModel}, over the native APNs/FCM push path
 * (`pushAdapter.ts` → `expo-notifications`).
 *
 * testIDs:
 *  - settings-notifications                 (root; back = settings-notifications-back)
 *  - settings-notifications-description     (top description panel)
 *  - settings-notifications-card            (Push Notifications card)
 *  - settings-notifications-status          (status label: Checking.../Enabled/Disabled/Blocked)
 *  - settings-notifications-status-spinner  (spinner while Checking...)
 *  - settings-notifications-toggle          (Enable/Disable Notifications button)
 *  - settings-notifications-blocked         (denied alert box)
 *  - settings-notifications-open-settings   (denied → Open Settings button)
 *  - settings-notifications-when-card       (When to Notify card, enabled only)
 *  - settings-notifications-when-always     (OptionButton)
 *  - settings-notifications-when-offline    (OptionButton)
 *  - settings-notifications-help            (help note card)
 *
 * Deliberate gaps:
 *  - No `not-supported` status/message — native always supports push.
 *  - No bell/bell-slash/check/times FontAwesome glyphs — FontAwesome is not
 *    bundled (repo rule); the status is conveyed by the colored label and the
 *    loading spinner.
 *  - Denied path ADDS an "Open Settings" button (`Linking.openSettings` seam) —
 *    native can deep-link.
 *
 * Device-only acceptance (real APNs/FCM token round-trip) is deferred to the
 * established device pass — see `pushAdapter.ts`.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../../../theme';
import { OptionButton, SettingsCard, SettingsSectionScreen } from '../../chrome';

import {
  useNotificationsViewModel,
  type NotificationsViewModelDeps,
  type NotificationStatus,
} from './useNotificationsViewModel';

/** Status literals (these two hexes are hardcoded). */
const ENABLED_GREEN = '#22c55e';
const BLOCKED_RED = '#ef4444';

export interface NotificationsScreenProps {
  /** ViewModel seams (adapter / openSettings / platform / now) — test injection. */
  deps?: NotificationsViewModelDeps;
  /** Back action override (default: `router.back()` via the chrome). */
  onBack?: () => void;
}

export function NotificationsScreen({ deps, onBack }: NotificationsScreenProps) {
  const { theme } = useAppTheme();
  const vm = useNotificationsViewModel(deps ?? {});

  const statusDisplay: Record<NotificationStatus, { label: string; color: string }> = {
    loading: { label: 'Checking...', color: theme.colors.textTertiary },
    enabled: { label: 'Enabled', color: ENABLED_GREEN },
    disabled: { label: 'Disabled', color: theme.colors.textSecondary },
    denied: { label: 'Blocked', color: BLOCKED_RED },
  };
  const { label: statusLabel, color: statusColor } = statusDisplay[vm.status];

  const toggleLabel = vm.isToggling
    ? vm.status === 'enabled'
      ? 'Disabling...'
      : 'Enabling...'
    : vm.status === 'enabled'
      ? 'Disable Notifications'
      : 'Enable Notifications';

  return (
    <SettingsSectionScreen title="Notifications" testID="settings-notifications" onBack={onBack}>
      {/* Description panel (backgroundElevated + border) */}
      <View
        testID="settings-notifications-description"
        style={[
          styles.descriptionPanel,
          { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
        ]}
      >
        <Text style={[styles.descriptionText, { color: theme.colors.textSecondary }]}>
          Get notified when Claude finishes tasks, even when the app is in the background.
        </Text>
      </View>

      {/* Push Notifications card */}
      <SettingsCard testID="settings-notifications-card">
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Push Notifications</Text>
          <View style={styles.statusRow}>
            {vm.status === 'loading' && (
              <ActivityIndicator
                testID="settings-notifications-status-spinner"
                size="small"
                color={theme.colors.textTertiary}
              />
            )}
            <Text
              testID="settings-notifications-status"
              style={[styles.statusLabel, { color: statusColor }]}
            >
              {statusLabel}
            </Text>
          </View>
        </View>

        <Text style={[styles.cardDescription, { color: theme.colors.textSecondary }]}>
          Receive push notifications when Claude completes tasks or when important events occur.
        </Text>

        {vm.status === 'denied' ? (
          <>
            <View
              testID="settings-notifications-blocked"
              style={[styles.blockedBox, { backgroundColor: withAlpha(BLOCKED_RED, '20') }]}
            >
              <Text style={styles.blockedText}>
                Notifications are blocked. Go to Settings &gt; App &gt; Notifications to enable
                them.
              </Text>
            </View>
            <Pressable
              testID="settings-notifications-open-settings"
              accessibilityRole="button"
              onPress={vm.openSystemSettings}
              style={[styles.secondaryButton, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.secondaryButtonText, { color: theme.colors.text }]}>
                Open Settings
              </Text>
            </Pressable>
          </>
        ) : (
          vm.status !== 'loading' && (
            <Pressable
              testID="settings-notifications-toggle"
              accessibilityRole="button"
              accessibilityState={{ disabled: vm.isToggling, busy: vm.isToggling }}
              disabled={vm.isToggling}
              onPress={() => void vm.toggle()}
              style={[
                styles.toggleButton,
                vm.status === 'enabled'
                  ? {
                      backgroundColor: theme.colors.hover,
                      borderColor: theme.colors.border,
                      borderWidth: 1,
                    }
                  : { backgroundColor: theme.colors.primary },
                vm.isToggling && styles.busy,
              ]}
            >
              {vm.isToggling && (
                <ActivityIndicator
                  size="small"
                  color={vm.status === 'enabled' ? theme.colors.text : theme.colors.textInverse}
                />
              )}
              <Text
                style={[
                  styles.toggleButtonText,
                  { color: vm.status === 'enabled' ? theme.colors.text : theme.colors.textInverse },
                ]}
              >
                {toggleLabel}
              </Text>
            </Pressable>
          )
        )}
      </SettingsCard>

      {/* When to Notify — only when notifications are enabled */}
      {vm.status === 'enabled' && (
        <SettingsCard testID="settings-notifications-when-card">
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>When to Notify</Text>
          <Text style={[styles.cardDescription, { color: theme.colors.textSecondary }]}>
            Choose when to receive push notifications.
          </Text>
          <View style={styles.optionsRow}>
            <View style={styles.optionCell}>
              <OptionButton
                label="Always"
                selected={vm.notifyWhen === 'always'}
                disabled={vm.isUpdatingNotifyWhen}
                onPress={() => vm.setNotifyWhen('always')}
                testID="settings-notifications-when-always"
              />
            </View>
            <View style={styles.optionCell}>
              <OptionButton
                label="Only When Offline"
                selected={vm.notifyWhen === 'offline'}
                disabled={vm.isUpdatingNotifyWhen}
                onPress={() => vm.setNotifyWhen('offline')}
                testID="settings-notifications-when-offline"
              />
            </View>
          </View>
        </SettingsCard>
      )}

      {/* Help note (surface + borderLight, textTertiary) */}
      <SettingsCard testID="settings-notifications-help">
        <Text style={[styles.helpText, { color: theme.colors.textTertiary }]}>
          <Text style={styles.helpStrong}>Note: </Text>
          If you&apos;ve blocked notifications, go to your device Settings, find this app, and
          enable Notifications.
        </Text>
      </SettingsCard>
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  descriptionPanel: {
    padding: 12,
    borderWidth: 1,
    borderRadius: 8,
  },
  descriptionText: { fontSize: 13, lineHeight: 19 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitle: { fontSize: 14, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusLabel: { fontSize: 12, fontWeight: '500' },
  cardDescription: { fontSize: 12, lineHeight: 17, marginBottom: 12 },
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 6,
  },
  toggleButtonText: { fontSize: 12, fontWeight: '600' },
  busy: { opacity: 0.6 },
  blockedBox: {
    padding: 8,
    borderRadius: 6,
    marginBottom: 8,
  },
  blockedText: {
    color: BLOCKED_RED,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 17,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  secondaryButtonText: { fontSize: 12, fontWeight: '600' },
  optionsRow: { flexDirection: 'row', gap: 8 },
  optionCell: { flex: 1 },
  helpText: { fontSize: 12, lineHeight: 18 },
  helpStrong: { fontWeight: '700' },
});
