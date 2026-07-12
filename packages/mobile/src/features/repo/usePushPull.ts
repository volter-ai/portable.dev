/**
 * usePushPull — push / pull the local branch against its remote (portable.dev#17).
 *
 * Two `useMutation`s over the isolated source-control factory:
 *   push → `POST /api/source-control/:o/:r/push`  body { branch?, setUpstream?, worktree? }
 *   pull → `POST /api/source-control/:o/:r/pull`  body { worktree? }
 *
 * Both authenticate as the user's GitHub identity SERVER-SIDE (the route resolves
 * the token via authService.getGitHubToken; the client never sends it). On success
 * each invalidates BOTH the {@link queryKeys.workingTreeChanges} status read (the
 * ahead/behind counters change — the base key prefix-matches every worktree-scoped
 * variant too) AND the {@link queryKeys.commitGraph} graph (a pull can land new
 * commits) — the AC's "mutation invalidates status + graph".
 *
 * The optional `worktree` scopes both operations to a linked git worktree (a
 * fresh worktree branch is auto-published — the backend runs
 * `push --set-upstream origin <branch>` when no upstream exists). A pull that
 * stops on merge conflicts resolves NORMALLY with `{ pulled: false,
 * conflicts: true }`; the invalidated status read then reports the Conflicts
 * group and the header blocks Push until they are resolved.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { PullResponse, PushResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UsePushPullOptions {
  /** Scope push/pull to a linked git worktree (omitted → the main checkout). */
  worktree?: string;
}

export interface UsePushPull {
  /** Push the current branch to its remote. */
  push: () => void;
  /** Async variant resolving with the PushResponse (or rejecting). */
  pushAsync: () => Promise<PushResponse>;
  /** Pull (fetch + merge) the current branch from its remote. */
  pull: () => void;
  /** Async variant resolving with the PullResponse (or rejecting). */
  pullAsync: () => Promise<PullResponse>;
  /** A push round-trip is in flight. */
  isPushing: boolean;
  /** A pull round-trip is in flight. */
  isPulling: boolean;
  /** The last push or pull failed (e.g. conflict, no GitHub connection, git error). */
  isError: boolean;
  /** The error from the last failed push/pull (for surfacing the message). */
  error: unknown;
  /** The last pull stopped on merge conflicts (`{ pulled: false, conflicts: true }`). */
  pullHadConflicts: boolean;
}

export function usePushPull(
  owner: string,
  repo: string,
  options: UsePushPullOptions = {}
): UsePushPull {
  const api = useApi();
  const queryClient = useQueryClient();
  const worktree = options.worktree;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workingTreeChanges(owner, repo) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.commitGraph(owner, repo) });
    // Refresh the lightweight git-status counters (Overview bar + chat-chrome
    // pill) too — a push/pull changes the ahead/behind numbers.
    void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(owner, repo) });
  }, [queryClient, owner, repo]);

  const pushMutation = useMutation({
    mutationFn: () =>
      api.post<PushResponse>(
        `/api/source-control/${owner}/${repo}/push`,
        worktree ? { worktree } : {}
      ),
    onSuccess: invalidate,
  });

  const pullMutation = useMutation({
    mutationFn: () =>
      api.post<PullResponse>(
        `/api/source-control/${owner}/${repo}/pull`,
        worktree ? { worktree } : {}
      ),
    onSuccess: invalidate,
  });

  const push = useCallback(() => pushMutation.mutate(), [pushMutation]);
  const pushAsync = useCallback(() => pushMutation.mutateAsync(), [pushMutation]);
  const pull = useCallback(() => pullMutation.mutate(), [pullMutation]);
  const pullAsync = useCallback(() => pullMutation.mutateAsync(), [pullMutation]);

  return useMemo(
    () => ({
      push,
      pushAsync,
      pull,
      pullAsync,
      isPushing: pushMutation.isPending,
      isPulling: pullMutation.isPending,
      isError: pushMutation.isError || pullMutation.isError,
      error: pushMutation.error ?? pullMutation.error,
      pullHadConflicts: pullMutation.data?.conflicts === true,
    }),
    [
      push,
      pushAsync,
      pull,
      pullAsync,
      pushMutation.isPending,
      pushMutation.isError,
      pushMutation.error,
      pullMutation.isPending,
      pullMutation.isError,
      pullMutation.error,
      pullMutation.data,
    ]
  );
}
