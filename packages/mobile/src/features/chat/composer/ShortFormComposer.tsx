/**
 * ShortFormComposer — the ONE shared short-form "start a chat / work on this" input row.
 *
 * Encapsulates the previously-duplicated block (home {@link ChatComposer}, active-chat
 * {@link FollowUpComposer}, and the repo {@link OverviewTab} "Work on …" input):
 *
 *   - a controlled TextInput (hidden while the voice surface is active),
 *   - the unified trailing {@link InputActionButton}: a microphone while the input is
 *     EMPTY, switching to the holdable Send widget once the user types (long-press
 *     toggles send↔voice), and
 *   - the headless {@link VoiceInput} dictation surface (renderIdleControl=false) that the
 *     trailing button drives imperatively; the recognized transcript is appended to `value`.
 *
 * Voice is TRANSIENT: holding Send switches the slot to Voice; once a dictation completes
 * (phase returns to idle) the slot auto-reverts to Send (the effect below), so the next tap
 * sends — hold again to add more. This component owns ONLY that transient send/voice/phase
 * state; everything else (the card chrome, framework pills, control row, slash picker,
 * attachment bar, Stop button) stays with the caller, which wraps this in its own row/card.
 *
 * Styling is deliberately neutral: the caller supplies the surrounding card and the row
 * container — this component renders the input + button + voice surface as direct children
 * of the caller's row (so flex layout / alignment is the caller's to set).
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type StyleProp, StyleSheet, Text, TextInput, type TextStyle, View } from 'react-native';

import { InputActionButton } from './InputActionButton';
import { VoiceInput, type VoiceInputHandle, type VoicePhase } from '../voice';

import { useAppTheme } from '../../../theme';

export interface ShortFormComposerProps {
  /** Controlled input value. */
  value: string;
  /** Input change handler — also used to append voice transcriptions. */
  onChangeText: (text: string) => void;
  /** Perform the send (tapping Send / the keyboard return key). */
  onSubmit: () => void;
  /** Whether a send is currently allowed (gates the Send press + dims the glyph). */
  canSend: boolean;
  /** Placeholder shown in the (empty) text field. */
  placeholder: string;
  /** Hard-disable the trailing button (e.g. an upload in flight). */
  disabled?: boolean;
  /** Multiline (home/active-chat) vs single line (repo overview). Default `false`. */
  multiline?: boolean;
  /** Imperative TextInput ref (focus after picking a slash command, etc.). */
  inputRef?: React.RefObject<TextInput | null>;
  /** Extra TextInput style merged over the neutral base. */
  inputStyle?: StyleProp<TextStyle>;
  /**
   * Inline grey "ghost" text rendered immediately AFTER the typed value — the
   * `argument-hint` autofill (e.g. value `/deploy ` → grey `[env] [tag]`), matching
   * Claude Code's greyed argument hint. Empty/undefined = no overlay. The caller
   * computes it from the recognized command's `argumentHint`.
   */
  ghostText?: string;
  /** Focus passthrough — callers expand their chrome on focus. */
  onFocus?: () => void;
  /** Blur passthrough. */
  onBlur?: () => void;
  /**
   * Optional content rendered BEFORE the text field (only while NOT recording) — the
   * home composer's inline attachment "+". The caller decides what (if anything) to show.
   */
  leading?: ReactNode;
  /**
   * Observes whether the voice surface is active (recording/transcribing). Callers use
   * this to hide their own around-the-input chrome (e.g. the inline attach button) while
   * the recording column spans the row.
   */
  onVoiceActiveChange?: (active: boolean) => void;
  /** testIDs (preserved per call-site so existing contracts hold). */
  inputTestID: string;
  sendTestID: string;
  voiceTestID: string;
}

