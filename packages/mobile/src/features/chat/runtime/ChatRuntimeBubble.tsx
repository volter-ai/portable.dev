/**
 * ChatRuntimeBubble — a DRAGGABLE floating launcher for the chat's running project.
 * It floats over the
 * chat transcript whenever a live dev-server tunnel exists for the chat, with a
 * pulsing "live" dot, and can be dragged anywhere on screen so it never blocks the
 * conversation. Tap is platform-gated:
 *
 *   - **iOS** → open the running project in the SYSTEM browser (SFSafariViewController
 *     via `openSandboxUrlExternal`). NEVER an embedded WebView — Apple rejects
 *     arbitrary in-app web content (root CLAUDE.md anti-pattern). The bubble is the
 *     ONLY iOS affordance.
 *   - **Android** (non-iOS) → open the in-app {@link ChatRuntimePreviewOverlay}: an
 *     embedded `react-native-webview` of the running project the user can navigate,
 *     staying in the chat context (web parity).
 *
 * Built on the proven `SwipeableChatRow` stack (`react-native-reanimated` +
 * `react-native-gesture-handler`): the drag is a `Gesture.Pan()` writing shared
 * values (clamped within the screen + safe area); a tap (no movement, gated by
 * `activeOffset`) passes through to the inner `Pressable` — so the press is
 * `fireEvent.press`-able in tests without driving the gesture. All motion is
 * shared-value driven (no reanimated layout builders — the shared jest mock stubs
 * only that surface); the pulse loop `cancelAnimation`s on unmount.
 *
 * Seams (`platform` / `openExternal` / `WebViewComponent`) are injectable so tests
 * never touch the native browser/WebView modules.
 */

import type { TunnelData } from '@vgit2/shared/types';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Dimensions, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../../../theme';
import { Icon } from '../../../theme/icons/Icon';
import { openSandboxUrlExternal, type WebViewLike } from '../../runtime/SandboxWebView';
import { ChatRuntimePreviewOverlay } from './ChatRuntimePreviewOverlay';
import { isTunnelLive } from './useChatRuntimePreview';

const BUBBLE_SIZE = 52;
const MARGIN = 14;
const PULSE_DURATION_MS = 900;

export interface ChatRuntimeBubbleProps {
  /** The selected dev-server tunnel for this chat (null → render nothing). */
  tunnel: TunnelData | null;
  /** Platform override for the tap decision (default `Platform.OS`). */
  platform?: typeof Platform.OS;
  /** Open the URL in the SYSTEM browser (iOS path). Default: expo-web-browser. */
  openExternal?: (url: string) => void;
  /** WebView component for the Android preview overlay. Default: render-time require. */
  WebViewComponent?: ComponentType<WebViewLike>;
}

export function ChatRuntimeBubble({
  tunnel,
  platform = Platform.OS,
  openExternal = openSandboxUrlExternal,
  WebViewComponent,
}: ChatRuntimeBubbleProps) {
  const { theme } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Drag bounds from the window + safe area (captured at mount — rotation is a
  // documented v1 gap). maxX/maxY are floored at the mins so a 0-size window in
  // Jest can't produce an inverted clamp.
  const win = Dimensions.get('window');
  const minX = MARGIN;
  const maxX = Math.max(MARGIN, win.width - BUBBLE_SIZE - MARGIN);
  const minY = insets.top + MARGIN;
  const maxY = Math.max(minY, win.height - BUBBLE_SIZE - insets.bottom - MARGIN);

  // Default position: top-right, just below the chat header.
  const posX = useSharedValue(maxX);
  const posY = useSharedValue(Math.min(maxY, insets.top + 64));
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const pulse = useSharedValue(1);

  const isLive = !!tunnel && isTunnelLive(tunnel);

  useEffect(() => {
    if (isLive) {
      pulse.value = withRepeat(withTiming(0.35, { duration: PULSE_DURATION_MS }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 1;
    }
    // Reanimated's own cleanup does NOT stop an infinite withRepeat loop — cancel it.
    return () => cancelAnimation(pulse);
  }, [isLive, pulse]);

  const pan = Gesture.Pan()
    // Only claim a real drag; a stationary tap passes through to the Pressable.
    .activeOffsetX([-6, 6])
    .activeOffsetY([-6, 6])
    .onStart(() => {
      startX.value = posX.value;
      startY.value = posY.value;
    })
    .onUpdate((e) => {
      posX.value = Math.min(maxX, Math.max(minX, startX.value + e.translationX));
      posY.value = Math.min(maxY, Math.max(minY, startY.value + e.translationY));
    })
    .withTestId('chat-runtime-bubble-pan');

  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: posX.value }, { translateY: posY.value }],
  }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const handlePress = useCallback(() => {
    if (!tunnel) return;
    if (platform === 'ios') {
      // iOS: NEVER embed a user URL — open the system browser. (A dead tunnel is
      // cleared on the next reconnect by the always-emit + exit-eviction fixes, so
      // the bubble won't offer a stale preview; the system browser is unobservable,
      // so there is no in-app repair path here.)
      openExternal(tunnel.url);
      return;
    }
    // Android: open the in-app embed; its onLoadError drives lazy repair.
    setOverlayOpen(true);
  }, [tunnel, platform, openExternal]);

  if (!tunnel) return null;

  const label = tunnel.name
    ? `running project ${tunnel.name}`
    : `running project on port ${tunnel.port}`;

  return (
    <>
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="box-none"
        testID="chat-runtime-bubble-layer"
      >
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.anchor, bubbleStyle]}>
            <Pressable
              testID="chat-runtime-bubble"
              accessibilityRole="button"
              accessibilityLabel={`Open ${label}`}
              onPress={handlePress}
              style={[
                styles.bubble,
                {
                  // Inverted scheme for contrast: the accent fills the circle and the
                  // globe is drawn in the chat background colour so it reads as a
                  // cutout (no real mask needed — just a contrasting glyph colour).
                  backgroundColor: theme.colors.primary,
                  borderColor: theme.colors.primaryDark,
                  ...theme.shadows.lg,
                },
              ]}
            >
              <Icon name="globe" size={24} color={theme.colors.background} />
              <Animated.View
                style={[
                  styles.dot,
                  dotStyle,
                  {
                    backgroundColor: isLive ? theme.colors.success : theme.colors.textTertiary,
                    // Ring matches the filled bubble so the dot sits on the accent.
                    borderColor: theme.colors.primary,
                  },
                ]}
              />
            </Pressable>
          </Animated.View>
        </GestureDetector>
      </View>

      <ChatRuntimePreviewOverlay
        visible={overlayOpen}
        tunnel={tunnel}
        onClose={() => setOverlayOpen(false)}
        platform={platform}
        openExternal={openExternal}
        WebViewComponent={WebViewComponent}
      />
    </>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', top: 0, left: 0, width: BUBBLE_SIZE, height: BUBBLE_SIZE },
  bubble: {
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    borderRadius: BUBBLE_SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
  },
});
