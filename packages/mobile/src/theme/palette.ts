/**
 * Color palette + utilities — the color logic for the theme system.
 *
 * These are pure string/number transforms with no DOM/CSS deps. `theme.ts`
 * assembles a Theme from these.
 */

import type { Accent } from '@vgit2/shared/types';

/** Internal, post-resolution brightness. */
export type ResolvedBrightness = 'light' | 'paper' | 'dark' | 'oled';

interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

/** Convert hex color to HSL. */
function hexToHSL(hex: string): HSL {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Convert HSL to hex color. */
function hslToHex(hsl: HSL): string {
  const { h, s, l } = hsl;
  const hNorm = h / 360;
  const sNorm = s / 100;
  const lNorm = l / 100;

  let r: number, g: number, b: number;

  if (sNorm === 0) {
    r = g = b = lNorm;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = lNorm < 0.5 ? lNorm * (1 + sNorm) : lNorm + sNorm - lNorm * sNorm;
    const p = 2 * lNorm - q;
    r = hue2rgb(p, q, hNorm + 1 / 3);
    g = hue2rgb(p, q, hNorm);
    b = hue2rgb(p, q, hNorm - 1 / 3);
  }

  const toHex = (x: number) => {
    const hex = Math.round(x * 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Create rgba color with alpha transparency. */
export function hexToRgba(hex: string, alpha: number): string {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Relative luminance (WCAG). Returns 0 (black) … 1 (white). Used to pick a
 * readable text color over a bold/gradient accent background.
 */
export function getLuminance(hex: string): number {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const rLinear = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const gLinear = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const bLinear = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/** Adjust color for brightness mode — paper mutes saturation by 25%. */
export function adjustColorForBrightness(hex: string, brightness: ResolvedBrightness): string {
  const hsl = hexToHSL(hex);
  if (brightness === 'paper') {
    hsl.s = Math.max(0, hsl.s - 25);
  }
  return hslToHex(hsl);
}

// ===== Accent palettes (brighter versions) =====

const blueAccent = {
  gradientStart: '#657EEA',
  gradientEnd: '#9c6bcc',
};
const greenAccent = {
  gradientStart: '#39FF14',
  gradientEnd: '#6FFF44',
};
const orangeAccent = {
  gradientStart: '#EB7B47',
  gradientEnd: '#F09E75',
};
const redAccent = {
  gradientStart: '#D84F4A',
  gradientEnd: '#E86560',
};
const tealAccent = {
  gradientStart: '#30D5C8',
  gradientEnd: '#46E5DB',
};
const pinkAccent = {
  gradientStart: '#E85ACD',
  gradientEnd: '#FF7FE8',
};
const amberAccent = {
  gradientStart: '#D4A72C',
  gradientEnd: '#F0C14B',
};
const limeAccent = {
  gradientStart: '#8FD400',
  gradientEnd: '#AAFF00',
};
const seafoamAccent = {
  gradientStart: '#6cd59f',
  gradientEnd: '#90dfb6',
};
const blackAccent = {
  gradientStart: '#000000',
  gradientEnd: '#333333',
};
const whiteAccent = {
  gradientStart: '#FFFFFF',
  gradientEnd: '#F0F0F0',
};
const yellowAccent = {
  gradientStart: '#FFD700',
  gradientEnd: '#FFF44F',
};

/** Accent metadata for UI (accent picker). */
export interface AccentMetadata {
  value: Accent;
  label: string;
  gradientStart: string;
  gradientEnd: string;
}

export const accentMetadata: AccentMetadata[] = [
  { value: 'red', label: 'Portable Red', ...redAccent },
  { value: 'blue', label: "Claude's Favorite Crayon", ...blueAccent },
  { value: 'green', label: 'I Am A Hacker', ...greenAccent },
  { value: 'orange', label: 'Orange Cords', ...orangeAccent },
  { value: 'teal', label: 'A Cyan Manifesto', ...tealAccent },
  { value: 'pink', label: 'Triage on the Beach', ...pinkAccent },
  { value: 'amber', label: 'Deploy Amber', ...amberAccent },
  { value: 'lime', label: 'Sprint Lime', ...limeAccent },
  { value: 'seafoam', label: 'Minty Terminal', ...seafoamAccent },
  { value: 'black', label: 'Stealth Launch', ...blackAccent },
  { value: 'white', label: 'White Hat', ...whiteAccent },
  { value: 'yellow', label: 'Banana', ...yellowAccent },
];

/** Resolve an accent name to its `{ gradientStart, gradientEnd }` pair. */
export function accentPaletteFor(accent: Accent): { gradientStart: string; gradientEnd: string } {
  switch (accent) {
    case 'blue':
      return blueAccent;
    case 'green':
      return greenAccent;
    case 'orange':
      return orangeAccent;
    case 'red':
      return redAccent;
    case 'teal':
      return tealAccent;
    case 'pink':
      return pinkAccent;
    case 'amber':
      return amberAccent;
    case 'lime':
      return limeAccent;
    case 'seafoam':
      return seafoamAccent;
    case 'black':
      return blackAccent;
    case 'white':
      return whiteAccent;
    case 'yellow':
      return yellowAccent;
    default:
      return blueAccent; // 'custom' handled by createTheme; unknown → blue
  }
}

/** Generate the full accent color set from a gradient pair. */
export function generateAccentColors(gradientStart: string, gradientEnd: string) {
  return {
    gradientStart,
    gradientEnd,
    primary: gradientStart,
    primaryLight: gradientStart,
    primaryDark: gradientStart,
    accent: gradientStart,
    accentLight: gradientStart,
    accentDark: gradientStart,
    info: gradientStart,
    focus: `${gradientStart}33`, // 20% opacity
  };
}

/** Base (non-accent) colors per resolved brightness. */
export function getBaseColors(brightness: ResolvedBrightness, baseAccent: string) {
  if (brightness === 'light') {
    return {
      background: '#F6F8FA',
      backgroundElevated: '#FFFFFF',
      backgroundGlass: 'rgba(246, 248, 250, 0.95)',
      surface: '#FFFFFF',
      surfaceHover: '#F3F5F8',
      text: '#1F2328',
      textSecondary: '#656D76',
      textTertiary: '#8B949E',
      textInverse: '#FFFFFF',
      border: '#D0D7DE',
      borderLight: '#E8ECEF',
      borderDark: '#B1B9C1',
      borderHover: '#B1B9C1',
      link: '#0969DA',
      hover: hexToRgba(baseAccent, 0.12),
      active: hexToRgba(baseAccent, 0.2),
      disabled: 'rgba(0, 0, 0, 0.25)',
      overlay: 'rgba(255, 255, 255, 0.85)',
    };
  }
  if (brightness === 'paper') {
    return {
      background: '#F5F1E8',
      backgroundElevated: '#FAF6ED',
      backgroundGlass: 'rgba(250, 246, 237, 0.95)',
      surface: '#FAF6ED',
      surfaceHover: '#EDE7D8',
      text: '#2A2520',
      textSecondary: '#6B6560',
      textTertiary: '#9B9590',
      textInverse: '#FAF6ED',
      border: '#E5DFD0',
      borderLight: '#EDE9DC',
      borderDark: '#D5CFC0',
      borderHover: '#D5CFC0',
      link: '#8B7355',
      hover: hexToRgba(baseAccent, 0.1),
      active: hexToRgba(baseAccent, 0.18),
      disabled: 'rgba(42, 37, 32, 0.25)',
      overlay: 'rgba(250, 246, 237, 0.85)',
    };
  }
  if (brightness === 'oled') {
    return {
      background: '#000000',
      backgroundElevated: '#1A1A1A',
      backgroundGlass: 'rgba(26, 26, 26, 0.95)',
      surface: '#1A1A1A',
      surfaceHover: '#2A2A2A',
      text: '#E6EDF3',
      textSecondary: '#8B949E',
      textTertiary: '#6E7681',
      textInverse: '#000000',
      border: '#202020',
      borderLight: '#0F0F0F',
      borderDark: '#2A2A2A',
      borderHover: '#2A2A2A',
      link: '#58A6FF',
      hover: hexToRgba(baseAccent, 0.18),
      active: hexToRgba(baseAccent, 0.28),
      disabled: 'rgba(255, 255, 255, 0.25)',
      overlay: 'rgba(0, 0, 0, 0.85)',
    };
  }
  // dark (GitHub dark)
  return {
    background: '#0D1117',
    backgroundElevated: '#161B22',
    backgroundGlass: 'rgba(22, 27, 34, 0.95)',
    surface: '#161B22',
    surfaceHover: '#21262D',
    text: '#E6EDF3',
    textSecondary: '#8B949E',
    textTertiary: '#6E7681',
    textInverse: '#0D1117',
    border: '#30363D',
    borderLight: '#21262D',
    borderDark: '#3E4852',
    borderHover: '#3E4852',
    link: '#58A6FF',
    hover: hexToRgba(baseAccent, 0.14),
    active: hexToRgba(baseAccent, 0.24),
    disabled: 'rgba(255, 255, 255, 0.25)',
    overlay: 'rgba(13, 17, 23, 0.85)',
  };
}
