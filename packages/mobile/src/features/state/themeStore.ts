/**
 * Theme slice — client UI prefs.
 *
 * Persisted via the MMKV adapter (UI prefs are non-secret). Modeled on the
 * canonical `ThemeOptions` / `DEFAULT_THEME_OPTIONS` from `@vgit2/shared` so the
 * native theme stays a single source of truth with the gateway onboarding.
 */

import {
  DEFAULT_THEME_OPTIONS,
  type ThemeOptions,
  type Accent,
  type Brightness,
} from '@vgit2/shared/types';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from './storage';

export interface ThemeState extends ThemeOptions {
  setBrightness: (brightness: Brightness) => void;
  setAccent: (accent: Accent) => void;
  setBoldMode: (boldMode: boolean) => void;
  setUseGradients: (useGradients: boolean) => void;
  setUsePaper: (usePaper: boolean) => void;
  setUseOled: (useOled: boolean) => void;
  setCustomGradient: (start: string, end: string) => void;
  /** Replace the whole theme (e.g. applying an onboarding selection). */
  setTheme: (options: Partial<ThemeOptions>) => void;
  reset: () => void;
}

/** MMKV persist key for the theme slice. */
export const THEME_PERSIST_KEY = 'portable.theme';

/**
 * Native default theme = `light` + `orange` + `usePaper`,
 * NOT the shared `DEFAULT_THEME_OPTIONS` (`system`/`red`). This gives an
 * out-of-the-box warm "paper" beige + orange accent
 * before the user picks a theme in onboarding or settings.
 */
export const MOBILE_DEFAULT_THEME_OPTIONS: ThemeOptions = {
  ...DEFAULT_THEME_OPTIONS,
  brightness: 'light',
  accent: 'orange',
  boldMode: false,
  useGradients: true,
  usePaper: true,
  useOled: false,
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      ...MOBILE_DEFAULT_THEME_OPTIONS,
      setBrightness: (brightness) => set({ brightness }),
      setAccent: (accent) => set({ accent }),
      setBoldMode: (boldMode) => set({ boldMode }),
      setUseGradients: (useGradients) => set({ useGradients }),
      setUsePaper: (usePaper) => set({ usePaper }),
      setUseOled: (useOled) => set({ useOled }),
      setCustomGradient: (customGradientStart, customGradientEnd) =>
        set({ customGradientStart, customGradientEnd }),
      setTheme: (options) => set({ ...options }),
      reset: () => set({ ...MOBILE_DEFAULT_THEME_OPTIONS }),
    }),
    {
      name: THEME_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
