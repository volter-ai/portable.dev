/**
 * `useAppTheme` — the native theme hook.
 *
 * No Provider: the theme inputs live in the global `useThemeStore` (zustand +
 * MMKV), so a hook that reads it + the OS color scheme is enough — a context
 * would just add a dead layer. Every authenticated screen styles itself from
 * what this returns; sign-in / onboarding keep their own `signInTheme.ts` tokens.
 */

import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { getLuminance } from './palette';
import { resolveBrightness } from './resolveBrightness';
import { createTheme, type Theme } from './theme';
import { useThemeStore } from '../features/state/themeStore';

export interface AppTheme {
  theme: Theme;
  isDark: boolean;
  boldMode: boolean;
  useGradients: boolean;
  /** [gradientStart, gradientEnd] ready for `expo-linear-gradient`'s `colors`. */
  boldGradient: readonly [string, string];
  /** Readable text color (#000/#fff) over the bold/gradient accent background. */
  getBoldTextColor: () => string;
}

/**
 * Append a 2-hex-digit alpha to a `#RRGGBB` color (glassmorphism by suffix:
 * `66`≈40%, `99`≈60%, `CC`≈80%, `E6`≈90%, `40`≈25%). rgba()/non-#RRGGBB inputs
 * pass through unchanged.
 */
export function withAlpha(color: string, alphaSuffix: string): string {
  return color.startsWith('#') && color.length === 7 ? `${color}${alphaSuffix}` : color;
}

const OPAQUE_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Opaquely blend `amount` (0–1) of `tint` into `base` (both `#RRGGBB`). Use instead
 * of a translucent {@link withAlpha} wash when the view must stay OPAQUE — a card
 * whose background goes translucent lets whatever renders behind it bleed through
 * (e.g. a swipe row's always-mounted action buttons). Non-`#RRGGBB` input → `base`.
 */
export function mixColors(base: string, tint: string, amount: number): string {
  if (!OPAQUE_HEX.test(base) || !OPAQUE_HEX.test(tint)) return base;
  const channel = (offset: number) => {
    const b = parseInt(base.slice(offset, offset + 2), 16);
    const t = parseInt(tint.slice(offset, offset + 2), 16);
    return Math.round(b + (t - b) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

export function useAppTheme(): AppTheme {
  const scheme = useColorScheme();

  // Subscribe to each option primitive separately (zustand v5 has no shallow
  // auto-compare — returning a fresh object would loop).
  const brightness = useThemeStore((s) => s.brightness);
  const accent = useThemeStore((s) => s.accent);
  const usePaper = useThemeStore((s) => s.usePaper);
  const useOled = useThemeStore((s) => s.useOled);
  const boldMode = useThemeStore((s) => s.boldMode);
  const useGradients = useThemeStore((s) => s.useGradients);
  const customGradientStart = useThemeStore((s) => s.customGradientStart);
  const customGradientEnd = useThemeStore((s) => s.customGradientEnd);

  // `useColorScheme()` can be 'light' | 'dark' | null | 'unspecified' — narrow it.
  const systemScheme: 'light' | 'dark' | null =
    scheme === 'dark' ? 'dark' : scheme === 'light' ? 'light' : null;
  const resolvedBrightness = resolveBrightness({ brightness, usePaper, useOled }, systemScheme);

  const theme = useMemo(
    () =>
      createTheme({
        brightness: resolvedBrightness,
        accent,
        customGradientStart,
        customGradientEnd,
      }),
    [resolvedBrightness, accent, customGradientStart, customGradientEnd]
  );

  return {
    theme,
    isDark: resolvedBrightness === 'dark' || resolvedBrightness === 'oled',
    boldMode: boldMode ?? false,
    useGradients: useGradients !== false,
    boldGradient: [theme.colors.gradientStart, theme.colors.gradientEnd] as const,
    getBoldTextColor: () =>
      getLuminance(theme.colors.gradientStart) > 0.5 ? '#000000' : '#FFFFFF',
  };
}
