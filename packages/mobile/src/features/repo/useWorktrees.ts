/**
 * useWorktrees — the Worktrees-tab ViewModel (portable.dev#17).
 *
 * MVVM ViewModel-as-hook over `GET /api/source-control/:owner/:repo/worktrees`
 * (the isolated source-control factory). Surfaces the repo's git worktrees as a
 * READ-ONLY list (worktree mutation is deferred to a follow-up). Each entry
 * is a shared {@link Worktree} (path / HEAD short-sha / branch / main/locked/
 * prunable/bare flags) the {@link WorktreesView} renders.
 *
 * `retry: false` — a repo always has at least the main worktree, so an empty
 * `worktrees` array is a real (degenerate) answer, not something to retry; a
 * genuine failure should surface immediately. Gated behind an `enabled` flag so
 * the tab only fetches once the clone-first gate passes.
 *
 * `staleTime: 0` (the OverviewTab chat-preview precedent) — worktrees are
 * added/removed on the PC out-of-band with no socket signal, so every remount
 * refetches in the background instead of trusting a cached list.
 */

import { useQuery } from '@tanstack/react-query';

import type { GetWorktreesResponse, Worktree } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseWorktreesOptions {
  /** Gate the worktrees read (default `true`). The tab passes the clone-gate result. */
  enabled?: boolean;
}

export interface UseWorktrees {
  worktrees: Worktree[];
  /** Total worktree count (virtualization-proof — the hidden count testID source). */
  totalCount: number;
  /**
   * Loaded successfully AND only the main worktree exists (the honest single-entry
   * state — "No additional worktrees yet"). Distinct from `worktrees.length === 0`
   * (an unexpected empty list).
   */
  isOnlyMain: boolean;
  isLoading: boolean;
  isError: boolean;
  /** Loaded successfully AND the list is empty (degenerate — no worktrees at all). */
  isEmpty: boolean;
  /** Awaitable refetch (backs the pull-to-refresh spinner + the switcher re-kick). */
  refetch: () => Promise<void>;
}

export function useWorktrees(
  owner: string,
  repo: string,
  options: UseWorktreesOptions = {}
): UseWorktrees {
  const api = useApi();
  const enabled = (options.enabled ?? true) && !!owner && !!repo;

  const query = useQuery({
    queryKey: queryKeys.worktrees(owner, repo),
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: () => api.get<GetWorktreesResponse>(`/api/source-control/${owner}/${repo}/worktrees`),
  });

  const worktrees = query.data?.worktrees ?? [];
  const totalCount = worktrees.length;

  return {
    worktrees,
    totalCount,
    isOnlyMain: query.isSuccess && totalCount === 1,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: query.isSuccess && totalCount === 0,
    refetch: async () => {
      await query.refetch();
    },
  };
}
