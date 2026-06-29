/**
 * Mic level / waveform visualizer.
 *
 * A fixed row of bars whose heights follow the live input `level` (0..1) with a
 * gentle per-bar phase offset so it reads as a waveform rather than a single
 * meter. Purely presentational; `level` is driven by {@link useNativeSpeechRecognizer}
 * (the recognizer's `volumechange` events).
 */

import { StyleSheet, View } from 'react-native';

import { useAppTheme } from '../../../theme';

const BAR_COUNT = 24;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 40;
// Per-bar multipliers (static, deterministic) so the row looks like a waveform.
const BAR_WEIGHTS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const center = (BAR_COUNT - 1) / 2;
  const distance = Math.abs(i - center) / center; // 0 at center → 1 at edges
  return 0.45 + 0.55 * (1 - distance); // taller in the middle
});

export interface WaveformProps {
  /** Input level, 0..1. */
  level: number;
}

export function Waveform({ level }: WaveformProps) {
  const clamped = Math.max(0, Math.min(1, level));
  const { theme } = useAppTheme();
  return (
    <View style={styles.row} testID="voice-waveform">
      {BAR_WEIGHTS.map((weight, i) => {
        const height = MIN_BAR_HEIGHT + clamped * weight * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
        // The themed color rides the SAME inline layer as `height` (the test reads
        // the numeric-height layer, which is unaffected by the extra key).
        return (
          <View
            key={i}
            testID={`voice-waveform-bar-${i}`}
            style={[styles.bar, { height, backgroundColor: theme.colors.primary }]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: MAX_BAR_HEIGHT,
  },
  bar: {
    width: 3,
    borderRadius: 2,
  },
});
