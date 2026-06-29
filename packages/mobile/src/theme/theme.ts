/**
 * Portable native theme.
 *
 * The COLOR logic lives in `palette.ts` / `toolColors.ts`
 * so a given `{ brightness, accent }` produces deterministic colors.
 * Only the non-color tokens are adapted to React Native:
 *   - spacing / borderRadius / font sizes → numbers (not CSS strings)
 *   - font weights → RN `fontWeight` string literals
 *   - line heights → multipliers (use the `lh(size, mult)` helper for absolute px)
 *   - shadows → RN shadow objects ({ shadowColor, shadowOffset, … , elevation })
 *   - `transitions` / `breakpoints` dropped (no CSS / responsive media on RN)
 *
 * Consume it through {@link useAppTheme}; never hard-code colors in a screen.
 */

import { Platform, type TextStyle } from 'react-native';

import {
  accentPaletteFor,
  adjustColorForBrightness,
  generateAccentColors,
  getBaseColors,
  hexToRgba,
  type ResolvedBrightness,
} from './palette';
import {
  createUnifiedToolPalette,
  TOOL_BLOCK_HOVER_OPACITY,
  TOOL_BLOCK_OPACITY,
  TOOL_BLOCK_OPACITY_HEX,
  type ToolColorPalette,
} from './toolColors';

import type { Accent } from '@vgit2/shared/types';

export type { ResolvedBrightness } from './palette';

/** RN shadow descriptor (iOS shadow* + Android elevation). */
export interface RNShadow {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

export interface ThemeColors {
  primary: string;
  primaryLight: string;
  primaryDark: string;

  accent: string;
  accentLight: string;
  accentDark: string;
  accentSoft: string;

  gradientStart: string;
  gradientEnd: string;

  background: string;
  backgroundElevated: string;
  backgroundGlass: string;
  surface: string;
  surfaceHover: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;

  success: string;
  warning: string;
  error: string;
  danger: string;
  info: string;

  border: string;
  borderLight: string;
  borderDark: string;
  borderHover: string;

  link: string;

  hover: string;
  active: string;
  disabled: string;
  focus: string;

  overlay: string;

  /** True for light-background themes (light + paper). */
  isLight: boolean;
}

export interface Theme {
  colors: ThemeColors;
  tool: ToolColorPalette;

  spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number };

  typography: {
    fontFamilyMono: string;
    sizes: {
      xs: number;
      sm: number;
      base: number;
      lg: number;
      xl: number;
      xxl: number;
      xxxl: number;
    };
    weights: {
      normal: TextStyle['fontWeight'];
      medium: TextStyle['fontWeight'];
      semibold: TextStyle['fontWeight'];
      bold: TextStyle['fontWeight'];
    };
    lineHeights: { tight: number; normal: number; relaxed: number };
  };

  borderRadius: { none: number; sm: number; md: number; lg: number; xl: number; full: number };

  shadows: { none: RNShadow; sm: RNShadow; md: RNShadow; lg: RNShadow; xl: RNShadow };

  opacity: { toolBlock: number; toolBlockHex: string; toolBlockHover: number };

  zIndex: {
    base: number;
    dropdown: number;
    sticky: number;
    modal: number;
    popover: number;
    toast: number;
  };
}

/** Absolute line height in px (RN needs a number, not a multiplier). */
export function lh(size: number, multiplier: number): number {
  return Math.round(size * multiplier);
}

const NO_SHADOW: RNShadow = {
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0,
  shadowRadius: 0,
  elevation: 0,
};

// Maps CSS box-shadows (0 Ypx Bpx rgba(0,0,0,A)) → RN shadow objects.
const SHADOWS: Theme['shadows'] = {
  none: NO_SHADOW,
  sm: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 15,
    elevation: 6,
  },
  xl: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.15,
    shadowRadius: 25,
    elevation: 12,
  },
};

const TYPOGRAPHY: Theme['typography'] = {
  // A system fontFamily stack is unnecessary; RN's default already IS SF/Roboto, so
  // we leave the body font unset and only pin the mono family for code.
  fontFamilyMono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  sizes: { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, xxl: 24, xxxl: 32 },
  weights: { normal: '400', medium: '500', semibold: '600', bold: '700' },
  lineHeights: { tight: 1.2, normal: 1.5, relaxed: 1.75 },
};

const SPACING: Theme['spacing'] = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 };
const BORDER_RADIUS: Theme['borderRadius'] = { none: 0, sm: 4, md: 8, lg: 12, xl: 16, full: 9999 };
const Z_INDEX: Theme['zIndex'] = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  modal: 1200,
  popover: 1300,
  toast: 1400,
};

/** Options accepted by `createTheme` (brightness already resolved). */
export interface CreateThemeOptions {
  brightness: ResolvedBrightness;
  accent: Accent;
  customGradientStart?: string;
  customGradientEnd?: string;
}

/** Build a full Theme from a resolved brightness + accent (pure; memoize the caller). */
export function createTheme(options: CreateThemeOptions): Theme {
  const { brightness, accent, customGradientStart, customGradientEnd } = options;

  const baseAccentPalette = accentPaletteFor(accent);
  const baseAccent =
    accent === 'custom' && customGradientStart
      ? customGradientStart
      : baseAccentPalette.gradientStart;

  const accentColors =
    accent === 'custom' && customGradientStart && customGradientEnd
      ? generateAccentColors(
          adjustColorForBrightness(customGradientStart, brightness),
          adjustColorForBrightness(customGradientEnd, brightness)
        )
      : generateAccentColors(
          adjustColorForBrightness(baseAccentPalette.gradientStart, brightness),
          adjustColorForBrightness(baseAccentPalette.gradientEnd, brightness)
        );

  const baseColors = getBaseColors(brightness, baseAccent);

  return {
    colors: {
      ...baseColors,
      ...accentColors,
      accentSoft: hexToRgba(accentColors.accent, 0.45),
      success: '#1A7F37',
      warning: '#BF8700',
      error: '#CF222E',
      danger: '#CF222E',
      // light + paper are both light backgrounds (RN uses this for status-bar /
      // syntax decisions; the paper→false quirk is intentionally fixed here).
      isLight: brightness === 'light' || brightness === 'paper',
    },
    tool: createUnifiedToolPalette(),
    spacing: SPACING,
    typography: TYPOGRAPHY,
    borderRadius: BORDER_RADIUS,
    shadows: SHADOWS,
    opacity: {
      toolBlock: TOOL_BLOCK_OPACITY,
      toolBlockHex: TOOL_BLOCK_OPACITY_HEX,
      toolBlockHover: TOOL_BLOCK_HOVER_OPACITY,
    },
    zIndex: Z_INDEX,
  };
}
