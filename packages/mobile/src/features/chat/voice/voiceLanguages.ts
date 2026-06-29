/**
 * Dictation languages offered in the voice-settings modal. The recognizer needs the right
 * `lang` BCP-47 tag or it forces foreign speech into the wrong language (e.g. Portuguese spoken
 * against `en-US` → garbled "strange words").
 *
 * ENGLISH (`en-US`) is the DEFAULT and is never removed — English dictation behaves EXACTLY as
 * before. Picking another tag only changes the `lang` passed to the recognizer for THIS device
 * (a per-device preference in {@link useVoiceSettingsStore}); it never affects another user.
 *
 * The list is a CURATED static set (NOT populated from `getSupportedLocales()`): a static list
 * can't fail/empty at runtime, so it can never break the English path. A device that lacks an
 * on-device model for the chosen locale falls back to the cloud (the existing
 * `voice-cloud-fallback-note`), or the picked locale is supported by the cloud recognizer.
 */

export interface VoiceLanguage {
  /** BCP-47 tag passed to `expo-speech-recognition` as `lang`. */
  tag: string;
  /** Native-name label shown in the picker. */
  label: string;
}

export const DEFAULT_VOICE_LANGUAGE = 'en-US';

export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'pt-PT', label: 'Português (Portugal)' },
  { tag: 'es-ES', label: 'Español (España)' },
  { tag: 'es-419', label: 'Español (Latinoamérica)' },
  { tag: 'fr-FR', label: 'Français' },
  { tag: 'de-DE', label: 'Deutsch' },
  { tag: 'it-IT', label: 'Italiano' },
  { tag: 'ja-JP', label: '日本語' },
  { tag: 'zh-CN', label: '中文 (简体)' },
];

/** Resolve a (possibly stale/unknown) tag to a supported one, defaulting to English. */
export function resolveVoiceLanguage(tag: string | undefined): string {
  return VOICE_LANGUAGES.some((l) => l.tag === tag) ? (tag as string) : DEFAULT_VOICE_LANGUAGE;
}

/** The native-name label for a tag (falls back to the raw tag). */
export function getVoiceLanguageLabel(tag: string): string {
  return VOICE_LANGUAGES.find((l) => l.tag === tag)?.label ?? tag;
}
