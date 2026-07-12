/**
 * Source-control freshness utilities (portable.dev#17).
 *
 * The PC is the source of truth and mutates the repo out-of-band (terminal
 * commits, chats, other surfaces) with NO socket signal, so the phone's cached
 * source-control reads go stale silently. Three complementary mechanisms keep
 * them honest:
 *
 *  1. `staleTime: 0` on every source-control read (the OverviewTab chat-preview
 *     precedent) — the inner repo tabs UNMOUNT on tab switch and the worktree
 *     switcher changes the query key, so every remount / re-scope refetches in
 *     the background while showing the cached data;
 *  2. {@link usePullToRefresh} — the explicit pull-to-refresh gesture on each
 *     source-control list (Changes / Worktrees / Graph);
 *  3. {@link useSourceControlFocusRefresh} — re-kicks the ACTIVE source-control
 *     queries when the repo ROUTE regains focus (returning from the pushed
 *     diff / commit-detail screens, which don't remount the repo page). It is
 *     called from the ROUTE SHELL: the inner tabs have no navigator under test
 *     (the chatListPolling precedent), and the route is the only always-mounted
 *     navigation-aware layer.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { queryKeys } from '../api/keys';

export interface PullToRefresh {
  /** Drive the `RefreshControl` spinner (local gesture state — NOT the query's
   * background `isRefetching`, which would pop the spinner on focus re-kicks). */
  refreshing: boolean;
  onRefresh: () => void;
}

/** Local spinner state for a pull-to-refresh gesture over an awaitable refetch. */
export function usePullToRefresh(refetch: () => Promise<void>): PullToRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);
  return { refreshing, onRefresh };
}

/**
 * Invalidate the repo's source-control reads whenever the repo route REGAINS
 * focus. The first focus is the route's own mount — the queries fetch on mount
 * (and `staleTime: 0` covers remounts), so only a RE-focus needs the kick.
 *
 * The status key is a PREFIX — it matches the main checkout AND every
 * worktree-scoped variant. `refetchType` stays the default (`'active'`), so an
 * invalidation only refetches queries a mounted screen is actually observing;
 * everything else is just marked stale for its next mount.
 */
export function useSourceControlFocusRefresh(owner: string, repo: string): void {
  const queryClient = useQueryClient();
  const firstFocusRef = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (!owner || !repo) return;
      const prefixes: readonly (readonly unknown[])[] = [
        queryKeys.workingTreeChanges(owner, repo),
        queryKeys.worktrees(owner, repo),
        queryKeys.commitGraph(owner, repo),
        queryKeys.gitStatus(owner, repo),
      ];
      for (const queryKey of prefixes) {
        // cancelRefetch: false — never restart a fetch already in flight.
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      }
    }, [owner, repo, queryClient])
  );
}
