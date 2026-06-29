/**
 * Commits settings ViewModel — the per-user "AI co-author on commits"
 * toggle.
 *
 * The preference is SERVER state, persisted in `user_themes.theme_config.userSettings`
 * (`includeCoAuthoredBy`), read via `useUserSettings()` (`GET /api/user-settings`) and
 * written via `useSaveUserSettings()` (`POST /api/user-settings`). The backend REPLACES
 * `userSettings` wholesale, so the setter does a read-modify-write over the full
 * `UserSettings` (preserving `onboardingCompleted` and any other fields).
 *
 * Default is ON (the SDK default — only an explicit stored `false` disables the
 * trailer), so a brand-new user with no settings row (`settings: null`) shows the
 * toggle enabled. The save mutation optimistically updates the cache, so the switch
 * flips instantly and stays put.
 */

import { useCallback } from 'react';
import type { UserSettings } from '@vgit2/shared/types';

import { useSaveUserSettings, useUserSettings } from '../../../api/hooks';

export interface CommitsViewModel {
  /** Whether commits made by the agent include the AI co-author trailer (default ON). */
  includeCoAuthoredBy: boolean;
  /** Initial settings load is in flight (no cached value yet). */
  loading: boolean;
  /** Persist the toggle (full read-modify-write over UserSettings). */
  setIncludeCoAuthoredBy: (value: boolean) => void;
}

export function useCommitsViewModel(): CommitsViewModel {
  const query = useUserSettings({ retry: false });
  const save = useSaveUserSettings();

  const current = query.data?.settings ?? null;
  // Default ON: only an explicit `false` disables the trailer.
  const includeCoAuthoredBy = current?.includeCoAuthoredBy !== false;

  const setIncludeCoAuthoredBy = useCallback(
    (value: boolean) => {
      const next: UserSettings = {
        // Preserve onboarding state (and anything else already stored); `value` wins.
        onboardingCompleted: current?.onboardingCompleted ?? false,
        ...current,
        includeCoAuthoredBy: value,
      };
      save.mutate(next);
    },
    [current, save]
  );

  return {
    includeCoAuthoredBy,
    loading: query.isPending,
    setIncludeCoAuthoredBy,
  };
}
