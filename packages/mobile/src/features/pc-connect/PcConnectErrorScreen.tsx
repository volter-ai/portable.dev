/**
 * PcConnectErrorScreen — shown by {@link PcConnectGateHost} when a FRESH pairing
 * attempt's link/connect step fails (the QR scan itself succeeded; saving the JWT or
 * verifying the PC did not). Mirrors the warning-icon/title/body/"Try again" shape of
 * `ConnectionFailedScreen` (the post-pairing equivalent), but scoped to the
 * first-pairing case — there is no prior connected pcId / stale credential to clear
 * here, so "Try again" just returns to the connect landing for a fresh scan.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, useAppTheme } from '../../theme';

export interface PcConnectErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export function PcConnectErrorScreen({ message, onRetry }: PcConnectErrorScreenProps) {
  const { theme } = useAppTheme();

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      testID="pc-connect-error"
    >
      <Icon name="warning" size={44} color={theme.colors.warning} />
      <Text style={[styles.title, { color: theme.colors.text }]} testID="pc-connect-error-title">
        Couldn&apos;t connect
      </Text>
      <Text
        style={[styles.body, { color: theme.colors.textSecondary }]}
        testID="pc-connect-error-body"
      >
        {message}
      </Text>
      <Pressable
        testID="pc-connect-error-retry"
        accessibilityRole="button"
        style={[styles.button, { backgroundColor: theme.colors.primary }]}
        onPress={onRetry}
      >
        <Text style={[styles.buttonText, { color: theme.colors.textInverse }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, textAlign: 'center', marginBottom: 8 },
  button: { paddingVertical: 14, paddingHorizontal: 32, borderRadius: 10, alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
