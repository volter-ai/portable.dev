/**
 * useCommit — commit the staged changes (portable.dev#17).
 *
 * A single `useMutation` over the isolated source-control factory:
 *   commit → `POST /api/source-control/:o/:r/commit`  body { message }
 *
 * The commit is authored SERVER-SIDE as the user's GitHub login (resolved via the
 * connections service; the client never sends an author). On success it
 * invalidates BOTH the {@link queryKeys.workingTreeChanges} status read (the
 * staged group empties) AND the {@link queryKeys.commitGraph} graph (the new
 * commit appears at HEAD) — the AC's "invalidates status + graph".
 *
 * Commit is a MAIN-CHECKOUT operation only (the backend `commit` takes no
 * worktree), so this hook is not worktree-scoped.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { CommitResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseCommit {
  /** Commit the staged changes with `message` (trimmed; no-op when blank). */
  commit: (message: string) => void;
  /** Async variant resolving with the CommitResponse (or rejecting). */
  commitAsync: (message: string) => Promise<CommitResponse>;
  /** A commit round-trip is in flight. */
  isPending: boolean;
  /** The last commit failed (e.g. nothing staged / git error). */
  isError: boolean;
}

export function useCommit(owner: string, repo: string): UseCommit {
  const api = useApi();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (message: string) =>
      api.post<CommitResponse>(`/api/source-control/${owner}/${repo}/commit`, { message }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workingTreeChanges(owner, repo),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.commitGraph(owner, repo),
      });
      // Also refresh the lightweight git-status counters (the Overview bar + the
      // chat-chrome pill) — a commit changes ahead/behind + clears the staged set.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.gitStatus(owner, repo),
      });
    },
  });

  const commit = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (trimmed.length > 0) mutation.mutate(trimmed);
    },
    [mutation]
  );

  const commitAsync = useCallback(
    (message: string) => mutation.mutateAsync(message.trim()),
    [mutation]
  );

  return useMemo(
    () => ({ commit, commitAsync, isPending: mutation.isPending, isError: mutation.isError }),
    [commit, commitAsync, mutation.isPending, mutation.isError]
  );
}
