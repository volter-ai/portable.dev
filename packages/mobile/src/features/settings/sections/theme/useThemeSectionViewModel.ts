/**
 * Theme section ViewModel — drives the theme controls + persistence flow.
 *
 * Every control writes the global `useThemeStore` (MMKV-persisted — the app
 * re-themes instantly via `useAppTheme`) AND schedules a debounced background
 * sync of the FULL current `ThemeOptions` to the server via
 * `PUT /api/user/theme { themeConfig }`. `ThemeSync` hydrates from
 * `GET /api/user/theme` on cold start. The PUT is non-blocking:
 * local state applies immediately; sync failures are swallowed.
 *
 * `themeConfig` is built from the CURRENT store state AFTER the write — and it
 * carries through every non-function field on the store (not just the eight
 * this page edits), so server-hydrated extras (e.g.
 * `backgroundImages`, `customTool*`) are never wiped by a mobile save.
 *
 * Reset: `DELETE /api/user/theme` then reset
 * the store to `MOBILE_DEFAULT_THEME_OPTIONS` (local reset still happens when
 * the server call fails). A pending debounced PUT is cancelled
 * first so it can't re-save the pre-reset config after the DELETE.
 *
 * Custom accent: two hex `TextInput` drafts (documented in the Screen header).
 * A draft only commits to `setCustomGradient` once BOTH values are valid
 * `#RRGGBB` — drafts live in state + refs (the state-ref pattern) so a
 * type-then-commit in one tick reads fresh values.
 *
 * Seams (all injectable): `api` (defaults to the `useOptionalApi()` client) and
 * `debounceMs` (default 400ms so a swatch-browse doesn't spam the server).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Accent, Brightness, ThemeOptions } from '@vgit2/shared/types';

import { useOptionalApi } from '../../../api/ApiProvider';
import { useThemeStore } from '../../../state/themeStore';

/** Server endpoint for the user theme config. */
export const THEME_ENDPOINT = '/api/user/theme';

/** Default debounce before the background PUT (a swatch-browse shouldn't spam). */
export const THEME_SYNC_DEBOUNCE_MS = 400;

/** Custom-gradient fallbacks. */
export const DEFAULT_CUSTOM_GRADIENT_START = '#0969DA';
export const DEFAULT_CUSTOM_GRADIENT_END = '#8250DF';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Valid `#RRGGBB` hex color (the commit gate for the custom gradient drafts). */
export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

/** The slice of the sandbox API client this section needs (injectable seam). */
export interface ThemeSectionApi {
  put<T>(path: string, json?: unknown): Promise<T>;
  del<T>(path: string, json?: unknown): Promise<T>;
}

export interface UseThemeSectionDeps {
  /** API client override (default: the `useOptionalApi()` context client). */
  api?: ThemeSectionApi;
  /** Debounce before the background `PUT /api/user/theme` (default 400ms). */
  debounceMs?: number;
}

export interface ThemeSectionViewModel {
  // Current store values (live — the page re-themes as they change).
  brightness: Brightness;
  accent: Accent;
  usePaper: boolean;
  useOled: boolean;
  boldMode: boolean;
  useGradients: boolean;
  /** Committed custom gradient (store value or the default fallback). */
  customStart: string;
  customEnd: string;
  // Custom gradient hex drafts (TextInput-bound; commit on valid #RRGGBB).
  customStartDraft: string;
  customEndDraft: string;
  customStartValid: boolean;
  customEndValid: boolean;
  // Accent modal.
  accentModalVisible: boolean;
  openAccentModal: () => void;
  closeAccentModal: () => void;
  // Mutators (store write + debounced server sync).
  selectBrightness: (brightness: Brightness) => void;
  selectAccent: (accent: Accent) => void;
  setUseOled: (useOled: boolean) => void;
  setUsePaper: (usePaper: boolean) => void;
  setBoldMode: (boldMode: boolean) => void;
  setUseGradients: (useGradients: boolean) => void;
  setCustomStartDraft: (text: string) => void;
  setCustomEndDraft: (text: string) => void;
  // Reset.
  resetting: boolean;
  resetToDefaults: () => Promise<void>;
}

/**
 * Snapshot every non-function, defined field of the theme store — the full
 * current `ThemeOptions` (incl. server-hydrated extras like `backgroundImages`
 * that `ThemeSync.setTheme` spread into the store).
 */
function currentThemeConfig(): ThemeOptions {
  const state = useThemeStore.getState() as unknown as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'function' || value === undefined) continue;
    config[key] = value;
  }
  return config as unknown as ThemeOptions;
}

