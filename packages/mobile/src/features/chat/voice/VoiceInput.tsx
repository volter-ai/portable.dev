/**
 * VoiceInput — the mic button + dictation surface (local-first voice input).
 *
 * Composes the native on-device speech recognizer ({@link useNativeSpeechRecognizer},
 * backed by `expo-speech-recognition`) with the dictation ViewModel
 * ({@link useNativeDictation}). Speech→text happens entirely ON the phone (no server
 * round-trip); on stop it calls `onTranscription(text)` with the recognized transcript
 * and the parent (e.g. {@link ChatComposer}) inserts it.
 *
 * States: idle (mic button) → recording (a FULL-WIDTH column: the live transcription
 * panel on top with interim text trailing in "…", the cancel / waveform / stop controls
 * row below) → transcribing (live text grayed + spinner while the trailing segment is
 * corrected). The parent observes `onPhaseChange` to hide its TextInput while the surface
 * is active. The recognizer/normalize seams are injectable so tests drive the flow with
 * no native module and the HTTP layer mocked.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNativeSpeechRecognizer, type NativeSpeechRecognizer } from './nativeSpeechRecognizer';
import { useNativeDictation, type VoicePhase } from './useNativeDictation';
import { VoiceSettingsModal } from './VoiceSettingsModal';
import { Waveform } from './Waveform';
import { Icon, useAppTheme, withAlpha } from '../../../theme';

export interface VoiceInputProps {
  /** Receives the transcribed text — the parent inserts it into its input. */
  onTranscription: (text: string) => void;
  /** Mic permission denied (parent may surface a settings prompt). */
  onPermissionDenied?: () => void;
  /** Recognition/normalization error. */
  onError?: (error: unknown) => void;
  /**
   * Observes the voice phase — parents hide their TextInput while the surface is
   * active (`phase !== 'idle'`) so the recording column spans the input card.
   */
  onPhaseChange?: (phase: VoicePhase) => void;
  /**
   * Override the recognizer hook (default: `useNativeSpeechRecognizer`). Tests that
   * don't mock `expo-speech-recognition` inject a fake here.
   */
  useRecognizer?: () => {
    recognizer: NativeSpeechRecognizer;
    level: number;
    /**
     * True when an on-device strategy fell back to the platform's servers (no on-device
     * model) — VoiceInput shows a "using cloud" note. Optional / back-compat (injected
     * fakes may omit it).
     */
    onDeviceFallback?: boolean;
  };
  /**
   * Render the built-in idle mic button (default `true`, back-compat). When `false` the
   * component renders NOTHING while `phase === 'idle'` — the parent owns the trailing-slot
   * UI (the {@link InputActionButton}) and drives recording imperatively via the ref's
   * {@link VoiceInputHandle.start}. The full recording/transcribing surface still renders.
   */
  renderIdleControl?: boolean;
  /**
   * The composer's CURRENT text. The recording surface REPLACES the text field, so without
   * this the user loses sight of what they're adding to; it's shown DIMMED as a prefix ahead
   * of the live transcription (matching the `current + ' ' + transcript` append). Optional /
   * back-compat — empty/undefined renders no prefix.
   */
  existingText?: string;
}

/**
 * Imperative handle so a parent can start/cancel dictation from a long-press or the
 * voice-primary tap (the `FollowUpComposerHandle.insertText` forwardRef precedent).
 */
export interface VoiceInputHandle {
  /** Request permission then begin on-device recognition. */
  start: () => void;
  /** Discard the in-progress dictation without inserting. */
  cancel: () => void;
}

