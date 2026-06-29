/**
 * useTasks — the Tasks page ViewModel.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer.
 * Uses a "cached first, then background refresh" model with one
 * query PER VIEW (`my` + `all`, both mounted in parallel, so tab
 * switching is instant):
 *
 *   - initial load        → `GET /api/user/tasks/cached?view=<v>`  (instant)
 *   - after it resolves   → `GET /api/user/tasks/refresh?view=<v>` (background,
 *     replaces the cache via `setQueryData`)
 *   - every tab RE-focus  → `/refresh` for both views (navigating
 *     onto /tasks always force-refreshes; the lazy tab screen stays mounted,
 *     so a `useFocusEffect` re-kick drives the refresh)
 *   - pull-to-refresh     → `/refresh` again for the ACTIVE view
 *
 * A refresh failure keeps the last-known data (`/refresh` can
 * bubble raw GitHub rate-limit errors — degrade, never wipe). The
 * `blockedOrgs` query param is NOT sent: there is no mobile counterpart for it
 * yet, and the endpoint treats the missing param as "no orgs blocked".
 *
 * Filter state is plain component state (the RN screen stays mounted in the tab
 * navigator, so the filters persist for the session lifetime). Owner + backlog
 * deliberately survive `clearFilters`.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { Linking } from 'react-native';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

import {
  countBacklog,
  deriveFilterOptions,
  groupTasks,
  hasActiveTaskFilters,
  type GroupedTasks,
  type TaskFilterSelectOptions,
  type TaskFilters,
  type TaskStateFilter,
} from './taskHelpers';
import type { TasksResponse, TasksView } from './types';

export interface UseTasksOptions {
  /** Seam for opening issue/PR pages (default: the system browser via `Linking`). */
  openUrl?: (url: string) => void;
  /** Clock seam for the grouping pipeline (default `Date.now`) — deterministic tests. */
  now?: () => number;
}

export interface UseTasks {
  view: TasksView;
  setView: (view: TasksView) => void;

  grouped: GroupedTasks;
  filterOptions: TaskFilterSelectOptions;
  backlogCount: number;

  /**
   * No data for the active view yet (initial `/cached` in flight — or PAUSED
   * offline: TanStack v5 `isPending`, so an offline cold-start shows the
   * spinner, never a false "No tasks to show").
   */
  isLoading: boolean;
  /** The active view's `/cached` load failed and there is no data to show. */
  isError: boolean;
  /** A `/refresh` for the active view is in flight (background or pull). */
  refreshing: boolean;
  /** The displayed payload came from the server cache (and no refresh runs). */
  fromCache: boolean;
  /**
   * The user has NO repositories cloned in their sandbox — the
   * screen shows a "clone a repo" guidance state instead of the generic empty
   * state. Reflects the active view's payload.
   */
  noLocalRepos: boolean;

  filters: TaskFilters;
  hasActiveFilters: boolean;
  showFilters: boolean;
  setShowFilters: (show: boolean) => void;
  setOwnerFilter: (owner: string) => void;
  toggleBacklog: () => void;
  setStateFilter: (state: TaskStateFilter) => void;
  setRepoFilter: (repo: string) => void;
  toggleLabel: (label: string) => void;
  setAssigneeFilter: (assignee: string) => void;
  /** Resets state/repo/labels/assignee — NOT owner or backlog. */
  clearFilters: () => void;

  /** Force `/refresh` on the active view (awaitable — the pull spinner needs it). */
  refresh: () => Promise<void>;
  /** Error-state retry: re-fetch `/cached`, then kick a background refresh. */
  retry: () => void;
  /** Open an issue/PR page (the `openUrl` seam). */
  openItem: (url: string) => void;
}

function tasksPath(kind: 'cached' | 'refresh', view: TasksView): string {
  return `/api/user/tasks/${kind}?view=${view}`;
}

interface TasksViewState {
  data: TasksResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  retry: () => void;
}

