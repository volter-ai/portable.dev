/**
 * TunnelsListScreen — `/runtime/tunnels`. Lists
 * the active Cloudflare tunnels. A card opens the tunnel detail (where the
 * URL is previewed/opened in an Apple-compliant way) — EXCEPT on iOS:
 * iOS never embeds a WebView, so the detail screen is a dead hop there — the
 * card tap opens the tunnel URL in the SYSTEM browser directly.
 */

import { router } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TunnelData } from '@vgit2/shared/types';

import { useAppTheme } from '../../theme';
import { useOptionalSocket } from '../socket';
import { TunnelCard } from './cards';
import { RuntimeHeader } from './RuntimeHeader';
import { runtimeRoutes, type RuntimeNavigate } from './runtimeRoutes';
import { openSandboxUrlExternal } from './SandboxWebView';
import { useRuntime } from './useRuntime';

export function TunnelsListScreen({
  navigate,
  platform = Platform.OS,
  openExternal,
}: {
  navigate?: RuntimeNavigate;
  /** Platform override for the iOS direct-open split. */
  platform?: typeof Platform.OS;
  /** Open the tunnel URL in the SYSTEM browser (iOS path). Default: expo-web-browser. */
  openExternal?: (url: string) => void;
}) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { tunnels } = useRuntime(useOptionalSocket());
  const go = navigate ?? ((p: string) => router.push(p));
  const openTunnel = (t: TunnelData) => {
    if (platform === 'ios' && t.url) {
      (openExternal ?? openSandboxUrlExternal)(t.url);
      return;
    }
    go(runtimeRoutes.tunnel(t.port));
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]} testID="tunnels-list">
      <RuntimeHeader title="Tunnels" backTestID="tunnels-list-back" />
      <Text style={styles.hidden} testID="tunnels-list-count">
        {tunnels.length}
      </Text>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {tunnels.length === 0 ? (
          <Text
            style={[styles.empty, { color: theme.colors.textSecondary }]}
            testID="tunnels-list-empty"
          >
            No active tunnels
          </Text>
        ) : (
          tunnels.map((t) => (
            <TunnelCard
              key={t.port}
              tunnel={t}
              testID={`tunnel-open-${t.port}`}
              onPress={() => openTunnel(t)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, gap: 10 },
  empty: { fontSize: 14, padding: 16, textAlign: 'center' },
  hidden: { width: 0, height: 0, opacity: 0 },
});
