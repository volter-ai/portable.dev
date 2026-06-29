/**
 * User Settings Types
 *
 * Types for persisting user preferences and onboarding state.
 * Settings are stored in the user_themes table.
 */

import type { SupportedLanguage } from '../i18n/index.js';

/**
 * User onboarding settings collected during the onboarding flow
 */
export interface OnboardingSettings {
  // Language preference (ISO 639-1 code)
  language: SupportedLanguage;

  // Theme preference (theme ID from theme system)
  theme: string;

  // User roles (can select multiple)
  roles: string[];

  // Development tools the user is familiar with
  devtools: string[];

  // User interests (optional - currently skipped in flow)
  interests: string[];
}

/**
 * User settings stored in database
 * Maps to user_themes.theme_config JSONB column
 */
export interface UserSettings {
  // Onboarding completion status
  onboardingCompleted: boolean;

  // Timestamp when onboarding was completed (ISO 8601)
  onboardingCompletedAt?: string;

  // Onboarding settings collected during flow
  onboarding?: OnboardingSettings;

  // AI Summary preferences
  // Refresh interval in seconds (15, 30, 60, or 120)
  summaryRefreshIntervalSeconds?: number;

  // Commit attribution preference.
  // Whether commits made by the Portable agent include an AI co-author trailer
  // (`Co-Authored-By: …`). Maps to the Claude Agent SDK `includeCoAuthoredBy`
  // option. `undefined`/`true` → the trailer is added (default — behaviour
  // unchanged for everyone who never touched the toggle); `false` → "non-AI-
  // co-author mode": commits are attributed to the user alone, with no AI
  // co-author line.
  includeCoAuthoredBy?: boolean;
}

/**
 * Database row structure for user_themes table
 */
export interface UserThemeRow {
  user_id: string;
  theme_config: UserSettings;
  created_at: string;
  updated_at: string;
}

/**
 * Request to save user settings
 */
export interface SaveUserSettingsRequest {
  settings: UserSettings;
}

/**
 * Response from saving user settings
 */
export interface SaveUserSettingsResponse {
  success: boolean;
  settings: UserSettings;
}

/**
 * Response from fetching user settings
 */
export interface GetUserSettingsResponse {
  success: boolean;
  settings: UserSettings | null;
  hasCompletedOnboarding: boolean;
}
