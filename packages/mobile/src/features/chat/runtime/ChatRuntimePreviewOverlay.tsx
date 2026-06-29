/**
 * ChatRuntimePreviewOverlay — the in-app, navigable preview of the running project,
 * shown OVER the chat. Android only in
 * practice: the embedded `react-native-webview` lets the user navigate their dev
 * server without leaving the chat. iOS NEVER reaches the embed — the bubble opens
 * the system browser directly (App Store rule) — but the gate is honored here too
 * because the body is the shared {@link SandboxWebView} (iOS branch = an "Open in
 * browser" button, never an embed).
 *
 * Returns `null` when not visible (the SelectorSheet pattern) so the preview's
 * testIDs are deterministically absent until the bubble is tapped.
 */

import type { TunnelData } from '@vgit2/shared/types';
import type { ComponentType } from 'react';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../../theme';
import { Icon } from '../../../theme/icons/Icon';
import { stripProtocol } from '../../runtime/runtimeHelpers';
import {
  openSandboxUrlExternal,
  SandboxWebView,
  type WebViewLike,
} from '../../runtime/SandboxWebView';
import { useTunnelRepair } from './useTunnelRepair';

export interface ChatRuntimePreviewOverlayProps {
  visible: boolean;
  tunnel: TunnelData;
  onClose: () => void;
  /** Platform override for the SandboxWebView branch (default `Platform.OS`). */
  platform?: typeof Platform.OS;
  /** Open the URL in the SYSTEM browser. Default: expo-web-browser. */
  openExternal?: (url: string) => void;
  /** WebView component (Android embed). Default: render-time require of react-native-webview. */
  WebViewComponent?: ComponentType<WebViewLike>;
}

export function ChatRuntimePreviewOverlay({
  visible,
  tunnel,
  onClose,
  platform = Platform.OS,
  openExternal = openSandboxUrlExternal,
  WebViewComponent,
}: ChatRuntimePreviewOverlayProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  // Remount the embed to RELOAD it (the web parity for the iframe `key` bump).
  const [reloadKey, setReloadKey] = useState(0);
  const { status: repairStatus, handleEmbedError, reset: resetRepair } = useTunnelRepair();

  const closeAndReset = () => {
    resetRepair();
    onClose();
  };

  if (!visible) return null;

  const title = tunnel.name || stripProtocol(tunnel.url);

  return (
    <Modal visible animationType="slide" onRequestClose={closeAndReset} transparent={false}>
      <View
        testID="chat-runtime-preview-overlay"
        style={[
          styles.container,
          { backgroundColor: theme.colors.background, paddingTop: insets.top },
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.borderLight }]}>
          <View style={styles.headerText}>
            <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.url, { color: theme.colors.textTertiary }]} numberOfLines={1}>
              {stripProtocol(tunnel.url)}
            </Text>
          </View>

          <Pressable
            testID="chat-runtime-preview-reload"
            accessibilityRole="button"
            accessibilityLabel="Reload preview"
            hitSlop={8}
            style={styles.action}
            onPress={() => {
              // A manual reload also clears the repair latch so a fresh load can
              // re-trigger repair if it fails again.
              resetRepair();
              setReloadKey((k) => k + 1);
            }}
          >
            <Icon name="refresh" size={18} color={theme.colors.textSecondary} />
          </Pressable>
          <Pressable
            testID="chat-runtime-preview-open"
            accessibilityRole="button"
            accessibilityLabel="Open in browser"
            hitSlop={8}
            style={styles.action}
            onPress={() => openExternal(tunnel.url)}
          >
            <Icon name="globe" size={18} color={theme.colors.textSecondary} />
          </Pressable>
          <Pressable
            testID="chat-runtime-preview-close"
            accessibilityRole="button"
            accessibilityLabel="Close preview"
            hitSlop={8}
            style={styles.action}
            onPress={closeAndReset}
          >
            <Icon name="xmark" size={18} color={theme.colors.text} />
          </Pressable>
        </View>

        <View style={styles.body}>
          {repairStatus === 'dev_server_down' ? (
            <View style={styles.center} testID="chat-runtime-preview-dev-down">
              <Icon name="globe" size={28} color={theme.colors.textTertiary} />
              <Text style={[styles.downTitle, { color: theme.colors.text }]}>
                The dev server isn't running
              </Text>
              <Text style={[styles.downBody, { color: theme.colors.textSecondary }]}>
                There's nothing to preview on port {tunnel.port}. Ask the agent to restart the dev
                server, then reopen this preview.
              </Text>
            </View>
          ) : (
            <>
              <SandboxWebView
                key={`chat-runtime-preview-${reloadKey}-${tunnel.url}`}
                url={tunnel.url}
                testIDPrefix="chat-runtime-preview"
                label="Open project in browser"
                platform={platform}
                openExternal={openExternal}
                WebViewComponent={WebViewComponent}
                onLoadError={() => handleEmbedError(tunnel)}
              />
              {repairStatus === 'repairing' ? (
                <View
                  style={[styles.repairBanner, { backgroundColor: theme.colors.surface }]}
                  testID="chat-runtime-preview-repairing"
                  pointerEvents="none"
                >
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text style={[styles.repairText, { color: theme.colors.textSecondary }]}>
                    Reconnecting the preview…
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: '600' },
  url: { fontSize: 11 },
  action: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  downTitle: { fontSize: 15, fontWeight: '600' },
  downBody: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  repairBanner: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  repairText: { fontSize: 12, fontWeight: '500' },
});
