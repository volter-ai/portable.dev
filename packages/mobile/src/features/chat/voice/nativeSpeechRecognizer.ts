/**
 * Native on-device speech recognizer (local-first voice input).
 *
 * Speech→text runs on the PHONE'S OWN speech engine (iOS `SFSpeechRecognizer` /
 * Android `SpeechRecognizer`) via `expo-speech-recognition` — free, private, no audio
 * leaves the device, no Whisper. The recognizer emits INTERIM results continuously
 * (the live "…" buffer) plus a FINAL result per utterance; the {@link useNativeDictation}
 * ViewModel sends each finalized segment to the PC for the domain-correction pass.
 *
 * `expo-speech-recognition` is a NATIVE module, so it is **lazy-`require`d inside the
 * functions** (the `pushAdapter.ts` pattern) — importing this file (or the
 * chat barrel that transitively reaches it) never pulls the native module into the
 * Jest/Metro graph. Tests inject a fake {@link NativeSpeechRecognizer} instead.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { useVoicePhrases } from '../../api/hooks';
import { DEFAULT_VOICE_LANGUAGE, resolveVoiceLanguage } from './voiceLanguages';
import { useVoiceSettingsStore } from './voiceSettingsStore';
import { resolveVoiceStrategy, type VoiceStrategyDef } from './voiceStrategies';

/** A recognition result — `transcript` is the best hypothesis so far. */
export interface SpeechResult {
  transcript: string;
  /** True once the engine has FINALIZED this utterance (a committable segment). */
  isFinal: boolean;
}

/** Callbacks the ViewModel registers for the duration of a recognition session. */
export interface SpeechRecognizerCallbacks {
  onResult: (result: SpeechResult) => void;
  /** Live input level, 0..1 (drives the waveform). */
  onVolume?: (level: number) => void;
  onError?: (error: unknown) => void;
  /**
   * Fires at EACH utterance boundary (every `end` event), BEFORE any auto-restart — so the
   * consumer can FINALIZE the in-progress text. This is what makes pausing safe: the engine
   * (continuous:false) ends a segment on a pause, and the next session's partials would
   * otherwise overwrite the pending buffer; flushing here commits the segment first.
   */
  onUtteranceEnd?: () => void;
  /** The engine fully stopped (terminal — manual stop, or the silent-restart cap). */
  onEnd?: () => void;
}

/** Framework-free recognizer contract (production = expo-speech-recognition; tests = fake). */
export interface NativeSpeechRecognizer {
  /** Request microphone + speech-recognition permission. Resolves `true` when granted. */
  requestPermission(): Promise<boolean>;
  /** Begin continuous on-device recognition, streaming results to `callbacks`. */
  start(callbacks: SpeechRecognizerCallbacks): Promise<void>;
  /** Stop gracefully (engine flushes a final result). */
  stop(): Promise<void>;
  /** Abort, discarding the in-progress utterance. */
  abort(): Promise<void>;
}

/**
 * Normalize an `expo-speech-recognition` `volumechange` value (roughly `-2`..`10`,
 * where `0` is normal speaking volume) to a `0..1` waveform level.
 */
export function volumeToLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const level = (value + 2) / 12; // -2 → 0, 10 → 1
  return Math.max(0, Math.min(1, level));
}

/**
 * Project/tech vocabulary fed to the recognizer as `contextualStrings` to bias it
 * toward terms it would otherwise mangle. (Best-effort hint — improves domain-word
 * accuracy at the SOURCE, before the server-side correction pass.)
 */
export const VOICE_CONTEXTUAL_STRINGS = [
  'Portable',
  'Claude',
  'Anthropic',
  'Redis',
  'Postgres',
  'SQLite',
  'Playwright',
  'TypeScript',
  'JavaScript',
  'Python',
  'Docker',
  'Kubernetes',
  'GraphQL',
  'GitHub',
  'OAuth',
  'JWT',
  'Expo',
  'React Native',
  'Metro',
  'Bun',
  'Vite',
  'Next.js',
  'Tailwind',
  'webhook',
  'endpoint',
  'repo',
  'commit',
  'rebase',
  'middleware',
];

interface ExpoSpeechSubscription {
  remove(): void;
}

/**
 * Production recognizer hook. Returns the imperative {@link NativeSpeechRecognizer}
 * plus the live `level` (0..1) for the waveform. The native module is loaded lazily on
 * first use; listener subscriptions are torn down on stop/abort/unmount.
 */
