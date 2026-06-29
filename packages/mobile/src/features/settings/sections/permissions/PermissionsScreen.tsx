/**
 * Device Permissions settings page (`/settings/permissions`) — DEVICE
 * permissions, NOT chat tool-permissions. One card per permission type: glyph +
 * name, description, blocked-features note, live status badge and the action row
 * (Request / Granted badge / Denied instructions + Open Settings). Geolocation
 * renders as a "Future Permissions" disabled "Coming soon" card and NEVER
 * fetches status. Nothing is persisted — statuses are re-checked on every mount.
 *
 * testIDs:
 *   settings-permissions                          (root; back = `-back` via chrome)
 *   settings-permissions-intro                    (description info box)
 *   settings-permissions-note                     (bottom help note)
 *   settings-permissions-card-<type>              (type ∈ notifications|camera|microphone|geolocation)
 *   settings-permissions-status-<type>            (status badge text — active types only)
 *   settings-permissions-request-<type>           (Request Permission button, prompt state)
 *   settings-permissions-granted-<type>           (green granted badge)
 *   settings-permissions-instructions-<type>      (denied: platform instructions text)
 *   settings-permissions-open-settings-<type>     (denied: Open Settings button)
 *   settings-permissions-coming-soon-geolocation  (future-card placeholder)
 *
 * Deliberate gaps:
 * - No "Not Available" / `unavailable` state: the native expo modules always
 *   exist on device, so the status union is granted|denied|prompt.
 * - The denied state shows ONLY instructions + "Open Settings" (no disabled
 *   "Request Permission" button): a native `denied` is settings-only, and
 *   `Linking.openSettings()` deep-links directly instead of an
 *   alert()-with-instructions.
 * - No toast/console feedback on grant/deny — the live badge is the feedback.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, withAlpha } from '../../../../theme';
import { SectionLabel, SettingsCard, SettingsSectionScreen } from '../../chrome';
import {
  ACTIVE_PERMISSION_TYPES,
  FUTURE_PERMISSION_TYPES,
  PERMISSION_METADATA,
  getSettingsInstructions,
  openSystemSettings,
  type ActiveDevicePermissionType,
  type DevicePermissionStatus,
  type DevicePermissionType,
} from './devicePermissions';
import { usePermissionsViewModel, type PermissionsViewModelDeps } from './usePermissionsViewModel';

export interface PermissionsScreenProps extends PermissionsViewModelDeps {
  /** "Open Settings" action (default: `Linking.openSettings()`). */
  openSettings?: () => void;
  /** Denied-state instructions (default: platform text from `getSettingsInstructions`). */
  instructions?: string;
  /** Header back action (default: `router.back()` via the chrome). */
  onBack?: () => void;
}

interface StatusBadge {
  label: string;
  color: string;
}

