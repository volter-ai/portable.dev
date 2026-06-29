/**
 * useRepoDirectory — paginated repository list + search/language filter.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The repo
 * list is server state, so it lives in `useInfiniteQuery` (NOT Zustand) — paginated
 * via infinite scroll. Three backend endpoints implement the
 * "show cached fast, then refresh" model:
 *
 *   - page 1, normal load  → `GET /api/repos/cached`  (instant, served from cache)
 *   - page 2+ (infinite)   → `GET /api/repos`         (the paginated list endpoint)
 *   - pull-to-refresh      → `GET /api/repos/refresh` (force fresh, every loaded page)
 *
 * Search is **debounced** (durable in `reposStore.searchQuery`) and the language filter
 * is applied immediately (`reposStore.languageFilter`); both ride to the backend as query
 * params (server-side narrowing). The RN client NEVER shells out to git — the
 * `isLocal` / `gitStatus` local-clone status comes straight from the backend response.
 *
 * The tab lists BOTH locally-cloned/linked repos AND uncloned remotes (the backend seeds
 * the GitHub account list and enriches each row with `isLocal`/`localStatus`; cloned repos
 * still float to the top). Tapping a CLONED repo opens it; tapping an UNCLONED one CLONES it
 * to the workspace (`POST /api/repos/:owner/:repo/clone`) and then opens it — see {@link
 * UseRepoDirectory.openRepo}.
 */

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CloneRepoResponse, GetReposResponse, RepositoryWithLocal } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import { useBlockedOrgsParam } from '../settings/sections/organizations/blockedOrgsStore';
import { useReposStore } from '../state';

/** Page size for the repo list (the `per_page` query param). */
export const REPOS_PAGE_SIZE = 20;

/** Default debounce for the search box (ms) — injectable for deterministic tests. */
export const REPOS_SEARCH_DEBOUNCE_MS = 400;

/** Sort orders (ride as the `sort=` query param). */
export type RepoSort = 'updated' | 'stars' | 'name';

/** Default sort. */
export const REPOS_DEFAULT_SORT: RepoSort = 'updated';

/**
 * The `/api/repos/cached` response carries an undeclared `cached` flag read
 * for the "Cached" pill — a local superset of the shared type (the
 * established locally-declared-superset pattern).
 */
type ReposPage = GetReposResponse & { cached?: boolean };

export interface UseRepoDirectoryOptions {
  /** Search debounce in ms (default {@link REPOS_SEARCH_DEBOUNCE_MS}). */
  debounceMs?: number;
  /** Navigation seam (default Expo Router's imperative `router.push`). */
  navigate?: (href: string) => void;
}

export interface UseRepoDirectory {
  repos: RepositoryWithLocal[];
  /** Distinct primary languages across the loaded repos (for the filter chips). */
  languages: string[];
  /** Current (undebounced) search-box text. */
  searchInput: string;
  /** Currently-selected language filter (null = all). */
  language: string | null;
  /** Current sort order (updated | stars | name). */
  sort: RepoSort;
  /** Any non-default search/language/sort active (drives the clear-all affordance). */
  hasActiveFilters: boolean;
  /** The rendered page came from the server cache (`/api/repos/cached` flag). */
  isFromCache: boolean;
  totalCount: number | undefined;

  isLoading: boolean;
  isError: boolean;
  /** Loaded successfully but no repos match — distinct from loading/error. */
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  /** Pull-to-refresh in flight (force `/api/repos/refresh`). */
  refreshing: boolean;

  setSearch: (text: string) => void;
  setLanguage: (language: string | null) => void;
  setSort: (sort: RepoSort) => void;
  /** Reset search + language + sort to their defaults ("Clear all filters"). */
  clearFilters: () => void;
  loadMore: () => void;
  refresh: () => void;
  refetch: () => void;
  /**
   * Tap a repo: a CLONED repo opens its Overview page; an UNCLONED remote is first
   * cloned to the workspace (`POST .../clone`), then opened on success.
   */
  openRepo: (repo: RepositoryWithLocal) => void;
  /** The repo currently being cloned via {@link openRepo} (drives the card spinner). */
  cloningRepoId: number | null;
}

/** Endpoint for a given page + force flag (the three-endpoint cached/refresh model). */
function reposPath(page: number, force: boolean): string {
  if (force) return '/api/repos/refresh';
  if (page === 1) return '/api/repos/cached';
  return '/api/repos';
}

/** Build a deterministic, fixed-order query string (so the mock can match it exactly). */
function reposQuery(
  page: number,
  search: string,
  language: string | null,
  sort: RepoSort,
  blockedOrgs?: string
): string {
  const parts = [
    `page=${page}`,
    `per_page=${REPOS_PAGE_SIZE}`,
    `sort=${sort}`,
    `skipGitOperations=true`,
    // NB: NO `localOnly` — the Repos tab lists the full GitHub account list (cloned +
    // uncloned), each row enriched with `isLocal`/`localStatus`. Tapping an uncloned one
    // clones it (openRepo). The Home grid still uses `localOnly` for its workspace-only view.
  ];
  if (search) parts.push(`search=${encodeURIComponent(search)}`);
  if (language) parts.push(`language=${encodeURIComponent(language)}`);
  if (blockedOrgs) parts.push(`blockedOrgs=${encodeURIComponent(blockedOrgs)}`);
  return parts.join('&');
}