/**
 * Stop auto-restarting after this many CONSECUTIVE no-speech sessions (a runaway
 * guard — resets the moment any speech is recognized). During real dictation the user
 * taps stop; this just bounds the idle restart/beep loop if they walk away.
 */
const MAX_SILENT_RESTARTS = 8;
/** Pause (ms) the on-device dictation model tolerates before ending a segment — long so
 * a natural mid-sentence pause doesn't end+restart (which beeps on Android). */
const SILENCE_TOLERANCE_MS = 2500;

/** The platform identifier (`Platform.OS`) — narrowed for the pure helpers below. */
export type PlatformOS = typeof Platform.OS;

/**
 * Build the `expo-speech-recognition` start payload for a strategy, PER-PLATFORM (pure, so the
 * per-platform divergence is unit-testable without the native module). The mid-sentence
 * silence tuning (`androidIntentOptions` `EXTRA_SPEECH_INPUT_*`) is ANDROID-ONLY — iOS ignores
 * it (its end-of-speech timing is fixed by SFSpeechRecognizer), so it is OMITTED on iOS to keep
 * the payload honest. Everything else (lang / interimResults / continuous / requiresOnDevice /
 * addsPunctuation / contextualStrings / iosTaskHint / volume metering) is shared and
 * iOS-supported.
 */
export function resolveStartOptions(
  strategy: VoiceStrategyDef,
  phrases: string[],
  platformOS: PlatformOS,
  silenceToleranceMs: number,
  languageTag: string = DEFAULT_VOICE_LANGUAGE
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    lang: languageTag,
    interimResults: true,
    continuous: strategy.continuous,
    requiresOnDeviceRecognition: strategy.onDevice,
    addsPunctuation: true,
    contextualStrings: phrases,
    iosTaskHint: 'dictation',
    volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
  };
  if (platformOS === 'android') {
    // Tolerate long mid-sentence pauses so a segment doesn't end+restart (beep) early.
    options.androidIntentOptions = {
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: silenceToleranceMs,
      EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: silenceToleranceMs,
    };
  }
  return options;
}

/**
 * Decide whether to re-arm recognition after an `end` event (pure). iOS NEVER auto-restarts:
 * re-`start()`ing synchronously inside the `end` handler reactivates the AVAudioSession with a
 * capture gap that drops words and frequently throws — killing the mic after the first phrase
 * (the Android-first bug observed on iOS). iOS relies on its OWN session lifecycle instead
 * (`continuous:true` keeps it alive; `continuous:false` ends on Apple's own timer). On Android
 * the loop re-arms for the next utterance until the user stops, bounded by the silent guard.
 */
export function shouldAutoRestart(opts: {
  manualStop: boolean;
  autoRestart: boolean;
  platformOS: PlatformOS;
  silentRestarts: number;
  maxSilentRestarts: number;
}): boolean {
  if (opts.manualStop) return false;
  if (opts.platformOS === 'ios') return false;
  if (!opts.autoRestart) return false;
  if (opts.silentRestarts >= opts.maxSilentRestarts) return false;
  return true;
}

