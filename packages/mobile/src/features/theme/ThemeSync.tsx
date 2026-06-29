/**
 * ThemeSync — hydrates the native `themeStore` from the user's server theme
 * (`GET /api/user/theme`) once per cold start, so a theme persisted server-side
 * shows up on the RN client too. Server-wins on load;
 * a later LOCAL theme change is NOT overwritten
 * (the effect only fires when the fetched config changes, i.e. once).
 *
 * Renders `null`. Mounted inside `ApiProvider` by the app-shell. Any failure
 * (no endpoint / offline / 404 — a brand-new user with no saved theme) degrades
 * silently to the local default (paper/orange).
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useApi } from '../api/ApiProvider';
import { useThemeStore } from '../state/themeStore';

import type { ThemeOptions } from '@vgit2/shared/types';

interface UserThemeResponse {
  themeConfig?: Partial<ThemeOptions> | null;
}

export function ThemeSync() {
  const api = useApi();
  const setTheme = useThemeStore((s) => s.setTheme);

  const { data } = useQuery({
    queryKey: ['user-theme'],
    queryFn: () => api.get<UserThemeResponse>('/api/user/theme'),
    retry: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    const cfg = data?.themeConfig;
    if (cfg && typeof cfg === 'object' && Object.keys(cfg).length > 0) {
      setTheme(cfg);
    }
  }, [data, setTheme]);

  return null;
}