export function ShortFormComposer({
  value,
  onChangeText,
  onSubmit,
  canSend,
  placeholder,
  disabled = false,
  multiline = false,
  inputRef,
  inputStyle,
  ghostText,
  onFocus,
  onBlur,
  leading,
  onVoiceActiveChange,
  inputTestID,
  sendTestID,
  voiceTestID,
}: ShortFormComposerProps) {
  const { theme } = useAppTheme();
  // The headless dictation surface — the trailing InputActionButton drives it via this ref.
  const voiceRef = useRef<VoiceInputHandle>(null);
  // The trailing button's primary action. Voice is TRANSIENT (see the file header).
  const [primaryMode, setPrimaryMode] = useState<'send' | 'voice'>('send');
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  // Measured pixel width of the typed `value` (in the field's font), so the grey ghost
  // hint can be absolutely positioned RIGHT AFTER it. We measure off-screen instead of
  // overlaying a "transparent" copy of the text because zero-alpha Text colors are NOT
  // honored on this Android Fabric build (they fell back to the default color → the typed
  // text printed twice). A real measured offset has no such dependency.
  const [ghostValueWidth, setGhostValueWidth] = useState<number | null>(null);
  const togglePrimaryMode = () => setPrimaryMode((m) => (m === 'send' ? 'voice' : 'send'));

  const hasText = value.trim().length > 0;
  const voiceActive = voicePhase !== 'idle';

  // Voice is transient: when a dictation session ends (phase returns to idle) revert the
  // primary action to send. Toggling primaryMode doesn't change voicePhase, so this never
  // fights the long-press toggle — it only fires on a real record→stop/cancel transition.
  useEffect(() => {
    if (voicePhase === 'idle') setPrimaryMode('send');
  }, [voicePhase]);

  // Surface the active/idle voice state so callers can hide their own chrome while recording.
  useEffect(() => {
    onVoiceActiveChange?.(voiceActive);
  }, [voiceActive, onVoiceActiveChange]);

  const insertTranscription = (transcribed: string) => {
    const current = value.trim();
    onChangeText(current ? `${current} ${transcribed}` : transcribed);
  };

  return (
    <>
      {voiceActive ? null : leading}

      {voiceActive ? null : (
        // The input is wrapped so the ghost-text overlay can absolutely-fill the SAME
        // box as the field (same font/padding) and render the grey argument hint right
        // after the typed value. The wrapper preserves the original flex semantics
        // (`flexDirection:'row'` + the field's `flex:1` = horizontal fill in the caller
        // row); it is ALWAYS present (never conditional on `ghostText`) so the TextInput
        // never remounts / loses focus as the hint appears and disappears.
        <View style={styles.inputWrap}>
          {ghostText ? (
            // Overlay View shares the field's padding (via inputStyle) so its children
            // are positioned from the same content origin as the typed text. NO visible
            // copy of `value` — only an OFF-SCREEN measurer + the grey hint placed at the
            // measured width. pointerEvents none so taps reach the field beneath.
            <View
              style={[
                styles.ghostOverlay,
                inputStyle,
                // Match the field's vertical text alignment: a single-line TextInput
                // CENTERS its text, a multiline one TOPs it (textAlignVertical:'top').
                // The hint is an in-flow row child, so alignItems aligns it to the typed
                // text — fixing the "superscript" float.
                { flexDirection: 'row', alignItems: multiline ? 'flex-start' : 'center' },
              ]}
              pointerEvents="none"
            >
              {/* Off-screen measurer (out of flow) → the pure typed-text width. */}
              <Text
                testID={`${inputTestID}-ghost-measure`}
                style={[inputStyle, styles.ghostSpacer]}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  setGhostValueWidth((prev) => (prev !== w ? w : prev));
                }}
              >
                {value}
              </Text>
              {ghostValueWidth != null ? (
                <>
                  {/* Invisible width-only spacer (an EMPTY View — no text, so nothing to
                      render in the default color) reserving the typed text's width. */}
                  <View style={{ width: ghostValueWidth }} />
                  <Text
                    testID={`${inputTestID}-ghost`}
                    numberOfLines={1}
                    style={[inputStyle, styles.ghostHint, { color: theme.colors.textTertiary }]}
                  >
                    {ghostText}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
          <TextInput
            ref={inputRef}
            testID={inputTestID}
            style={[styles.input, styles.inputField, { color: theme.colors.text }, inputStyle]}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.textTertiary}
            value={value}
            onChangeText={onChangeText}
            onFocus={onFocus}
            onBlur={onBlur}
            onSubmitEditing={onSubmit}
            returnKeyType="send"
            multiline={multiline}
          />
        </View>
      )}

      {/* Trailing action: send↔voice button (idle/text), or nothing while recording
          (the headless VoiceInput surface below takes over the row). */}
      {voiceActive ? null : (
        <InputActionButton
          mode={hasText ? primaryMode : 'voice'}
          canSend={canSend}
          disabled={disabled}
          showBadge={hasText}
          sendTestID={sendTestID}
          voiceTestID={voiceTestID}
          onSend={onSubmit}
          onStartVoice={() => voiceRef.current?.start()}
          onToggleMode={hasText ? togglePrimaryMode : undefined}
        />
      )}

      {/* Headless dictation surface — null while idle, the full-width recording/
          transcribing column while active. */}
      <VoiceInput
        ref={voiceRef}
        renderIdleControl={false}
        existingText={value}
        onPhaseChange={setVoicePhase}
        onTranscription={insertTranscription}
      />
    </>
  );
}

const styles = StyleSheet.create({
  // Neutral input base — callers add color/size via `inputStyle`. `flex:1` so the field
  // fills the caller's row beside the trailing button.
  input: {
    flex: 1,
  },
  // Wraps the field + ghost overlay; `flexDirection:'row'` keeps the field's `flex:1` a
  // HORIZONTAL fill (identical to the pre-wrap layout), and the wrapper itself fills the
  // caller's row slot.
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
  },
  // Drop the extra Android font padding so the field's glyph baseline matches the ghost
  // overlay's (both set it → the hint aligns with the typed text on Android).
  inputField: {
    includeFontPadding: false,
  },
  // The ghost overlay fills the same box as the field (+ the field's padding via
  // inputStyle in the JSX) so its children share the typed text's content origin.
  ghostOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Off-screen measurer: the field's font (inherited from inputStyle) with padding
  // stripped, so `onLayout` reports the PURE typed-text width. Never visible.
  ghostSpacer: {
    position: 'absolute',
    top: -9999,
    left: 0,
    // Most-specific padding keys → override any padding form in inputStyle, so the
    // measured width is the pure text width (the View supplies the padding offset).
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    includeFontPadding: false,
  },
  // The grey hint — an IN-FLOW row child after the width spacer, so the row's
  // alignItems aligns it vertically with the field's text (no manual top offset).
  ghostHint: {
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    includeFontPadding: false,
  },
});
