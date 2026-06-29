/**
 * Voice input feature (local-first). Speech→text runs entirely ON-DEVICE (native STT
 * via `expo-speech-recognition` — the on-device dictation model + contextual biasing);
 * the recognized transcript is inserted directly, no server round-trip. Public surface
 * for the chat composers and tests.
 */

export {
  useNativeSpeechRecognizer,
  volumeToLevel,
  resolveStartOptions,
  shouldAutoRestart,
  VOICE_CONTEXTUAL_STRINGS,
  type NativeSpeechRecognizer,
  type SpeechRecognizerCallbacks,
  type SpeechResult,
  type PlatformOS,
} from './nativeSpeechRecognizer';
export {
  useNativeDictation,
  type NativeDictation,
  type UseNativeDictationDeps,
  type VoicePhase,
} from './useNativeDictation';
export { Waveform, type WaveformProps } from './Waveform';
export { VoiceInput, type VoiceInputProps, type VoiceInputHandle } from './VoiceInput';
export { VoiceSettingsModal, type VoiceSettingsModalProps } from './VoiceSettingsModal';
export {
  VOICE_STRATEGIES,
  VOICE_STRATEGY_ORDER,
  DEFAULT_VOICE_STRATEGY,
  getDefaultVoiceStrategy,
  resolveVoiceStrategy,
  type VoiceStrategyId,
  type VoiceStrategyDef,
} from './voiceStrategies';
export { useVoiceSettingsStore, VOICE_SETTINGS_PERSIST_KEY } from './voiceSettingsStore';
export {
  VOICE_LANGUAGES,
  DEFAULT_VOICE_LANGUAGE,
  resolveVoiceLanguage,
  getVoiceLanguageLabel,
  type VoiceLanguage,
} from './voiceLanguages';
