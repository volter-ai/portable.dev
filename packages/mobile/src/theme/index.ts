/**
 * Theme barrel — the native design system.
 *
 * Authenticated screens style themselves from `useAppTheme()`; a given
 * `{ brightness, accent }` resolves to a deterministic color set. Sign-in /
 * onboarding keep their own `signInTheme.ts`.
 */

export { useAppTheme, withAlpha, mixColors, type AppTheme } from './useAppTheme';
export {
  createTheme,
  lh,
  type Theme,
  type ThemeColors,
  type RNShadow,
  type ResolvedBrightness,
  type CreateThemeOptions,
} from './theme';
export { resolveBrightness } from './resolveBrightness';
export { createMarkdownStyles } from './markdownStyles';
export {
  TOOL_COLORS,
  getToolOperationType,
  createUnifiedToolPalette,
  type ToolColors,
  type ToolColorPalette,
} from './toolColors';
export { accentMetadata, getLuminance, type AccentMetadata } from './palette';
export { Icon, type IconName, type IconProps } from './icons/Icon';
export { WhaleIcon } from './icons/WhaleIcon';
