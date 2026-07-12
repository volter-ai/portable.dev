/**
 * useStageMutations — stage / unstage working-tree paths (portable.dev#17).
 *
 * Two `useMutation`s over the isolated source-control factory:
 *   stage   → `POST /api/source-control/:o/:r/stage`   body { paths, worktree? }
 *   unstage → `POST /api/source-control/:o/:r/unstage`  body { paths, worktree? }
 *
 * On success each invalidates the matching {@link queryKeys.workingTreeChanges}
 * read so the {@link ChangesView} re-fetches and the file hops to its new group
 * (Staged ↔ Unstaged) — the AC's "moves to the Staged group on the next status
 * read". The optional `worktree` scopes both the request body AND the
 * invalidated key, so a worktree-scoped Changes view refreshes only its own
 * read.
 *
 * `pending` exposes the set of paths currently in flight so a row can disable
 * its own action while the round-trip completes (multiple files can be staged
 * concurrently — each mutation tracks its own paths).
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { StageResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseStageMutationsOptions {
  /** Scope the stage/unstage (and the invalidated status key) to a worktree. */
  worktree?: string;
}

export interface UseStageMutations {
  /** Stage the given repo-relative paths (`git add`). */
  stage: (paths: string[]) => void;
  /** Unstage the given repo-relative paths (`git restore --staged`). */
  unstage: (paths: string[]) => void;
  /**
   * Discard the given repo-relative paths (DESTRUCTIVE — `git restore` for
   * tracked files, `git clean -fd` for untracked). The confirmation
   * guard lives in the UI; this just fires the mutation.
   */
  discard: (paths: string[]) => void;
  /** A path is "pending" while any mutation that includes it is in flight. */
  isPending: (path: string) => boolean;
  /** Any stage/unstage/discard round-trip currently in flight. */
  busy: boolean;
}

export function useStageMutations(
  owner: string,
  repo: string,
  options: UseStageMutationsOptions = {}
): UseStageMutations {
  const api = useApi();
  const queryClient = useQueryClient();
  const worktree = options.worktree;

  // Paths currently in flight (stage or unstage), so rows can disable themselves.
  const [pending, setPending] = useState<Set<string>>(new Set());

  const invalidateStatus = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workingTreeChanges(owner, repo, worktree),
    });
    // Keep the lightweight git-status counters (Overview bar + chat-chrome pill)
    // in sync — staging/unstaging/discarding shifts the staged/unstaged totals.
    void queryClient.invalidateQueries({
      queryKey: queryKeys.gitStatus(owner, repo),
    });
  }, [queryClient, owner, repo, worktree]);

  const addPending = useCallback((paths: string[]) => {
    setPending((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => next.add(p));
      return next;
    });
  }, []);

  const removePending = useCallback((paths: string[]) => {
    setPending((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => next.delete(p));
      return next;
    });
  }, []);

  const run = useCallback(
    (endpoint: 'stage' | 'unstage' | 'discard', paths: string[]) =>
      api.post<StageResponse>(`/api/source-control/${owner}/${repo}/${endpoint}`, {
        paths,
        ...(worktree ? { worktree } : {}),
      }),
    [api, owner, repo, worktree]
  );

  const stageMutation = useMutation({
    mutationFn: (paths: string[]) => run('stage', paths),
    onMutate: (paths: string[]) => addPending(paths),
    onSettled: (_data, _err, paths) => removePending(paths),
    onSuccess: invalidateStatus,
  });

  const unstageMutation = useMutation({
    mutationFn: (paths: string[]) => run('unstage', paths),
    onMutate: (paths: string[]) => addPending(paths),
    onSettled: (_data, _err, paths) => removePending(paths),
    onSuccess: invalidateStatus,
  });

  const discardMutation = useMutation({
    mutationFn: (paths: string[]) => run('discard', paths),
    onMutate: (paths: string[]) => addPending(paths),
    onSettled: (_data, _err, paths) => removePending(paths),
    onSuccess: invalidateStatus,
  });

  const stage = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) stageMutation.mutate(paths);
    },
    [stageMutation]
  );

  const unstage = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) unstageMutation.mutate(paths);
    },
    [unstageMutation]
  );

  const discard = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) discardMutation.mutate(paths);
    },
    [discardMutation]
  );

  const isPending = useCallback((path: string) => pending.has(path), [pending]);

  return useMemo(
    () => ({ stage, unstage, discard, isPending, busy: pending.size > 0 }),
    [stage, unstage, discard, isPending, pending.size]
  );
}
