/**
 * voiceSettingsStore — the per-device voice recognition preference (which
 * {@link VoiceStrategyDef} to use). MMKV-persisted (the `usageTrackingStore` leaf-store
 * pattern) so the choice survives an app kill. The custom phrases live on the PC (server
 * metadata), NOT here — only the strategy is a device preference.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../../state/storage';
import { DEFAULT_VOICE_LANGUAGE } from './voiceLanguages';
import { DEFAULT_VOICE_STRATEGY, type VoiceStrategyId } from './voiceStrategies';

export const VOICE_SETTINGS_PERSIST_KEY = 'portable.voiceSettings';

export interface VoiceSettingsState {
  strategyId: VoiceStrategyId;
  setStrategyId: (id: VoiceStrategyId) => void;
  /** BCP-47 dictation language tag. Defaults to English — existing installs (whose persisted
   * state predates this field) keep English via the initial-state merge. */
  languageTag: string;
  setLanguageTag: (tag: string) => void;
}

export const useVoiceSettingsStore = create<VoiceSettingsState>()(
  persist(
    (set) => ({
      strategyId: DEFAULT_VOICE_STRATEGY,
      setStrategyId: (strategyId) => set({ strategyId }),
      languageTag: DEFAULT_VOICE_LANGUAGE,
      setLanguageTag: (languageTag) => set({ languageTag }),
    }),
    {
      name: VOICE_SETTINGS_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
