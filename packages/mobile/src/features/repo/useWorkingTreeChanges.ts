/**
 * useWorkingTreeChanges — the source-control Changes ViewModel (portable.dev#17).
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer:
 * server state → `useQuery` over `GET /api/source-control/:owner/:repo/status`
 * (the isolated source-control factory, NOT the existing git routes). Surfaces
 * the four working-tree groups (Conflicts / Staged / Unstaged / Untracked) plus
 * the branch name and ahead/behind counters that the {@link ChangesView}
 * renders.
 *
 * `retry: false` (per the story AC) — a clean tree is a normal `200` with empty
 * groups, so there is nothing to retry; a real failure should surface as an
 * error immediately rather than after backoff. The query is gated behind an
 * `enabled` flag so the SourceControlTab only fetches when the Changes segment
 * is active (the default Graph segment must not pay for a status read).
 *
 * `staleTime: 0` (the OverviewTab chat-preview precedent) — the PC mutates the
 * working tree out-of-band with no socket signal, so every remount / worktree
 * re-scope refetches in the background instead of trusting a cached status.
 */

import { useQuery } from '@tanstack/react-query';

import type { ChangedFile, GetWorkingTreeChangesResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseWorkingTreeChangesOptions {
  /** Gate the status read (default `true`). The tab passes `segment === 'changes'`. */
  enabled?: boolean;
  /**
   * Optional worktree path to scope the status to (Worktrees tab). When
   * provided it rides as `?worktree=` and keys the query apart from the main
   * checkout's changes; omitted → the main checkout.
   */
  worktree?: string;
}

export interface UseWorkingTreeChanges {
  branch: string;
  ahead: number;
  behind: number;
  conflicted: ChangedFile[];
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  /** Total changed-file rows across all four groups (virtualization-proof count). */
  totalCount: number;
  isLoading: boolean;
  isError: boolean;
  /** Loaded successfully AND the working tree is clean (no rows in any group). */
  isEmpty: boolean;
  /** Awaitable refetch (backs the pull-to-refresh spinner). */
  refetch: () => Promise<void>;
}

export function useWorkingTreeChanges(
  owner: string,
  repo: string,
  options: UseWorkingTreeChangesOptions = {}
): UseWorkingTreeChanges {
  const api = useApi();
  const enabled = (options.enabled ?? true) && !!owner && !!repo;
  const worktree = options.worktree;

  const query = useQuery({
    queryKey: queryKeys.workingTreeChanges(owner, repo, worktree),
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: () =>
      api.get<GetWorkingTreeChangesResponse>(
        `/api/source-control/${owner}/${repo}/status${
          worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''
        }`
      ),
  });

  const data = query.data;
  const conflicted = data?.conflicted ?? [];
  const staged = data?.staged ?? [];
  const unstaged = data?.unstaged ?? [];
  const untracked = data?.untracked ?? [];
  const totalCount = conflicted.length + staged.length + unstaged.length + untracked.length;

  return {
    branch: data?.branch ?? '',
    ahead: data?.ahead ?? 0,
    behind: data?.behind ?? 0,
    conflicted,
    staged,
    unstaged,
    untracked,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: query.isSuccess && totalCount === 0,
    refetch: async () => {
      await query.refetch();
    },
  };
}
