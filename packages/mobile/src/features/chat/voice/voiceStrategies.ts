/**
 * Voice recognition strategies — the privacy/behavior trade-offs the user picks from in
 * the voice-settings modal. Each maps to a set of `expo-speech-recognition` start options,
 * resolved PER-PLATFORM in `nativeSpeechRecognizer.ts` (`resolveStartOptions` /
 * `shouldAutoRestart`) — the start payload is NOT identical on iOS and Android.
 *
 *  - `dictation`: on-device, `continuous:false` — one utterance at a time. On ANDROID the
 *    auto-restart loop re-arms between utterances (tuned via `androidIntentOptions`); on iOS
 *    auto-restart is DISABLED (iOS manages its own session lifecycle, and re-`start()`ing
 *    synchronously reactivates the AVAudioSession with a capture gap that drops words).
 *  - `continuous`: on-device, `continuous:true` — keeps listening across pauses. The iOS
 *    default: it avoids the Android-only restart loop entirely.
 *  - `cloud`: `requiresOnDeviceRecognition:false` — most accurate on some devices, but audio
 *    is sent OFF-DEVICE (Apple on iOS, Google on Android), so it is NOT private.
 *
 * The DEFAULT is per-platform (`getDefaultVoiceStrategy`): iOS → `continuous`, Android →
 * `dictation`. On-device strategies silently fall back to the platform's servers when the
 * device/locale has no on-device model (the native lib only sets `requiresOnDeviceRecognition`
 * when `supportsOnDeviceRecognition()` is true) — the UI surfaces that fallback.
 */

import { Platform } from 'react-native';

export type VoiceStrategyId = 'dictation' | 'continuous' | 'cloud';

export interface VoiceStrategyDef {
  id: VoiceStrategyId;
  label: string;
  /** One-line trade-off shown under the option (privacy/accuracy). */
  description: string;
  /** True = on-device only (no audio leaves the phone). */
  onDevice: boolean;
  /** `expo-speech-recognition` `continuous` flag. */
  continuous: boolean;
  /** Re-arm recognition after each utterance ends (only meaningful for `continuous:false`). */
  autoRestart: boolean;
}

export const VOICE_STRATEGIES: Record<VoiceStrategyId, VoiceStrategyDef> = {
  dictation: {
    id: 'dictation',
    label: 'Dictation (on-device)',
    description: 'Best accuracy, stays on your device.',
    onDevice: true,
    continuous: false,
    autoRestart: true,
  },
  continuous: {
    id: 'continuous',
    label: 'Continuous (on-device)',
    description: 'Stays on your device, keeps listening across pauses.',
    onDevice: true,
    continuous: true,
    autoRestart: false,
  },
  cloud: {
    id: 'cloud',
    label: 'Cloud (most accurate)',
    description: 'Most accurate, but your audio is sent off-device for recognition.',
    onDevice: false,
    continuous: true,
    autoRestart: false,
  },
};

export const VOICE_STRATEGY_ORDER: VoiceStrategyId[] = ['dictation', 'continuous', 'cloud'];

/**
 * The per-platform default strategy. iOS → `continuous` (the robust on-device path that does
 * NOT depend on the Android-only auto-restart-on-`end` loop — that loop reactivates the iOS
 * AVAudioSession with a capture gap and kills the mic after the first phrase). Android →
 * `dictation` (per-utterance; verified on the Samsung test device). `platformOS` is
 * injectable so the choice is unit-testable without reloading the module.
 */
export function getDefaultVoiceStrategy(
  platformOS: typeof Platform.OS = Platform.OS
): VoiceStrategyId {
  return platformOS === 'ios' ? 'continuous' : 'dictation';
}

export const DEFAULT_VOICE_STRATEGY: VoiceStrategyId = getDefaultVoiceStrategy();

/** Resolve a (possibly stale/unknown) id to a concrete strategy, defaulting to the
 * per-platform {@link DEFAULT_VOICE_STRATEGY}. */
export function resolveVoiceStrategy(id: VoiceStrategyId | string | undefined): VoiceStrategyDef {
  return VOICE_STRATEGIES[id as VoiceStrategyId] ?? VOICE_STRATEGIES[DEFAULT_VOICE_STRATEGY];
}
