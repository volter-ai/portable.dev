/**
 * InputActionButton — the unified trailing send↔voice button shared by both composers.
 *
 * One 44×44 press target whose PRIMARY action is `send` or `voice` (the parent owns the
 * mode; voice is TRANSIENT — holding switches to voice, and the parent auto-reverts to send
 * once a dictation completes). The non-primary action rides as a small overlay badge pinned
 * bottom-right, so the affordance to switch is always visible:
 *
 *   - `mode === 'send'`  → big paper-plane, small mic badge.   Tap = send.
 *   - `mode === 'voice'` → big mic, small paper-plane badge.   Tap = start dictation.
 *
 * LONG-PRESS toggles the primary mode (send↔voice) — the user's "holding the send button
 * switches it to a voice button … and another long-press switches them back". The badge
 * is purely visual (non-interactive): the whole button is ONE press target, exactly as
 * described. Reused by the home {@link ChatComposer} and active-chat {@link FollowUpComposer}
 * so the two never drift (the composer-kit pattern).
 */

import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, useAppTheme } from '../../../theme';

export interface InputActionButtonProps {
  /** The primary action the button performs on a tap. */
  mode: 'send' | 'voice';
  /** Whether a send is currently allowed (gates the send press + dims the glyph). */
  canSend: boolean;
  /** Hard-disable the button (e.g. an upload in flight). */
  disabled?: boolean;
  /** Show the small secondary-action badge bottom-right (off in the empty state). */
  showBadge?: boolean;
  /** Perform the send. */
  onSend: () => void;
  /** Begin voice dictation. */
  onStartVoice: () => void;
  /** Toggle the primary mode (long-press). Omit to disable the toggle (empty state). */
  onToggleMode?: () => void;
  /** testID when in send mode (kept as the legacy `*-send` id so contracts hold). */
  sendTestID: string;
  /** testID when in voice mode. */
  voiceTestID: string;
}

export function InputActionButton({
  mode,
  canSend,
  disabled = false,
  showBadge = true,
  onSend,
  onStartVoice,
  onToggleMode,
  sendTestID,
  voiceTestID,
}: InputActionButtonProps) {
  const { theme } = useAppTheme();

  const isSend = mode === 'send';
  // A send press is blocked unless a send is allowed; a voice press always fires.
  const pressBlocked = isSend ? !canSend || disabled : false;
  const primaryName = isSend ? 'paper-plane' : 'microphone';
  const badgeName = isSend ? 'microphone' : 'paper-plane';
  const primaryColor = isSend ? theme.colors.text : theme.colors.primary;

  return (
    <Pressable
      testID={isSend ? sendTestID : voiceTestID}
      accessibilityRole="button"
      accessibilityLabel={isSend ? 'Send message' : 'Start voice input'}
      accessibilityHint={
        onToggleMode
          ? isSend
            ? 'Long press to switch to voice input'
            : 'Long press to switch to send'
          : undefined
      }
      accessibilityState={{ disabled: pressBlocked }}
      style={[styles.button, { opacity: pressBlocked ? 0.5 : 1 }]}
      disabled={pressBlocked}
      onPress={() => (isSend ? onSend() : onStartVoice())}
      onLongPress={onToggleMode}
      delayLongPress={250}
    >
      <Icon name={primaryName} size={20} color={primaryColor} />
      {showBadge ? (
        <View
          testID={`${isSend ? sendTestID : voiceTestID}-badge`}
          pointerEvents="none"
          style={[
            styles.badge,
            { backgroundColor: theme.colors.surfaceHover, borderColor: theme.colors.borderLight },
          ]}
        >
          <Icon name={badgeName} size={10} color={theme.colors.textSecondary} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The small secondary-action chip, pinned bottom-right (a visual hint of the toggle).
  badge: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