export const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput(
  {
    onTranscription,
    onPermissionDenied,
    // Default surfaces failures in the Metro/device logs — composers don't pass a handler,
    // and a silently-swallowed start() error reads as a dead mic button.
    onError = (error) => console.warn('[VoiceInput] recognition error', error),
    onPhaseChange,
    useRecognizer = useNativeSpeechRecognizer,
    renderIdleControl = true,
    existingText,
  },
  ref
) {
  const { recognizer, level, onDeviceFallback } = useRecognizer();
  // The text the dictation will be appended to — shown dimmed ahead of the live transcript.
  const existingPrefix = (existingText ?? '').trim();

  const voice = useNativeDictation({
    recognizer,
    onTranscription,
    onPermissionDenied,
    onError,
  });
  const { theme } = useAppTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    onPhaseChange?.(voice.phase);
  }, [voice.phase, onPhaseChange]);

  useImperativeHandle(
    ref,
    () => ({
      start: () => void voice.start(),
      cancel: () => void voice.cancel(),
    }),
    [voice]
  );

  const liveScrollRef = useRef<ScrollView | null>(null);

  // The cog (in the recording controls) cancels the in-progress dictation and opens the
  // voice-settings modal (strategy + custom phrases).
  const openSettings = () => {
    void voice.cancel();
    setSettingsOpen(true);
  };

  let surface;
  if (voice.isTranscribing) {
    surface = (
      <View style={styles.surface} testID="voice-input-transcribing">
        {voice.liveText || existingPrefix ? (
          <Text style={styles.liveText}>
            {existingPrefix ? (
              <Text style={{ color: theme.colors.textTertiary }}>{existingPrefix} </Text>
            ) : null}
            {voice.liveText ? (
              <Text testID="voice-live-text" style={{ color: theme.colors.textSecondary }}>
                {voice.liveText}
              </Text>
            ) : null}
          </Text>
        ) : null}
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>
            Transcribing…
          </Text>
        </View>
      </View>
    );
  } else if (voice.isRecording) {
    // Live transcription on top, the controls row below.
    surface = (
      <View style={styles.surface} testID="voice-input-recording">
        <ScrollView
          ref={liveScrollRef}
          style={styles.livePanel}
          contentContainerStyle={styles.livePanelContent}
          onContentSizeChange={() => liveScrollRef.current?.scrollToEnd({ animated: true })}
          testID="voice-live-panel"
        >
          <Text style={styles.liveText}>
            {existingPrefix ? (
              <Text testID="voice-existing-text" style={{ color: theme.colors.textTertiary }}>
                {existingPrefix}{' '}
              </Text>
            ) : null}
            {voice.liveText ? (
              <Text testID="voice-live-text" style={{ color: theme.colors.text }}>
                {voice.liveText}
              </Text>
            ) : (
              <Text testID="voice-live-placeholder" style={{ color: theme.colors.textTertiary }}>
                {existingPrefix ? '…' : 'Listening…'}
              </Text>
            )}
          </Text>
        </ScrollView>

        {onDeviceFallback ? (
          <Text
            testID="voice-cloud-fallback-note"
            style={[styles.fallbackNote, { color: theme.colors.warning }]}
          >
            On-device transcription unavailable — using cloud (audio leaves your device).
          </Text>
        ) : null}

        <View style={styles.controlsRow}>
          <Pressable
            testID="voice-input-cancel"
            accessibilityLabel="Cancel recording"
            style={[styles.iconButton, { backgroundColor: theme.colors.surfaceHover }]}
            onPress={() => void voice.cancel()}
          >
            <Icon name="xmark" size={18} color={theme.colors.textSecondary} />
          </Pressable>

          <Pressable
            testID="voice-input-settings"
            accessibilityLabel="Voice settings"
            style={[styles.iconButton, { backgroundColor: theme.colors.surfaceHover }]}
            onPress={openSettings}
          >
            <Icon name="gear" size={18} color={theme.colors.textSecondary} />
          </Pressable>

          <View style={styles.waveformSlot}>
            <Waveform level={level} />
          </View>

          <Pressable
            testID="voice-input-stop"
            accessibilityLabel="Stop recording"
            style={[styles.iconButton, { backgroundColor: withAlpha(theme.colors.error, '22') }]}
            onPress={() => void voice.stop()}
          >
            <View style={[styles.stopGlyph, { backgroundColor: theme.colors.error }]} />
          </Pressable>
        </View>
      </View>
    );
  } else if (renderIdleControl) {
    surface = (
      <Pressable
        testID="voice-input-mic"
        accessibilityLabel="Record voice message"
        style={[styles.iconButton, { backgroundColor: theme.colors.surfaceHover }]}
        onPress={() => void voice.start()}
      >
        <Icon name="microphone" size={20} color={theme.colors.primary} />
      </Pressable>
    );
  } else {
    // Headless idle: the parent owns the trailing-slot button + drives start() via the ref.
    surface = null;
  }

  return (
    <>
      {surface}
      {settingsOpen ? <VoiceSettingsModal visible onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
});

const styles = StyleSheet.create({
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The active (recording/transcribing) surface spans the whole input row — the parent
  // hides its TextInput while the phase is non-idle.
  surface: {
    flex: 1,
    gap: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  livePanel: {
    maxHeight: 120,
    minHeight: 36,
  },
  livePanelContent: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  liveText: { fontSize: 16, lineHeight: 22 },
  fallbackNote: { fontSize: 11, lineHeight: 15, paddingHorizontal: 4 },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  waveformSlot: { flex: 1 },
  stopGlyph: { width: 16, height: 16, borderRadius: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8 },
  statusText: { fontSize: 14 },
});
