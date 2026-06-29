/**
 * Theme system (deterministic color foundation).
 *
 * The automatable proof that the native theme colors are deterministic: the
 * color logic is fixed, so a given `{ brightness, accent }` yields
 * the same hexes by construction. We assert the base palettes + accent + tool
 * colors + brightness resolution + the default `useAppTheme()` (paper/orange).
 */

import { render, renderHook } from '@testing-library/react-native';

import { Icon } from '../src/theme/icons/Icon';
import { WhaleIcon } from '../src/theme/icons/WhaleIcon';
import { createTheme } from '../src/theme/theme';
import { getToolOperationType, createUnifiedToolPalette } from '../src/theme/toolColors';
import { resolveBrightness } from '../src/theme/resolveBrightness';
import { useAppTheme } from '../src/theme/useAppTheme';

// useAppTheme → useThemeStore → MMKV. Mock the native module (in-memory).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

describe('createTheme — base palettes', () => {
  it('light: GitHub-light surfaces + unmuted accent', () => {
    const t = createTheme({ brightness: 'light', accent: 'orange' });
    expect(t.colors.background).toBe('#F6F8FA');
    expect(t.colors.backgroundElevated).toBe('#FFFFFF');
    expect(t.colors.surface).toBe('#FFFFFF');
    expect(t.colors.text).toBe('#1F2328');
    // The accent round-trips through HSL (`adjustColorForBrightness` runs for
    // ALL brightnesses) → lowercase hex; light preserves the orange's RGB exactly,
    // so accentSoft is still rgba(235,123,71). These are the canonical values.
    expect(t.colors.primary).toBe('#eb7b47');
    expect(t.colors.gradientStart).toBe('#eb7b47');
    expect(t.colors.gradientEnd).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.colors.accentSoft).toBe('rgba(235, 123, 71, 0.45)');
    expect(t.colors.isLight).toBe(true);
  });

  it('paper: warm beige surfaces; accent saturation muted', () => {
    const t = createTheme({ brightness: 'paper', accent: 'orange' });
    expect(t.colors.background).toBe('#F5F1E8');
    expect(t.colors.backgroundElevated).toBe('#FAF6ED');
    expect(t.colors.surface).toBe('#FAF6ED');
    expect(t.colors.text).toBe('#2A2520');
    expect(t.colors.isLight).toBe(true);
    // paper mutes saturation by 25% → primary is a valid hex, differs from #EB7B47
    expect(t.colors.primary).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(t.colors.primary).not.toBe('#EB7B47');
  });

  it('dark: GitHub-dark surfaces + unmuted accent', () => {
    const t = createTheme({ brightness: 'dark', accent: 'blue' });
    expect(t.colors.background).toBe('#0D1117');
    expect(t.colors.surface).toBe('#161B22');
    expect(t.colors.text).toBe('#E6EDF3');
    // blue accent after the (lossy) HSL round-trip we also apply
    expect(t.colors.primary).toBe('#667fea');
    expect(t.colors.isLight).toBe(false);
  });

  it('oled: pure black surfaces', () => {
    const t = createTheme({ brightness: 'oled', accent: 'orange' });
    expect(t.colors.background).toBe('#000000');
    expect(t.colors.backgroundElevated).toBe('#1A1A1A');
    expect(t.colors.surface).toBe('#1A1A1A');
    expect(t.colors.isLight).toBe(false);
  });

  it('RN-adapted non-color tokens are numbers/objects', () => {
    const t = createTheme({ brightness: 'light', accent: 'orange' });
    expect(t.spacing.md).toBe(16);
    expect(t.borderRadius.lg).toBe(12);
    expect(t.typography.sizes.base).toBe(16);
    expect(t.typography.weights.bold).toBe('700');
    expect(t.shadows.sm).toMatchObject({ shadowOpacity: 0.05, elevation: 1 });
  });
});

describe('resolveBrightness', () => {
  it('system follows the OS scheme', () => {
    expect(resolveBrightness({ brightness: 'system' }, 'dark')).toBe('dark');
    expect(resolveBrightness({ brightness: 'system' }, 'light')).toBe('light');
    expect(resolveBrightness({ brightness: 'system' }, null)).toBe('light');
  });

  it('usePaper/useOled toggles upgrade light/dark', () => {
    expect(resolveBrightness({ brightness: 'light', usePaper: true }, null)).toBe('paper');
    expect(resolveBrightness({ brightness: 'dark', useOled: true }, 'light')).toBe('oled');
    expect(resolveBrightness({ brightness: 'dark', useOled: false }, 'light')).toBe('dark');
  });

  it('explicit light/dark ignore the OS scheme', () => {
    expect(resolveBrightness({ brightness: 'light', usePaper: false }, 'dark')).toBe('light');
  });

  it('paper/oled literals (onboarding presets) pass through', () => {
    expect(resolveBrightness({ brightness: 'paper' }, 'dark')).toBe('paper');
    expect(resolveBrightness({ brightness: 'oled' }, 'light')).toBe('oled');
  });
});

describe('tool colors', () => {
  it('maps tool names to families', () => {
    expect(getToolOperationType('Read')).toBe('read');
    expect(getToolOperationType('Write')).toBe('write');
    expect(getToolOperationType('Edit')).toBe('edit');
    expect(getToolOperationType('Bash')).toBe('bash');
    expect(getToolOperationType('Grep')).toBe('read');
    expect(getToolOperationType('mcp__playwright__browser_navigate')).toBe('playwright');
    expect(getToolOperationType('TodoWrite')).toBe('system');
    expect(getToolOperationType('SomethingUnknown')).toBe('system');
  });

  it('soft backgrounds use 20% opacity; bash icon is white', () => {
    const palette = createUnifiedToolPalette();
    expect(palette.read.soft).toBe('rgba(96, 165, 250, 0.2)');
    expect(palette.bash.icon).toBe('#FFFFFF');
  });
});

describe('useAppTheme — default (paper/orange)', () => {
  it('resolves to the paper theme out of the box', () => {
    const { result } = renderHook(() => useAppTheme());
    expect(result.current.theme.colors.background).toBe('#F5F1E8');
    expect(result.current.isDark).toBe(false);
    expect(result.current.boldGradient).toHaveLength(2);
  });
});

describe('icons render', () => {
  it('Icon + WhaleIcon render via react-native-svg', () => {
    expect(render(<Icon name="gear" />).toJSON()).toBeTruthy();
    expect(render(<WhaleIcon />).toJSON()).toBeTruthy();
  });
});
