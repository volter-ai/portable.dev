/**
 * Sign-in / onboarding design tokens — the single source of truth for the
 * colors + copy that give the RN auth + onboarding screens the gateway
 * landing-page design. The onboarding survey
 * screens and the tab bar reuse these tokens, so the dark theme
 * stays consistent across the first-run flow.
 */

/** Brand + surface colors. */
export const SIGN_IN_COLORS = {
  /** Full-screen background (gateway design). */
  background: '#1B1B1B',
  /** Gradient start (indigo) — primary brand color. */
  primary: '#6366f1',
  /** Gradient end (violet) — secondary brand color. */
  secondary: '#8b5cf6',
  /** Primary text. */
  textPrimary: '#ffffff',
  /** Subtitle / muted text. */
  textSubtitle: '#999999',
  /** Divider "or" label. */
  textDivider: '#666666',

  /** Social button surface + text. */
  socialButtonBackground: '#ffffff',
  socialButtonBorder: '#dee0e3',
  socialButtonText: '#1e1e1e',

  /** Glassmorphic input surface. */
  inputBackground: 'rgba(255, 255, 255, 0.05)',
  inputBorder: 'rgba(255, 255, 255, 0.1)',
  /** Eye toggle / placeholder glyph. */
  inputIcon: '#8b8b8b',

  /** Divider hairlines. */
  dividerLine: 'rgba(255, 255, 255, 0.1)',

  /** Error box (rgba over the dark background). */
  errorBackground: 'rgba(239, 68, 68, 0.1)',
  errorBorder: 'rgba(239, 68, 68, 0.3)',
  errorText: '#ef4444',
} as const;

/**
 * The primary submit button's 135deg gradient (indigo → violet). expo-linear-gradient
 * takes `start`/`end` as unit-square fractions; {0,0}→{1,1} is the top-left→bottom-right
 * diagonal that matches CSS `linear-gradient(135deg, …)`.
 */
export const SIGN_IN_GRADIENT = {
  colors: [SIGN_IN_COLORS.primary, SIGN_IN_COLORS.secondary] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
} as const;

/** Copy. */
export const SIGN_IN_COPY = {
  title: 'Workstation for your phone',
  subtitle: 'Build, test, and ship software from anywhere',
  submit: 'Sign In',
  dividerLabel: 'or',
  emailLabel: 'Email',
  passwordLabel: 'Password',
  emailPlaceholder: 'you@example.com',
  passwordPlaceholder: '••••••••',
} as const;

/** Per-provider social-button label. */
export const SOCIAL_PROVIDER_LABEL = {
  github: 'Continue with GitHub',
  google: 'Continue with Google',
  apple: 'Continue with Apple',
} as const;

/** Red dev-mode strip shown at the top of the sign-in screen. */
export const DEV_MODE_BANNER = {
  background: '#dc2626',
  text: '#ffffff',
  label: 'DEV MODE',
} as const;
