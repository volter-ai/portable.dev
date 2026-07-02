/**
 * RunningOnPcBadge — the rev12 cross-surface presence pill (PRD D55).
 *
 * Shown on a chat whose Claude Code session is live in a TERMINAL on the PC:
 * "Running on PC" while a turn is in flight, "Open on PC" while the terminal
 * session sits idle between turns. Renders nothing when the chat has no live
 * terminal session, so callers mount it unconditionally.
 *
 * Used by the chat-card body (chat lists / home preview) and the active-chat
 * header. Presence comes from `useRunningOnPc` (the `user:runtime_state` join).
 */
import { StyleSheet, Text, View } from 'react-native';

import { useRunningOnPc } from './useRunningOnPc';
import { useAppTheme, withAlpha } from '../../theme';

export function RunningOnPcBadge({ chatId }: { chatId: string }) {
  const { theme } = useAppTheme();
  const { onPc, runningOnPc } = useRunningOnPc(chatId);
  if (!onPc) return null;

  const color = runningOnPc ? theme.colors.primary : theme.colors.textTertiary;
  return (
    <View
      testID={`chat-on-pc-${chatId}`}
      accessibilityLabel={runningOnPc ? 'Running on PC' : 'Open on PC'}
      style={[
        styles.pill,
        { backgroundColor: withAlpha(color, '22'), borderColor: withAlpha(color, '55') },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {runningOnPc ? 'Running on PC' : 'Open on PC'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: { fontSize: 11, fontWeight: '600' },
});
