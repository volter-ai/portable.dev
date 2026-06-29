/**
 * SwipeableChatRow — a chat-directory row you can swipe LEFT to reveal action
 * buttons (the iOS-Mail "puxar para o lado" pattern), built on
 * **react-native-reanimated** + **react-native-gesture-handler**.
 *
 * Layout: an `overflow:hidden` container holding (1) an always-rendered actions
 * layer pinned to the RIGHT edge, BEHIND the card, and (2) a foreground
 * `Animated.View` (the card) whose `translateX` is driven by a reanimated shared
 * value. A `Gesture.Pan()` updates the shared value within `[-actionsWidth, 0]`
 * and `onEnd` snaps OPEN (`-actionsWidth`) or CLOSED (`0`) by position + velocity
 * (`withTiming`). The pan only claims HORIZONTAL drags (`activeOffsetX` +
 * `failOffsetY`) so vertical `FlatList` scrolling passes straight through.
 *
 * The action buttons are rendered behind the card at ALL times (clipped, not
 * conditionally mounted) — so the user reveals them by swiping, but they stay in
 * the render tree (their `testID`s are press-targetable without a gesture, which
 * keeps the directory tests gesture-free). The worklets babel plugin
 * (`react-native-worklets/plugin`, auto-added by `babel-preset-expo`) workletizes
 * the gesture/`useAnimatedStyle` callbacks on device; under Jest the
 * `react-native-reanimated/mock` + `react-native-gesture-handler/jestSetup` run
 * them as plain JS.
 */

import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export interface SwipeableChatRowProps {
  /** The foreground card content (the pressable chat body). */
  children: ReactNode;
  /** The revealed action buttons — rendered behind the card, pinned right. */
  actions: ReactNode;
  /** Total width of the actions layer (sum of the action button widths). */
  actionsWidth: number;
  /** testID for the pan gesture (`fireGestureHandler` / `getByGestureTestId`). */
  swipeTestID?: string;
  /** testID for the row container. */
  testID?: string;
  /** Corner radius — clips the revealed actions to match the card (default 8). */
  borderRadius?: number;
}

/** Snap open once the card is dragged past this fraction of the actions width. */
const OPEN_THRESHOLD_RATIO = 0.4;
/** A fast horizontal fling opens/closes regardless of position (px/s). */
const VELOCITY_THRESHOLD = 600;
const SNAP_DURATION_MS = 180;

export function SwipeableChatRow({
  children,
  actions,
  actionsWidth,
  swipeTestID,
  testID,
  borderRadius = 8,
}: SwipeableChatRowProps) {
  // Current horizontal offset of the card (0 = closed, -actionsWidth = open).
  const translateX = useSharedValue(0);
  // Offset captured at gesture start, so a drag resumes from the open position.
  const startX = useSharedValue(0);

  const pan = Gesture.Pan()
    // Only claim clearly-horizontal drags; let vertical list scrolls pass through.
    .activeOffsetX([-15, 15])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      // Clamp to [-actionsWidth, 0]: left reveals actions, never overscroll right.
      translateX.value = Math.min(0, Math.max(-actionsWidth, startX.value + e.translationX));
    })
    .onEnd((e) => {
      const flungOpen = e.velocityX < -VELOCITY_THRESHOLD;
      const flungClosed = e.velocityX > VELOCITY_THRESHOLD;
      const draggedPastThreshold = translateX.value < -actionsWidth * OPEN_THRESHOLD_RATIO;
      const open = flungOpen || (draggedPastThreshold && !flungClosed);
      translateX.value = withTiming(open ? -actionsWidth : 0, { duration: SNAP_DURATION_MS });
    });

  if (swipeTestID) pan.withTestId(swipeTestID);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={[styles.container, { borderRadius }]} testID={testID}>
      <View style={[styles.actionsLayer, { width: actionsWidth }]}>{actions}</View>
      <GestureDetector gesture={pan}>
        <Animated.View style={cardStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative' },
  actionsLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: 'row',
  },
});
