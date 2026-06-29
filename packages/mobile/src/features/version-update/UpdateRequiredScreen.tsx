/**
 * UpdateRequiredScreen — the full-screen BLOCKING gate shown when the app
 * version is below the gateway's declared minimum. There is no
 * dismissal: the only action is to open the platform app store and update.
 *
 * Purely presentational + theme-aware (the {@link ConnectionFailedScreen}
 * template), so it renders deterministically under React Native Testing Library.
 * The store deep-link is opened via `Linking.openURL` (iOS deep-links the
 * `apps.apple.com` URL straight to the App Store app — NOT an embedded WebView,
 * so it satisfies the iOS arbitrary-web-content prohibition).
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Icon, useAppTheme } from '../../theme';

/** Store URLs for the update prompt. */
export const APP_STORE_URL = 'https://apps.apple.com/us/app/portable-dev/id6758861546';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=dev.portable.app';

export interface UpdateRequiredScreenProps {
  /**
   * Override the store-open action (tests inject a spy). Default: open the
   * platform store via `Linking.openURL`.
   */
  onUpdate?: () => void;
}

export function UpdateRequiredScreen({ onUpdate }: UpdateRequiredScreenProps) {
  const { theme } = useAppTheme();
  const isAndroid = Platform.OS === 'android';
  const storeName = isAndroid ? 'Play Store' : 'App Store';
  const [opening, setOpening] = useState(false);

  const handleUpdate = () => {
    setOpening(true);
    if (onUpdate) {
      onUpdate();
      return;
    }
    const url = isAndroid ? PLAY_STORE_URL : APP_STORE_URL;
    void Linking.openURL(url).catch(() => {
      /* the store deep-link failing is non-fatal — leave the screen up */
    });
  };

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      testID="update-required-screen"
    >
      <View style={styles.iconWrap}>
        <Icon name="download" size={44} color={theme.colors.primary} />
      </View>
      <Text style={[styles.title, { color: theme.colors.text }]} testID="update-required-title">
        Update Required
      </Text>
      <Text
        style={[styles.body, { color: theme.colors.textSecondary }]}
        testID="update-required-body"
      >
        A new version of Portable is required to continue. Please update from the {storeName}.
      </Text>

      <Pressable
        testID="update-required-button"
        accessibilityRole="button"
        style={[
          styles.button,
          { backgroundColor: theme.colors.primary },
          opening && styles.buttonDisabled,
        ]}
        disabled={opening}
        onPress={handleUpdate}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>
          Update on {storeName}
        </Text>
      </Pressable>

      {opening && (
        <ActivityIndicator
          testID="update-required-spinner"
          color={theme.colors.primary}
          style={styles.spinner}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  iconWrap: { marginBottom: 4 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, textAlign: 'center', marginBottom: 8 },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  spinner: { marginTop: 4 },
});
