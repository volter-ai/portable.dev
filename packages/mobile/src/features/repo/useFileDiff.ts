/**
 * useFileDiff — the source-control per-file diff ViewModel (portable.dev#17).
 *
 * MVVM ViewModel-as-hook over `GET /api/source-control/:owner/:repo/file-diff?
 * path=<p>&staged=0|1` (the isolated source-control factory). `staged=1` diffs
 * the index against HEAD; otherwise the worktree against the index — the same
 * `staged` flag the changed-file row carried into the diff screen. Feeds the
 * shared {@link UnifiedDiffView} on the {@link FileDiffScreen}.
 *
 * `retry: false` (story AC parity with {@link useWorkingTreeChanges}): a path
 * that has no diff is a normal empty `200`, and a real failure should surface
 * immediately.
 *
 * `staleTime: 0` — the diff screen is a pushed route (a fresh mount per visit)
 * and the PC edits files out-of-band, so re-opening a file always re-reads its
 * diff instead of trusting the cached one.
 */

import { useQuery } from '@tanstack/react-query';

import type { GetFileDiffResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseFileDiff {
  /** The unified-diff string (empty string until loaded / when there is no diff). */
  diff: string;
  path: string;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useFileDiff(
  owner: string,
  repo: string,
  filePath: string,
  staged: boolean,
  /**
   * Optional worktree path — scopes the diff to a non-main worktree via
   * `?worktree=` and keys it apart from the main checkout's diff; omitted → the
   * main checkout.
   */
  worktree?: string
): UseFileDiff {
  const api = useApi();
  const enabled = !!owner && !!repo && !!filePath;

  const query = useQuery({
    queryKey: queryKeys.sourceControlFileDiff(owner, repo, filePath, staged, worktree),
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: () =>
      api.get<GetFileDiffResponse>(
        `/api/source-control/${owner}/${repo}/file-diff?path=${encodeURIComponent(filePath)}&staged=${
          staged ? '1' : '0'
        }${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}`
      ),
  });

  return {
    diff: query.data?.diff ?? '',
    path: query.data?.path ?? filePath,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
