/**
 * ProgressBar — a small, theme-agnostic determinate progress bar.
 *
 * Colors come in as props (so it works on both the app-theme gradient surface and
 * the sign-in/onboarding dark theme without re-declaring tokens). The fill width
 * animates to the target percentage, so a stream of discrete percentages (the
 * provisioning steps) reads as smooth motion rather than snapping. `width: %` can't
 * run on the native driver, so the animation stays on the JS driver — fine for a
 * single low-frequency bar.
 */

import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export interface ProgressBarProps {
  /** Target completion, 0–100 (clamped). */
  percent: number;
  /** Track (unfilled) color. */
  trackColor: string;
  /** Fill color. */
  fillColor: string;
  /** Bar thickness in px (default 6). */
  height?: number;
  /** Animation duration in ms (default 400). */
  durationMs?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

export function ProgressBar({
  percent,
  trackColor,
  fillColor,
  height = 6,
  durationMs = 400,
  style,
  testID,
}: ProgressBarProps) {
  const target = clamp(percent);
  const anim = useRef(new Animated.Value(target)).current;

  useEffect(() => {
    const animation = Animated.timing(anim, {
      toValue: target,
      duration: durationMs,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [anim, target, durationMs]);

  const width = anim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp',
  });

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(target) }}
      style={[
        styles.track,
        { backgroundColor: trackColor, height, borderRadius: height / 2 },
        style,
      ]}
    >
      <Animated.View
        style={[styles.fill, { backgroundColor: fillColor, width, borderRadius: height / 2 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
  },
});