export function useNativeSpeechRecognizer(): {
  recognizer: NativeSpeechRecognizer;
  level: number;
  /** True for the active session when an on-device strategy fell back to the platform's
   * servers (no on-device model) — the UI surfaces that audio is leaving the device. */
  onDeviceFallback: boolean;
} {
  const [level, setLevel] = useState(0);
  const [onDeviceFallback, setOnDeviceFallback] = useState(false);
  const subsRef = useRef<ExpoSpeechSubscription[]>([]);
  const moduleRef = useRef<any>(null);
  const manualStopRef = useRef(false);
  const silentRestartsRef = useRef(0);

  // The active strategy (per-device preference) + the custom biasing phrases (fetched from
  // the PC, cached). Read at start() time via refs updated each render, so changing the
  // strategy/phrases in the settings modal applies to the NEXT recording without rebuilding
  // the memoized recognizer.
  const strategyId = useVoiceSettingsStore((s) => s.strategyId);
  const phrasesData = useVoicePhrases();
  const strategyRef = useRef<VoiceStrategyDef>(resolveVoiceStrategy(strategyId));
  strategyRef.current = resolveVoiceStrategy(strategyId);
  const languageTag = useVoiceSettingsStore((s) => s.languageTag);
  const languageRef = useRef<string>(resolveVoiceLanguage(languageTag));
  languageRef.current = resolveVoiceLanguage(languageTag);
  const phrasesRef = useRef<string[]>(VOICE_CONTEXTUAL_STRINGS);
  phrasesRef.current = phrasesData.data?.phrases?.length
    ? phrasesData.data.phrases
    : VOICE_CONTEXTUAL_STRINGS;

  const getModule = (): any => {
    if (!moduleRef.current) {
      // Lazy require — keeps the native module out of any Jest/Metro graph that
      // never reaches a real recording (the chat barrel re-exports VoiceInput).
      moduleRef.current = require('expo-speech-recognition').ExpoSpeechRecognitionModule;
    }
    return moduleRef.current;
  };

  const cleanup = useCallback(() => {
    for (const sub of subsRef.current) {
      try {
        sub.remove();
      } catch {
        // best-effort
      }
    }
    subsRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const recognizer = useMemo<NativeSpeechRecognizer>(() => {
    return {
      async requestPermission() {
        const res = await getModule().requestPermissionsAsync();
        return !!res?.granted;
      },
      async start(callbacks) {
        const mod = getModule();
        cleanup();
        manualStopRef.current = false;
        silentRestartsRef.current = 0;
        // Privacy transparency: an on-device strategy SILENTLY falls back to the platform's
        // servers (Apple on iOS, Google on Android) when the device/locale has no on-device
        // model — the native lib only honors requiresOnDeviceRecognition when
        // supportsOnDeviceRecognition() is true. Surface it so the UI can warn the user that
        // audio is leaving the device.
        let fellBack = false;
        if (strategyRef.current.onDevice) {
          try {
            fellBack =
              typeof mod.supportsOnDeviceRecognition === 'function'
                ? !mod.supportsOnDeviceRecognition()
                : false;
          } catch {
            fellBack = false; // best-effort — assume on-device available
          }
        }
        setOnDeviceFallback(fellBack);
        subsRef.current.push(
          mod.addListener('result', (e: any) => {
            const transcript: string = e?.results?.[0]?.transcript ?? '';
            if (transcript) silentRestartsRef.current = 0; // got speech → reset the guard
            callbacks.onResult({ transcript, isFinal: !!e?.isFinal });
          }),
          mod.addListener('volumechange', (e: any) => {
            const lvl = volumeToLevel(typeof e?.value === 'number' ? e.value : -2);
            setLevel(lvl);
            callbacks.onVolume?.(lvl);
          }),
          mod.addListener('error', (e: any) => callbacks.onError?.(e)),
          // ANDROID dictation re-arms after each utterance (bounded by the silent guard);
          // iOS NEVER restarts (shouldAutoRestart) — re-start()ing mid-session reactivates the
          // AVAudioSession and kills the mic. continuous/cloud end only on stop/error.
          mod.addListener('end', () => {
            // FINALIZE the just-finished utterance BEFORE any restart — so a pause (which
            // ends the segment) doesn't lose its text to the next session's partials.
            callbacks.onUtteranceEnd?.();
            const restart = shouldAutoRestart({
              manualStop: manualStopRef.current,
              autoRestart: strategyRef.current.autoRestart,
              platformOS: Platform.OS,
              silentRestarts: silentRestartsRef.current,
              maxSilentRestarts: MAX_SILENT_RESTARTS,
            });
            if (!restart) {
              callbacks.onEnd?.();
              return;
            }
            silentRestartsRef.current += 1;
            try {
              mod.start(
                resolveStartOptions(
                  strategyRef.current,
                  phrasesRef.current,
                  Platform.OS,
                  SILENCE_TOLERANCE_MS,
                  languageRef.current
                )
              );
            } catch (err) {
              callbacks.onError?.(err);
            }
          })
        );
        mod.start(
          resolveStartOptions(
            strategyRef.current,
            phrasesRef.current,
            Platform.OS,
            SILENCE_TOLERANCE_MS,
            languageRef.current
          )
        );
      },
      async stop() {
        manualStopRef.current = true;
        try {
          getModule().stop();
        } finally {
          cleanup();
          setLevel(0);
          setOnDeviceFallback(false);
        }
      },
      async abort() {
        manualStopRef.current = true;
        try {
          getModule().abort();
        } finally {
          cleanup();
          setLevel(0);
          setOnDeviceFallback(false);
        }
      },
    };
  }, [cleanup]);

  return { recognizer, level, onDeviceFallback };
}