export function PermissionsScreen({
  checkStatus,
  requestPermission,
  openSettings = openSystemSettings,
  instructions = getSettingsInstructions(),
  onBack,
}: PermissionsScreenProps) {
  const { theme } = useAppTheme();
  const vm = usePermissionsViewModel({ checkStatus, requestPermission });

  const statusBadge = (status: DevicePermissionStatus | null): StatusBadge => {
    switch (status) {
      case 'granted':
        return { label: 'Granted', color: theme.colors.success };
      case 'denied':
        return { label: 'Denied', color: theme.colors.error };
      case 'prompt':
        return { label: 'Not requested', color: theme.colors.textSecondary };
      default:
        return { label: 'Checking...', color: theme.colors.textTertiary };
    }
  };

  const renderCardHeader = (type: DevicePermissionType, enabled: boolean) => {
    const meta = PERMISSION_METADATA[type];
    return (
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Text style={[styles.glyph, !enabled && styles.disabledOpacity]}>{meta.glyph}</Text>
          <Text style={[styles.cardName, { color: theme.colors.text }]}>{meta.name}</Text>
        </View>
        {enabled && (
          <Text
            testID={`settings-permissions-status-${type}`}
            style={[
              styles.statusLabel,
              { color: statusBadge(vm.statuses[type as ActiveDevicePermissionType]).color },
            ]}
          >
            {statusBadge(vm.statuses[type as ActiveDevicePermissionType]).label}
          </Text>
        )}
      </View>
    );
  };

  const renderDescription = (type: DevicePermissionType) => {
    const meta = PERMISSION_METADATA[type];
    return (
      <Text style={[styles.cardDescription, { color: theme.colors.textSecondary }]}>
        {meta.description} {meta.purpose}
      </Text>
    );
  };

  const renderBlockedFeatures = (type: ActiveDevicePermissionType) => (
    <View style={[styles.blockedBox, { backgroundColor: theme.colors.backgroundElevated }]}>
      <Text style={[styles.blockedHeader, { color: theme.colors.textTertiary }]}>
        Features Requiring Permission:
      </Text>
      {PERMISSION_METADATA[type].blockedFeatures.map((feature) => (
        <Text key={feature} style={[styles.blockedItem, { color: theme.colors.textSecondary }]}>
          {'•'} {feature}
        </Text>
      ))}
    </View>
  );

  const renderActions = (type: ActiveDevicePermissionType) => {
    const status = vm.statuses[type];
    if (status === 'granted') {
      return (
        <View
          testID={`settings-permissions-granted-${type}`}
          style={[styles.grantedBadge, { backgroundColor: withAlpha(theme.colors.success, '20') }]}
        >
          <Text style={[styles.grantedText, { color: theme.colors.success }]}>
            ✓ Permission Granted
          </Text>
        </View>
      );
    }
    if (status === 'denied') {
      return (
        <View style={styles.deniedColumn}>
          <Text
            testID={`settings-permissions-instructions-${type}`}
            style={[styles.instructionsText, { color: theme.colors.textSecondary }]}
          >
            {instructions}
          </Text>
          <Pressable
            testID={`settings-permissions-open-settings-${type}`}
            accessibilityRole="button"
            onPress={openSettings}
            style={[
              styles.settingsButton,
              { backgroundColor: theme.colors.hover, borderColor: theme.colors.border },
            ]}
          >
            <Text style={[styles.settingsButtonText, { color: theme.colors.text }]}>
              Open Settings
            </Text>
          </Pressable>
        </View>
      );
    }
    if (status === 'prompt') {
      const busy = vm.requesting === type;
      return (
        <Pressable
          testID={`settings-permissions-request-${type}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void vm.request(type)}
          style={[
            styles.requestButton,
            { backgroundColor: theme.colors.primary },
            busy && styles.requestingOpacity,
          ]}
        >
          <Text style={[styles.requestButtonText, { color: theme.colors.textInverse }]}>
            {busy ? 'Requesting...' : 'Request Permission'}
          </Text>
        </Pressable>
      );
    }
    return null; // Checking — no action row yet (buttons render once status loads).
  };

  return (
    <SettingsSectionScreen title="Permissions" testID="settings-permissions" onBack={onBack}>
      {/* Intro info box (backgroundElevated + border). */}
      <View
        testID="settings-permissions-intro"
        style={[
          styles.infoBox,
          {
            backgroundColor: theme.colors.backgroundElevated,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Text style={[styles.introText, { color: theme.colors.textSecondary }]}>
          Manage device permissions for enhanced app functionality. Grant permissions to enable
          features like voice input, notifications, and media capture.
        </Text>
      </View>

      <View>
        <SectionLabel>Active Permissions</SectionLabel>
        <View style={styles.cardList}>
          {ACTIVE_PERMISSION_TYPES.map((type) => (
            <SettingsCard key={type} testID={`settings-permissions-card-${type}`}>
              {renderCardHeader(type, true)}
              {renderDescription(type)}
              {vm.statuses[type] !== null &&
                vm.statuses[type] !== 'granted' &&
                renderBlockedFeatures(type)}
              {renderActions(type)}
            </SettingsCard>
          ))}
        </View>
      </View>

      <View>
        <SectionLabel>Future Permissions</SectionLabel>
        <View style={styles.cardList}>
          {FUTURE_PERMISSION_TYPES.map((type) => (
            <View
              key={type}
              testID={`settings-permissions-card-${type}`}
              style={[
                styles.futureCard,
                { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.border },
              ]}
            >
              {renderCardHeader(type, false)}
              {renderDescription(type)}
              <View
                testID={`settings-permissions-coming-soon-${type}`}
                style={[styles.comingSoonBox, { backgroundColor: theme.colors.backgroundElevated }]}
              >
                <Text style={[styles.comingSoonText, { color: theme.colors.textTertiary }]}>
                  Coming soon - not yet implemented
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Help note (surface + borderLight). */}
      <View
        testID="settings-permissions-note"
        style={[
          styles.infoBox,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.borderLight },
        ]}
      >
        <Text style={[styles.noteText, { color: theme.colors.textTertiary }]}>
          <Text style={styles.noteStrong}>Note:</Text> If you've previously denied a permission, you
          may need to open your device settings to re-enable it. Use the "Open Settings" button.
        </Text>
      </View>
    </SettingsSectionScreen>
  );
}

const styles = StyleSheet.create({
  infoBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  introText: { fontSize: 13, lineHeight: 19 },
  noteText: { fontSize: 12, lineHeight: 18 },
  noteStrong: { fontWeight: '600' },
  cardList: { gap: 8 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glyph: { fontSize: 16 },
  cardName: { fontSize: 14, fontWeight: '600' },
  statusLabel: { fontSize: 12, fontWeight: '500' },
  cardDescription: { fontSize: 12, lineHeight: 17, marginBottom: 8 },
  blockedBox: { borderRadius: 6, padding: 8, marginBottom: 8 },
  blockedHeader: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
  blockedItem: { fontSize: 11, lineHeight: 18, paddingLeft: 8 },
  grantedBadge: {
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  grantedText: { fontSize: 12, fontWeight: '600' },
  deniedColumn: { gap: 8 },
  instructionsText: { fontSize: 12, lineHeight: 17 },
  settingsButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  settingsButtonText: { fontSize: 12, fontWeight: '600' },
  requestButton: {
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  requestButtonText: { fontSize: 12, fontWeight: '600' },
  requestingOpacity: { opacity: 0.6 },
  futureCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    opacity: 0.5,
  },
  comingSoonBox: {
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
  },
  comingSoonText: { fontSize: 11, fontStyle: 'italic' },
  disabledOpacity: { opacity: 0.6 },
});
