/**
 * TunnelDetailScreen — `/runtime/tunnel/:port` (web `RuntimeTunnelDetailInstance`).
 *
 * Apple compliance (root CLAUDE.md anti-pattern): the tunnel URL is the user's own
 * dev server — arbitrary external content. It is NEVER embedded in a WebView on
 * iOS; the `SandboxWebView` opens it in the system browser there and embeds it via
 * `react-native-webview` only on Android. A header "Open" button opens it
 * externally on both platforms. The web "console" is a non-functional placeholder
 * (log streaming was never wired) — mirrored here, with the real action being the
 * external open.
 */

import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ComponentType } from 'react';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';
import { useTunnelRepair } from '../chat/runtime/useTunnelRepair';
import { useOptionalSocket } from '../socket';
import { RuntimeHeader } from './RuntimeHeader';
import { SandboxWebView, openSandboxUrlExternal, type WebViewLike } from './SandboxWebView';
import { stripProtocol, tunnelProvider } from './runtimeHelpers';
import { useRuntime } from './useRuntime';

export interface TunnelDetailProps {
  /** Tunnel port (route param). */
  port?: number | string;
  platform?: typeof Platform.OS;
  /** Open the tunnel URL in the system browser. Default: expo-web-browser. */
  openExternal?: (url: string) => void;
  WebViewComponent?: ComponentType<WebViewLike>;
}

export function TunnelDetailScreen({
  port,
  platform = Platform.OS,
  openExternal = openSandboxUrlExternal,
  WebViewComponent,
}: TunnelDetailProps) {
  const params = useLocalSearchParams<{ port?: string }>();
  const portValue = String(port ?? params.port ?? '');
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { tunnels } = useRuntime(useOptionalSocket());
  const [reloadKey, setReloadKey] = useState(0);
  const [showConsole, setShowConsole] = useState(false);
  const { handleEmbedError } = useTunnelRepair();

  const tunnel = tunnels.find((t) => String(t.port) === portValue);

  if (!tunnel) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <RuntimeHeader type="Tunnel" title={portValue} backTestID="tunnel-detail-back" />
        <View style={styles.center}>
          <Text
            style={[styles.notFound, { color: theme.colors.textSecondary }]}
            testID="tunnel-detail-not-found"
          >
            This tunnel is no longer active.
          </Text>
        </View>
      </View>
    );
  }

  const provider = tunnelProvider(tunnel.url);

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      testID="tunnel-detail"
    >
      <RuntimeHeader
        type="Tunnel"
        title={tunnel.name || `Port ${tunnel.port}`}
        backTestID="tunnel-detail-back"
        right={
          <>
            <Pressable
              testID="tunnel-detail-reload"
              accessibilityLabel="Reload"
              hitSlop={8}
              onPress={() => setReloadKey((k) => k + 1)}
            >
              <Icon name="refresh" size={18} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable
              testID="tunnel-console-toggle"
              accessibilityLabel="Console"
              hitSlop={8}
              onPress={() => setShowConsole((v) => !v)}
            >
              <Icon name="terminal" size={18} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable
              testID="tunnel-detail-open"
              accessibilityLabel="Open in browser"
              hitSlop={8}
              onPress={() => openExternal(tunnel.url)}
            >
              <Icon name="globe" size={18} color={theme.colors.primary} />
            </Pressable>
          </>
        }
      />

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View
          style={[
            styles.infoCard,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.url, { color: theme.colors.text }]} testID="tunnel-detail-url">
            {stripProtocol(tunnel.url)}
          </Text>
          <View style={styles.metaRow}>
            <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
              Port {tunnel.port}
            </Text>
            {provider ? (
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>Cloudflare</Text>
            ) : null}
            <Text
              style={[
                styles.meta,
                { color: tunnel.active === false ? theme.colors.danger : theme.colors.success },
              ]}
            >
              {tunnel.active === false ? 'Inactive' : 'Active'}
            </Text>
          </View>
        </View>

        {/* Preview: Android embed / iOS external-open (App Store compliant). */}
        <View style={[styles.preview, { borderColor: theme.colors.border }]}>
          <SandboxWebView
            key={`${reloadKey}-${tunnel.url}`}
            url={tunnel.url}
            testIDPrefix="tunnel"
            label="Open in browser"
            platform={platform}
            openExternal={openExternal}
            WebViewComponent={WebViewComponent}
            minHeight={320}
            onLoadError={() => handleEmbedError(tunnel)}
          />
        </View>

        {showConsole ? (
          <View
            style={[
              styles.console,
              { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            ]}
            testID="tunnel-console"
          >
            <Text style={[styles.consoleTitle, { color: theme.colors.text }]}>Console Logs</Text>
            <Text style={[styles.consoleHint, { color: theme.colors.textTertiary }]}>
              Console log capture is not yet available for this tunnel.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  notFound: { fontSize: 14, textAlign: 'center' },
  infoCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  url: { fontSize: 14, fontWeight: '600' },
  metaRow: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  meta: { fontSize: 12, fontWeight: '500' },
  preview: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
    minHeight: 320,
  },
  console: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  consoleTitle: { fontSize: 13, fontWeight: '700' },
  consoleHint: { fontSize: 12 },
});