/** One view's cached-then-refresh pipeline. */
function useTasksView(view: TasksView): TasksViewState {
  const api = useApi();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  // `retry: false`: a failure here is a state (the error screen), not a
  // transient; `staleTime: Infinity`: the background `/refresh` below owns
  // freshness, so React Query must never re-fetch `/cached` on its own.
  const query = useQuery({
    queryKey: queryKeys.userTasks(view),
    queryFn: () => api.get<TasksResponse>(tasksPath('cached', view)),
    retry: false,
    staleTime: Infinity,
  });

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const fresh = await api.get<TasksResponse>(tasksPath('refresh', view));
      queryClient.setQueryData(queryKeys.userTasks(view), fresh);
    } catch {
      // Keep the last-known data (/refresh bubbles raw GitHub
      // rate-limit errors — degraded data beats an error wall).
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [api, queryClient, view]);

  // Landing on /tasks always follows the cached load with a forced
  // background refresh — kicked exactly once per mount, after `/cached` lands.
  const kickedRef = useRef(false);
  useEffect(() => {
    if (!query.isSuccess || kickedRef.current) return;
    kickedRef.current = true;
    void refresh();
  }, [query.isSuccess, refresh]);

  const retry = useCallback(() => {
    void query.refetch().then((result) => {
      if (result.data) void refresh();
    });
  }, [query, refresh]);

  return {
    data: query.data,
    // v5 `isPending` (not `isLoading`) so a PAUSED offline first load (networkMode
    // 'online') still reads as loading instead of falling through to the empty state.
    isLoading: query.isPending,
    isError: query.isError,
    refreshing,
    refresh,
    retry,
  };
}

export function useTasks(options: UseTasksOptions = {}): UseTasks {
  const openUrl = options.openUrl ?? ((url: string) => void Linking.openURL(url));
  const now = options.now ?? Date.now;
  const [view, setView] = useState<TasksView>('my');

  // Both views load in parallel → instant tab switch.
  const my = useTasksView('my');
  const all = useTasksView('all');
  const active = view === 'my' ? my : all;

  // Every NAVIGATION onto /tasks force-refreshes both views. The
  // lazy bottom-tab screen mounts once and stays mounted, so the per-mount kick
  // in useTasksView only covers the FIRST visit — re-kick on every re-focus.
  // (First focus === mount for a lazy tab; skip it, the post-cached kick owns it.)
  const myRefresh = my.refresh;
  const allRefresh = all.refresh;
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      void myRefresh();
      void allRefresh();
    }, [myRefresh, allRefresh])
  );

  const [ownerFilter, setOwnerFilter] = useState('all');
  const [showBacklog, setShowBacklog] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [stateFilter, setStateFilter] = useState<TaskStateFilter>('open');
  const [repoFilter, setRepoFilter] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState('');

  const filters: TaskFilters = useMemo(
    () => ({ ownerFilter, showBacklog, stateFilter, repoFilter, selectedLabels, assigneeFilter }),
    [ownerFilter, showBacklog, stateFilter, repoFilter, selectedLabels, assigneeFilter]
  );

  const grouped = useMemo(
    () => groupTasks(active.data, view, filters, now()),
    [active.data, view, filters, now]
  );
  const filterOptions = useMemo(() => deriveFilterOptions(active.data), [active.data]);
  const backlogCount = useMemo(
    () => countBacklog(active.data, ownerFilter),
    [active.data, ownerFilter]
  );

  const toggleBacklog = useCallback(() => setShowBacklog((b) => !b), []);
  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    );
  }, []);
  const clearFilters = useCallback(() => {
    setStateFilter('open');
    setRepoFilter('');
    setSelectedLabels([]);
    setAssigneeFilter('');
  }, []);

  return {
    view,
    setView,
    grouped,
    filterOptions,
    backlogCount,
    isLoading: active.isLoading,
    isError: active.isError,
    refreshing: active.refreshing,
    fromCache: !!active.data?.cached && !active.refreshing,
    noLocalRepos: !!active.data?.noLocalRepos,
    filters,
    hasActiveFilters: hasActiveTaskFilters(filters),
    showFilters,
    setShowFilters,
    setOwnerFilter,
    toggleBacklog,
    setStateFilter,
    setRepoFilter,
    toggleLabel,
    setAssigneeFilter,
    clearFilters,
    refresh: active.refresh,
    retry: active.retry,
    openItem: openUrl,
  };
}
