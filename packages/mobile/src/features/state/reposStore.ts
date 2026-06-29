/**
 * Repos slice — client state.
 *
 * The repo LIST itself is server state owned by TanStack Query; this
 * slice holds the lightweight preloaded-cache pointers (in-memory, NOT persisted)
 * plus the durable UI preferences (search query + language filter) which DO
 * persist via the MMKV adapter — the "UI prefs" half of the persistence split.
 */

import type { Repository } from '@vgit2/shared/types';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from './storage';

export interface ReposState {
  // Preloaded cache (in-memory; re-fetched on launch) — NOT persisted.
  preloadedRepos: Repository[] | null;
  hasMore: boolean;
  totalCount: number | undefined;

  // Durable UI preferences — persisted to MMKV.
  searchQuery: string;
  languageFilter: string | null;

  setPreloadedRepos: (repos: Repository[] | null) => void;
  setHasMore: (hasMore: boolean) => void;
  setTotalCount: (count: number | undefined) => void;
  setSearchQuery: (query: string) => void;
  setLanguageFilter: (language: string | null) => void;
  /** Reset cache + UI prefs back to defaults (sign-out — `forceSignOut`). */
  reset: () => void;
}

/** MMKV persist key for the repos UI prefs. */
export const REPOS_PERSIST_KEY = 'portable.repos';

export const useReposStore = create<ReposState>()(
  persist(
    (set) => ({
      preloadedRepos: null,
      hasMore: false,
      totalCount: undefined,
      searchQuery: '',
      languageFilter: null,

      setPreloadedRepos: (preloadedRepos) => set({ preloadedRepos }),
      setHasMore: (hasMore) => set({ hasMore }),
      setTotalCount: (totalCount) => set({ totalCount }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setLanguageFilter: (languageFilter) => set({ languageFilter }),
      reset: () =>
        set({
          preloadedRepos: null,
          hasMore: false,
          totalCount: undefined,
          searchQuery: '',
          languageFilter: null,
        }),
    }),
    {
      name: REPOS_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
      // Server cache stays in memory; only the UI prefs are durable.
      partialize: (state) => ({
        searchQuery: state.searchQuery,
        languageFilter: state.languageFilter,
      }),
    }
  )
);