export function useRepoDirectory(options: UseRepoDirectoryOptions = {}): UseRepoDirectory {
  const debounceMs = options.debounceMs ?? REPOS_SEARCH_DEBOUNCE_MS;
  const navigate = options.navigate ?? ((href: string) => router.push(href));
  const api = useApi();
  const queryClient = useQueryClient();

  // Durable UI prefs (MMKV) — the committed search + the language filter.
  const committedSearch = useReposStore((s) => s.searchQuery);
  const setCommittedSearch = useReposStore((s) => s.setSearchQuery);
  const language = useReposStore((s) => s.languageFilter);
  const setStoreLanguage = useReposStore((s) => s.setLanguageFilter);

  // The text field is local + debounced into the durable committed value.
  const [searchInput, setSearchInput] = useState(committedSearch);
  useEffect(() => {
    const handle = setTimeout(() => setCommittedSearch(searchInput), debounceMs);
    return () => clearTimeout(handle);
  }, [searchInput, debounceMs, setCommittedSearch]);

  // Sort is ephemeral page state (deliberately never persisted).
  const [sort, setSort] = useState<RepoSort>(REPOS_DEFAULT_SORT);

  // `force` flips on for a pull-to-refresh so every (re)fetched page hits /refresh.
  const forceRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  // Hide repos owned by orgs the user blocked in Settings → Organizations
  // (server-side filter; empty blocklist omits the param so the key/URL are
  // unchanged). Reactive — toggling an org refetches the list.
  const blockedOrgs = useBlockedOrgsParam();

  const query = useInfiniteQuery({
    queryKey: queryKeys.repos({
      search: committedSearch || undefined,
      language: language || undefined,
      sort,
      skipGitOperations: 'true',
      blockedOrgs,
    }),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.get<ReposPage>(
        `${reposPath(pageParam, forceRef.current)}?${reposQuery(
          pageParam,
          committedSearch,
          language,
          sort,
          blockedOrgs
        )}`
      ),
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? (lastPageParam as number) + 1 : undefined,
  });

  const repos = query.data?.pages.flatMap((p) => p.repos) ?? [];
  const totalCount = query.data?.pages.at(-1)?.total_count;
  const isFromCache = !!query.data?.pages.at(-1)?.cached;
  const languages = Array.from(
    new Set(repos.map((r) => r.language).filter((l): l is string => !!l))
  );

  const setSearch = useCallback((text: string) => setSearchInput(text), []);
  const setLanguage = useCallback(
    (lang: string | null) => setStoreLanguage(lang),
    [setStoreLanguage]
  );

  const clearFilters = useCallback(() => {
    setSearchInput('');
    setCommittedSearch('');
    setStoreLanguage(null);
    setSort(REPOS_DEFAULT_SORT);
  }, [setCommittedSearch, setStoreLanguage]);

  const refresh = useCallback(() => {
    forceRef.current = true;
    setRefreshing(true);
    void query.refetch().finally(() => {
      forceRef.current = false;
      setRefreshing(false);
    });
  }, [query]);

  // Clone an uncloned remote to the workspace on tap, then open it. One at a time;
  // `cloningRepoId` drives the per-card spinner. On success we invalidate the repos
  // caches so the row flips to "Cloned" (prefix match — the ChatComposer precedent).
  const [cloningRepoId, setCloningRepoId] = useState<number | null>(null);
  const cloneMutation = useMutation({
    mutationFn: (repo: RepositoryWithLocal) =>
      api.post<CloneRepoResponse>(`/api/repos/${repo.owner.login}/${repo.name}/clone`, {}),
  });

  const openRepo = useCallback(
    (repo: RepositoryWithLocal) => {
      const href = `/repos/${repo.owner.login}/${repo.name}`;
      const cloned = repo.isLocal || repo.localStatus === 'cloned';
      if (cloned) {
        navigate(href);
        return;
      }
      // Uncloned remote → clone to the workspace, then open. Ignore taps while a
      // clone is already in flight.
      if (cloningRepoId !== null) return;
      setCloningRepoId(repo.id);
      cloneMutation.mutate(repo, {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['repos'] });
          void queryClient.invalidateQueries({ queryKey: ['recent-projects'] });
          navigate(href);
        },
        onSettled: () => setCloningRepoId(null),
      });
    },
    [navigate, cloneMutation, cloningRepoId, queryClient]
  );

  return {
    repos,
    languages,
    searchInput,
    language,
    sort,
    hasActiveFilters: !!searchInput || !!language || sort !== REPOS_DEFAULT_SORT,
    isFromCache,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && repos.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    refreshing,
    setSearch,
    setLanguage,
    setSort,
    clearFilters,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refresh,
    refetch: () => void query.refetch(),
    openRepo,
    cloningRepoId,
  };
}
