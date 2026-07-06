/**
 * UpdateAvailableCard — the dismissible, bank-style "Update available" prompt
 * (#1522). Replaces the old full-screen blocking UpdateRequiredScreen: the app
 * renders (and stays fully usable) UNDERNEATH; the card offers **Update**
 * (opens the platform store) and **Later** (dismisses + snoozes via
 * `updatePromptStore`). The Android hardware back also counts as "Later" —
 * there is no path that strands the user.
 *
 * Purely presentational + theme-aware. The store deep-link is opened via
 * `Linking.openURL` (iOS deep-links the `apps.apple.com` URL straight to the
 * App Store app — NOT an embedded WebView, so it satisfies the iOS
 * arbitrary-web-content prohibition).
 */

import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { WhaleIcon, useAppTheme } from '../../theme';

/** Store URLs for the update prompt. */
export const APP_STORE_URL = 'https://apps.apple.com/us/app/portable-dev/id6758861546';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=dev.portable.app';

export interface UpdateAvailableCardProps {
  /** Dismiss the card ("Later" / Android back) — the caller records the snooze. */
  onLater: () => void;
  /**
   * Override the store-open action (tests inject a spy). Default: open the
   * platform store via `Linking.openURL`.
   */
  onUpdate?: () => void;
}

export function UpdateAvailableCard({ onLater, onUpdate }: UpdateAvailableCardProps) {
  const { theme } = useAppTheme();
  const isAndroid = Platform.OS === 'android';
  const storeName = isAndroid ? 'Play Store' : 'App Store';

  const handleUpdate = () => {
    if (onUpdate) {
      onUpdate();
      return;
    }
    const url = isAndroid ? PLAY_STORE_URL : APP_STORE_URL;
    void Linking.openURL(url).catch(() => {
      /* the store deep-link failing is non-fatal — the card stays up */
    });
  };

  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={onLater}>
      <View style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}>
        <View
          style={[
            styles.card,
            theme.shadows.xl,
            { backgroundColor: theme.colors.backgroundElevated, borderColor: theme.colors.border },
          ]}
          testID="update-available-card"
          accessibilityViewIsModal
        >
          <View style={styles.iconWrap}>
            <WhaleIcon size={44} color={theme.colors.primary} />
          </View>
          <Text
            style={[styles.title, { color: theme.colors.text }]}
            testID="update-available-title"
          >
            Update available
          </Text>
          <Text
            style={[styles.body, { color: theme.colors.textSecondary }]}
            testID="update-available-body"
          >
            A new version of Portable is available on the {storeName}, with the latest features and
            fixes.
          </Text>

          <Pressable
            testID="update-available-update"
            accessibilityRole="button"
            style={[styles.updateButton, { backgroundColor: theme.colors.primary }]}
            onPress={handleUpdate}
          >
            <Text style={[styles.updateButtonText, { color: theme.colors.textInverse }]}>
              Update on {storeName}
            </Text>
          </Pressable>

          <Pressable
            testID="update-available-later"
            accessibilityRole="button"
            style={styles.laterButton}
            onPress={onLater}
          >
            <Text style={[styles.laterButtonText, { color: theme.colors.textSecondary }]}>
              Later
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  iconWrap: { marginBottom: 4 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, textAlign: 'center', marginBottom: 8 },
  updateButton: {
    alignSelf: 'stretch',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
    alignItems: 'center',
  },
  updateButtonText: { fontSize: 16, fontWeight: '600' },
  // 44pt touch-target floor (iOS HIG) for the low-emphasis text button.
  laterButton: {
    alignSelf: 'stretch',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  laterButtonText: { fontSize: 15, fontWeight: '500' },
});
