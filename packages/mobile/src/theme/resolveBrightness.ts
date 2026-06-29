/**
 * Resolve the persisted `ThemeOptions.brightness` (which may be `'system'`) to a
 * concrete {@link ResolvedBrightness} the theme builder accepts.
 *
 * Handles the standard brightness resolution, PLUS the two extra literals the
 * shared `Brightness` type carries at this layer:
 * the onboarding theme presets (`themePresets.ts`) persist `'paper'` / `'oled'`
 * directly, so they must pass through unchanged here.
 */

import type { ResolvedBrightness } from './palette';
import type { Brightness } from '@vgit2/shared/types';

export interface ResolveBrightnessOptions {
  brightness: Brightness;
  usePaper?: boolean;
  useOled?: boolean;
}

export function resolveBrightness(
  options: ResolveBrightnessOptions,
  systemScheme: 'light' | 'dark' | null
): ResolvedBrightness {
  const b = options.brightness;

  // Presets persist these directly — honor them as-is.
  if (b === 'paper') return 'paper';
  if (b === 'oled') return 'oled';

  const resolved: 'light' | 'dark' =
    b === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : b;

  if (resolved === 'light' && options.usePaper) return 'paper';
  if (resolved === 'dark' && options.useOled) return 'oled';
  return resolved;
}
