/**
 * ReconnectingBanner.
 *
 * A persistent banner shown while the socket is down AFTER it has connected at
 * least once (i.e. a resume/reconnect, not the initial pre-provision connect).
 * It is driven purely by `useSocketStore` state — there is NO arbitrary timeout:
 * it appears the moment the socket is not connected and clears the moment a
 * `connect` event flips `connected` back to true.
 */

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useSocketStore } from './socketStore';
import { useAppTheme } from '../../theme';

export function ReconnectingBanner() {
  const connected = useSocketStore((s) => s.connected);
  const hasConnectedOnce = useSocketStore((s) => s.hasConnectedOnce);
  const connectionState = useSocketStore((s) => s.connectionState);
  const { theme, getBoldTextColor } = useAppTheme();

  // Only surface after the first successful connection: a fresh mount that has
  // never connected is "connecting" (handled by provisioning UI), not
  // "reconnecting". `failed` has its own terminal UX.
  if (connected || !hasConnectedOnce || connectionState === 'failed') return null;

  // Use the accent for the reconnecting indicator; the text color stays
  // readable over it (bold-text luminance pick).
  const fg = getBoldTextColor();

  return (
    <View
      style={[styles.banner, { backgroundColor: theme.colors.primary }]}
      testID="reconnecting-banner"
    >
      <ActivityIndicator size="small" color={fg} />
      <Text style={[styles.text, { color: fg }]} testID="reconnecting-banner-text">
        Reconnecting…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 9998,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  text: { fontSize: 14, fontWeight: '500' },
});
