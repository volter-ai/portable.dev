/**
 * SandboxWebView — the Apple-App-Store-compliant viewer for a user-controlled URL
 * (a tunnel/dev-server preview).
 *
 * The crux (root CLAUDE.md anti-pattern + web `RuntimeTunnelDetailInstance`
 * `isIOS()` gate): NEVER embed arbitrary external web content in a WebView on iOS —
 * Apple rejects it. So:
 *
 *   - **iOS** → render an "Open in browser" button that opens the URL in the
 *     SYSTEM browser (SFSafariViewController) via `expo-web-browser`. No embed.
 *   - **Android** (and any non-iOS) → embed with `react-native-webview`.
 *
 * `react-native-webview` and `expo-web-browser` are loaded via a RENDER/CALL-time
 * `require` (NOT a top-level import) so importing this module never pulls the
 * native modules into the Jest/Metro graph — only an actual Android render / iOS
 * press touches them (the same device-only pattern as `react-native-pdf`).
 * Both seams are injectable for tests.
 */

import type { ComponentType } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppTheme } from '../../theme';
import { Icon } from '../../theme/icons/Icon';

/** Minimal structural shape of the `react-native-webview` `WebView` we use. */
export interface WebViewLike {
  source: { uri: string };
  style?: unknown;
  testID?: string;
  /** Native load failure (DNS, refused, etc.). */
  onError?: (event: { nativeEvent?: { description?: string; code?: number } }) => void;
  /** HTTP error status from the loaded page (e.g. a 502/530 from a dead tunnel). */
  onHttpError?: (event: { nativeEvent?: { statusCode?: number; description?: string } }) => void;
}

export interface SandboxWebViewProps {
  /** The user URL to preview. Empty/undefined → the "no live view" placeholder. */
  url: string | undefined;
  /** testID prefix → `<prefix>-webview` / `<prefix>-open-external` / `<prefix>-liveview-empty`. */
  testIDPrefix?: string;
  /** Button label for the iOS external-open path. */
  label?: string;
  /** Platform override for the branch decision (default `Platform.OS`). */
  platform?: typeof Platform.OS;
  /** Open the URL in the SYSTEM browser (iOS path). Default: expo-web-browser. */
  openExternal?: (url: string) => void;
  /** WebView component (Android path). Default: render-time require of react-native-webview. */
  WebViewComponent?: ComponentType<WebViewLike>;
  /** Minimum embed height (Android). */
  minHeight?: number;
  /**
   * Fired when the embedded WebView fails to load the URL — a native error (DNS /
   * connection refused) or an HTTP error status (a dead tunnel's 502/530 from
   * Cloudflare). Used to trigger lazy tunnel repair. Android embed only (iOS opens
   * the system browser, which the app can't observe).
   */
  onLoadError?: (info: { statusCode?: number; description?: string }) => void;
}

/**
 * Open a URL in the SYSTEM browser (SFSafariViewController on iOS, Custom Tabs on
 * Android) — the Apple-compliant external-open. Exported so screens that also need
 * a header "Open" action (e.g. the tunnel detail) reuse the SAME implementation
 * instead of duplicating the lazy require. Required at call time so importing this
 * file never pulls expo-web-browser into the module graph.
 */
export function openSandboxUrlExternal(url: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WebBrowser = require('expo-web-browser');
  void WebBrowser.openBrowserAsync(url, { presentationStyle: 'fullScreen' });
}

function loadWebView(): ComponentType<WebViewLike> {
  // Render-time require keeps react-native-webview OUT of the static module graph.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('react-native-webview').WebView as ComponentType<WebViewLike>;
}

export function SandboxWebView({
  url,
  testIDPrefix = 'sandbox',
  label = 'Open in browser',
  platform = Platform.OS,
  openExternal = openSandboxUrlExternal,
  WebViewComponent,
  minHeight = 220,
  onLoadError,
}: SandboxWebViewProps) {
  const { theme } = useAppTheme();

  if (!url) {
    return (
      <View style={styles.empty} testID={`${testIDPrefix}-liveview-empty`}>
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
          No live view available
        </Text>
      </View>
    );
  }

  // iOS: open in the system browser — NEVER embed (App Store Guideline 4.3 / 3.1.1).
  if (platform === 'ios') {
    return (
      <View style={[styles.iosContainer, { minHeight }]} testID={`${testIDPrefix}-liveview-ios`}>
        <Icon name="globe" size={28} color={theme.colors.primary} />
        <Pressable
          testID={`${testIDPrefix}-open-external`}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={[styles.openButton, { backgroundColor: theme.colors.primary }]}
          onPress={() => openExternal(url)}
        >
          <Text style={[styles.openButtonText, { color: theme.colors.textInverse }]}>{label}</Text>
        </Pressable>
        <Text style={[styles.hint, { color: theme.colors.textTertiary }]} numberOfLines={1}>
          {url}
        </Text>
      </View>
    );
  }

  // Android (and any non-iOS): embed via react-native-webview.
  const WebView = WebViewComponent ?? loadWebView();
  return (
    <WebView
      testID={`${testIDPrefix}-webview`}
      source={{ uri: url }}
      style={[styles.webview, { minHeight }]}
      onError={
        onLoadError ? (e) => onLoadError({ description: e?.nativeEvent?.description }) : undefined
      }
      onHttpError={
        onLoadError
          ? (e) =>
              onLoadError({
                statusCode: e?.nativeEvent?.statusCode,
                description: e?.nativeEvent?.description,
              })
          : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
  iosContainer: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  openButton: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  openButtonText: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 11, maxWidth: '90%' },
  empty: { padding: 16, alignItems: 'center' },
  emptyText: { fontSize: 13 },
});
