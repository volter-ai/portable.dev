/**
 * Theme Types
 *
 * Shared theme configuration types used across the client and gateway.
 * Single source of truth for theme-related interfaces.
 */

/**
 * Brightness mode options
 * - system: Follow system preference
 * - light: Light mode
 * - dark: Dark mode
 * - paper: Warm light mode (reduced contrast)
 * - oled: Pure black dark mode (OLED-optimized)
 */
export type Brightness = 'system' | 'light' | 'dark' | 'paper' | 'oled';

/**
 * Accent color options
 */
export type Accent =
  | 'blue'
  | 'green'
  | 'orange'
  | 'red'
  | 'teal'
  | 'pink'
  | 'amber'
  | 'lime'
  | 'seafoam'
  | 'black'
  | 'white'
  | 'yellow'
  | 'custom';

/**
 * Background image configuration
 */
export interface BackgroundImageConfig {
  url: string;
  opacity?: number;
  tags: string[]; // Tags to determine when this background should be shown
}

/**
 * Complete theme configuration options
 * Used by both the client (ThemeContext) and gateway (onboarding theme selection)
 */
export interface ThemeOptions {
  /**
   * Brightness/color scheme mode
   */
  brightness: Brightness;

  /**
   * Accent color theme
   */
  accent: Accent;

  /**
   * Apply accent color to navigation elements
   * @default false
   */
  boldMode?: boolean;

  /**
   * Use gradients in bold mode
   * @default true
   */
  useGradients?: boolean;

  /**
   * Use paper theme for light mode (warm, reduced contrast)
   * @default false
   */
  usePaper?: boolean;

  /**
   * Use OLED black for dark mode (pure black, power saving)
   * @default false
   */
  useOled?: boolean;

  /**
   * Custom gradient start color (when accent is 'custom')
   */
  customGradientStart?: string;

  /**
   * Custom gradient end color (when accent is 'custom')
   */
  customGradientEnd?: string;

  /**
   * Custom tool colors (when accent is 'custom')
   */
  customToolRead?: string;
  customToolEdit?: string;
  customToolWrite?: string;
  customToolBash?: string;
  customToolBashOutput?: string;
  customToolGrep?: string;
  customToolSpecial?: string;
  customToolPermission?: string;

  /**
   * Background images with tag-based display logic
   */
  backgroundImages?: BackgroundImageConfig[];

  /**
   * Global opacity override for all background images (0-1)
   */
  backgroundOpacity?: number;
}

/**
 * Default theme options
 * Used as fallback when no user preferences are set
 */
export const DEFAULT_THEME_OPTIONS: ThemeOptions = {
  brightness: 'system',
  accent: 'red',
  boldMode: false,
  useGradients: true,
  usePaper: true,
  useOled: false,
  backgroundImages: [],
};