export function useThemeSectionViewModel(deps: UseThemeSectionDeps = {}): ThemeSectionViewModel {
  const contextApi = useOptionalApi();
  const api = deps.api ?? contextApi;
  const apiRef = useRef<ThemeSectionApi | null>(api);
  apiRef.current = api;
  const debounceMs = deps.debounceMs ?? THEME_SYNC_DEBOUNCE_MS;

  // Live store subscriptions (one primitive per selector — zustand v5 rule).
  const brightness = useThemeStore((s) => s.brightness);
  const accent = useThemeStore((s) => s.accent);
  const usePaper = useThemeStore((s) => s.usePaper ?? false);
  const useOled = useThemeStore((s) => s.useOled ?? false);
  const boldMode = useThemeStore((s) => s.boldMode ?? false);
  const useGradients = useThemeStore((s) => s.useGradients !== false);
  const storedCustomStart = useThemeStore((s) => s.customGradientStart);
  const storedCustomEnd = useThemeStore((s) => s.customGradientEnd);

  const [accentModalVisible, setAccentModalVisible] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Custom hex drafts, seeded from the store (gradient fallbacks).
  const [customStartDraft, setStartDraftState] = useState(
    () => useThemeStore.getState().customGradientStart ?? DEFAULT_CUSTOM_GRADIENT_START
  );
  const [customEndDraft, setEndDraftState] = useState(
    () => useThemeStore.getState().customGradientEnd ?? DEFAULT_CUSTOM_GRADIENT_END
  );
  const startDraftRef = useRef(customStartDraft);
  const endDraftRef = useRef(customEndDraft);

  // ── Debounced background server sync ───────────────────────────────────────
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistNow = useCallback(() => {
    const target = apiRef.current;
    if (!target) return; // No provider mounted — local-only (degrade gracefully).
    void target.put(THEME_ENDPOINT, { themeConfig: currentThemeConfig() }).catch(() => {
      // Non-blocking background sync — local state already applied.
    });
  }, []);

  const schedulePersist = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persistNow();
    }, debounceMs);
  }, [debounceMs, persistNow]);

  // Flush a pending sync on unmount so a quick change + back isn't lost.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        persistNow();
      }
    },
    [persistNow]
  );

  // ── Mutators (store write, then schedule the sync) ─────────────────────────
  const selectBrightness = useCallback(
    (next: Brightness) => {
      useThemeStore.getState().setBrightness(next);
      schedulePersist();
    },
    [schedulePersist]
  );

  const selectAccent = useCallback(
    (next: Accent) => {
      useThemeStore.getState().setAccent(next);
      setAccentModalVisible(false);
      schedulePersist();
    },
    [schedulePersist]
  );

  const setUseOledValue = useCallback(
    (next: boolean) => {
      useThemeStore.getState().setUseOled(next);
      schedulePersist();
    },
    [schedulePersist]
  );

  const setUsePaperValue = useCallback(
    (next: boolean) => {
      useThemeStore.getState().setUsePaper(next);
      schedulePersist();
    },
    [schedulePersist]
  );

  const setBoldModeValue = useCallback(
    (next: boolean) => {
      useThemeStore.getState().setBoldMode(next);
      schedulePersist();
    },
    [schedulePersist]
  );

  const setUseGradientsValue = useCallback(
    (next: boolean) => {
      useThemeStore.getState().setUseGradients(next);
      schedulePersist();
    },
    [schedulePersist]
  );

  /** Commit the drafts to the store once BOTH are valid #RRGGBB. */
  const commitCustomIfValid = useCallback(() => {
    const start = startDraftRef.current;
    const end = endDraftRef.current;
    if (isHexColor(start) && isHexColor(end)) {
      useThemeStore.getState().setCustomGradient(start, end);
      schedulePersist();
    }
  }, [schedulePersist]);

  const setCustomStartDraft = useCallback(
    (text: string) => {
      startDraftRef.current = text; // sync ref BEFORE the commit read (state-ref pattern)
      setStartDraftState(text);
      commitCustomIfValid();
    },
    [commitCustomIfValid]
  );

  const setCustomEndDraft = useCallback(
    (text: string) => {
      endDraftRef.current = text;
      setEndDraftState(text);
      commitCustomIfValid();
    },
    [commitCustomIfValid]
  );

  // ── Reset ──────────────────────────────────────────────────────────────────
  const resetToDefaults = useCallback(async () => {
    setResetting(true);
    // Cancel a pending sync so it can't re-save the pre-reset config after DELETE.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      await apiRef.current?.del(THEME_ENDPOINT);
    } catch {
      // Still reset locally even when the server call fails.
    }
    const store = useThemeStore.getState();
    store.reset();
    // `reset()` merges defaults — explicitly clear the custom fields a
    // wholesale `setThemeOptions(defaultThemeOptions)` replacement drops.
    useThemeStore.setState({ customGradientStart: undefined, customGradientEnd: undefined });
    startDraftRef.current = DEFAULT_CUSTOM_GRADIENT_START;
    endDraftRef.current = DEFAULT_CUSTOM_GRADIENT_END;
    setStartDraftState(DEFAULT_CUSTOM_GRADIENT_START);
    setEndDraftState(DEFAULT_CUSTOM_GRADIENT_END);
    setResetting(false);
  }, []);

  return {
    brightness,
    accent,
    usePaper,
    useOled,
    boldMode,
    useGradients,
    customStart: storedCustomStart ?? DEFAULT_CUSTOM_GRADIENT_START,
    customEnd: storedCustomEnd ?? DEFAULT_CUSTOM_GRADIENT_END,
    customStartDraft,
    customEndDraft,
    customStartValid: isHexColor(customStartDraft),
    customEndValid: isHexColor(customEndDraft),
    accentModalVisible,
    openAccentModal: () => setAccentModalVisible(true),
    closeAccentModal: () => setAccentModalVisible(false),
    selectBrightness,
    selectAccent,
    setUseOled: setUseOledValue,
    setUsePaper: setUsePaperValue,
    setBoldMode: setBoldModeValue,
    setUseGradients: setUseGradientsValue,
    setCustomStartDraft,
    setCustomEndDraft,
    resetting,
    resetToDefaults,
  };
}
