/**
 * TypingIndicator — the "agent is working" animation, a native port of the web
 * `ChatInstance/components/TypingIndicator.tsx`:
 *
 *   - three 6px dots in the agent's color, bobbing −10px with 0 / 0.2s / 0.4s
 *     staggered delays over a 1.4s cycle (the web `typing` keyframes: up at 30%,
 *     back at 60%, hold to 100%; opacity 0.7 → 1);
 *   - the italic status text — "{agent} is working..." or the compressing copy;
 *   - INLINE mode (dots + text, rendered inside the streaming assistant
 *     message) and STANDALONE mode (agent avatar + name badge over a colored
 *     left rail with the hollow-circle pulse, shown while no assistant message
 *     exists yet), both straight from the web component.
 *
 * Animated + useNativeDriver replaces the web CSS keyframes; visuals (sizes,
 * colors, timings) are kept byte-identical to the web styles.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { ChatStatus } from '@vgit2/shared/types';

import { DEFAULT_AGENT_COLOR } from './agentInfo';
import { useAppTheme } from '../../theme';

export interface TypingIndicatorProps {
  /** Dots + text only (inside an existing assistant message). */
  inline?: boolean;
  status?: ChatStatus;
  /** Display name for the working line ("Best Practice is working..."). */
  agentName?: string;
  /** Accent color for the dots / avatar / badge (the agent's colorTheme). */
  agentColor?: string;
  /** Omit the text line (web `hideText` parity). */
  hideText?: boolean;
  testID?: string;
}

/** Web `typing` keyframes: 1.4s cycle — rise to −10px by 30%, back by 60%, hold. */
const CYCLE_RISE_MS = 420;
const CYCLE_FALL_MS = 420;
const CYCLE_HOLD_MS = 560;
const DOT_STAGGER_MS = 200;

/** One bobbing dot, phase-shifted by `delayMs` (web `animation-delay` parity). */
function TypingDot({ color, delayMs }: { color: string; delayMs: number }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: CYCLE_RISE_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: CYCLE_FALL_MS,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.delay(CYCLE_HOLD_MS),
      ])
    );
    const starter = setTimeout(() => loop.start(), delayMs);
    return () => {
      clearTimeout(starter);
      loop.stop();
    };
  }, [progress, delayMs]);

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          backgroundColor: color,
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }),
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) },
          ],
        },
      ]}
    />
  );
}

function Dots({ color }: { color: string }) {
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <TypingDot key={i} color={color} delayMs={i * DOT_STAGGER_MS} />
      ))}
    </View>
  );
}

export function TypingIndicator({
  inline = false,
  status = 'running',
  agentName,
  agentColor,
  hideText = false,
  testID = 'chat-typing-indicator',
}: TypingIndicatorProps) {
  const { theme } = useAppTheme();
  const color = agentColor || DEFAULT_AGENT_COLOR;
  const displayName = agentName || 'Agent';
  const text =
    status === 'compressing'
      ? 'compressing, this could take a minute...'
      : `${displayName} is working...`;

  // Standalone slide-in (web `slideIn 0.3s ease-out`).
  const enter = useRef(new Animated.Value(inline ? 1 : 0)).current;
  useEffect(() => {
    if (inline) return;
    Animated.timing(enter, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [enter, inline]);

  if (inline) {
    return (
      <View style={[styles.inlineRow, !hideText && styles.inlineRowPadded]} testID={testID}>
        <Dots color={color} />
        {!hideText && (
          <Text style={[styles.text, { color: theme.colors.textSecondary }]}>{text}</Text>
        )}
      </View>
    );
  }

  const initials = displayName
    .split(' ')
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <Animated.View
      style={[
        styles.standalone,
        {
          opacity: enter,
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
          ],
        },
      ]}
      testID={testID}
    >
      {/* Colored left rail (web: 3px line down the indicator). */}
      <View style={[styles.rail, { backgroundColor: color }]} />

      {/* Header: agent avatar + name badge. */}
      <View style={styles.header}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={[styles.badge, { backgroundColor: color }]}>
          <Text style={[styles.badgeText, { color: theme.colors.surface }]}>{displayName}</Text>
        </View>
      </View>

      {/* Working line: dots + text. */}
      <View style={styles.workingRow}>
        <Dots color={color} />
        <Text style={[styles.text, { color: theme.colors.textSecondary }]}>{text}</Text>
      </View>

      {/* Hollow circle pulse anchored on the rail (web parity). */}
      <View style={[styles.hollowCircle, { borderColor: color }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineRowPadded: { paddingTop: 8 },
  text: { fontSize: 11, fontStyle: 'italic' },
  standalone: { marginBottom: 16, paddingLeft: 12, position: 'relative' },
  rail: { position: 'absolute', left: 2, top: 0, bottom: 8, width: 3 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 10, fontWeight: '700', color: '#ffffff' },
  badge: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  badgeText: { fontSize: 10, fontWeight: '600' },
  workingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  hollowCircle: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 3,
    backgroundColor: 'transparent',
  },
});
