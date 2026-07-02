/**
 * RunningOnPcBanner — the "Stop on PC" affordance (rev12 D60).
 *
 * Shown above the composer ONLY when this chat's Claude Code session is live in
 * a terminal on the PC. It explains the situation and offers "Stop on PC" —
 * distinct from the local `active-chat-stop` (which interrupts an api-spawned
 * run). Tapping ends the terminal session; on a CONFIRMED stop the presence
 * flips off and the next message continues the SAME conversation here (D56
 * adopt). An unconfirmed stop tells the user their next send will fork instead.
 *
 * Renders nothing when the chat has no live terminal session.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useRunningOnPc } from './useRunningOnPc';
import { useStopOnPc } from './useStopOnPc';
import { Icon, useAppTheme, withAlpha } from '../../theme';

/**
 * Outer gate — returns null unless a terminal session is live for this chat.
 * The mutation-bearing body ({@link RunningOnPcBannerBody}, which calls
 * `useStopOnPc` → `useMutation`) is mounted ONLY when the banner shows, so a
 * screen that renders ActiveChatScreen without an ApiProvider/QueryClient (some
 * unit tests) never trips those hooks — the badge/banner degrade to null,
 * mirroring `useOptionalSocket`.
 */
export function RunningOnPcBanner({ chatId }: { chatId: string }) {
  const { onPc, runningOnPc } = useRunningOnPc(chatId);
  if (!onPc) return null;
  return <RunningOnPcBannerBody chatId={chatId} runningOnPc={runningOnPc} />;
}

function RunningOnPcBannerBody({ chatId, runningOnPc }: { chatId: string; runningOnPc: boolean }) {
  const { theme } = useAppTheme();
  const stop = useStopOnPc(chatId);
  const [notice, setNotice] = useState<string | null>(null);

  const onStop = () => {
    setNotice(null);
    stop.mutate(
      { mode: 'end' },
      {
        onSuccess: (res) => {
          // On a confirmed stop the presence badge clears via the next
          // runtime snapshot; tell the user their send now continues here.
          setNotice(
            res.stopped
              ? 'Stopped on PC — your next message continues here.'
              : "Couldn't confirm the stop — your next message will fork a copy."
          );
        },
        onError: () => setNotice("Couldn't reach your PC to stop it."),
      }
    );
  };

  return (
    <View
      testID={`running-on-pc-banner-${chatId}`}
      style={[
        styles.banner,
        {
          backgroundColor: withAlpha(theme.colors.primary, '14'),
          borderColor: withAlpha(theme.colors.primary, '44'),
        },
      ]}
    >
      <View style={styles.row}>
        <Icon name="bolt" size={13} color={theme.colors.primary} />
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
          {runningOnPc
            ? 'This chat is running in a terminal on your PC.'
            : 'This chat is open in a terminal on your PC.'}
        </Text>
        <Pressable
          testID="stop-on-pc"
          accessibilityRole="button"
          accessibilityLabel="Stop on PC"
          disabled={stop.isPending}
          onPress={onStop}
          hitSlop={8}
          style={[
            styles.stopButton,
            { borderColor: theme.colors.danger, opacity: stop.isPending ? 0.5 : 1 },
          ]}
        >
          {stop.isPending ? (
            <ActivityIndicator size="small" color={theme.colors.danger} />
          ) : (
            <>
              <Icon name="stop" size={11} color={theme.colors.danger} />
              <Text style={[styles.stopText, { color: theme.colors.danger }]}>Stop on PC</Text>
            </>
          )}
        </Pressable>
      </View>
      {notice ? (
        <Text
          testID="stop-on-pc-notice"
          style={[styles.notice, { color: theme.colors.textSecondary }]}
        >
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 8,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 12, fontWeight: '500' },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    minWidth: 84,
    justifyContent: 'center',
  },
  stopText: { fontSize: 12, fontWeight: '600' },
  notice: { fontSize: 11 },
});
