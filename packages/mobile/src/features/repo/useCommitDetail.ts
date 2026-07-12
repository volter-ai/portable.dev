/**
 * useCommitDetail — the source-control commit-detail ViewModel (portable.dev#17).
 *
 * MVVM ViewModel-as-hook over `GET /api/source-control/:owner/:repo/commit/:sha`
 * (the isolated source-control factory) → `{ sha, files, diff, stats }`. The
 * changed-file list drives the commit-detail screen; tapping a file expands its
 * slice of the commit's unified `diff` in a {@link UnifiedDiffView}.
 *
 * `retry: false` (AC parity): a bad sha 400s deterministically, a real failure
 * surfaces immediately.
 */

import { useQuery } from '@tanstack/react-query';

import type { ChangedFile, GetCommitDetailResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

export interface UseCommitDetail {
  sha: string;
  files: ChangedFile[];
  diff: string;
  stats?: { additions: number; deletions: number };
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useCommitDetail(owner: string, repo: string, sha: string): UseCommitDetail {
  const api = useApi();
  const enabled = !!owner && !!repo && !!sha;

  const query = useQuery({
    queryKey: queryKeys.commitDetail(owner, repo, sha),
    enabled,
    retry: false,
    queryFn: () =>
      api.get<GetCommitDetailResponse>(`/api/source-control/${owner}/${repo}/commit/${sha}`),
  });

  return {
    sha: query.data?.sha ?? sha,
    files: query.data?.files ?? [],
    diff: query.data?.diff ?? '',
    stats: query.data?.stats,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/**
 * Split a commit's unified diff into per-file patch slices, keyed by the file's
 * new path (the `b/<path>` side of the `diff --git` header). Pure helper so the
 * commit-detail screen can show each changed file's own diff without a separate
 * per-file endpoint.
 */
export function splitDiffByFile(diff: string): Record<string, string> {
  const byPath: Record<string, string> = {};
  if (!diff) return byPath;

  let currentPath: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentPath !== null) byPath[currentPath] = buffer.join('\n');
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = pathFromGitHeader(line);
      buffer = [line];
    } else if (currentPath !== null) {
      buffer.push(line);
    }
  }
  flush();
  return byPath;
}

/** Extract the new path from a `diff --git a/<old> b/<new>` header line. */
function pathFromGitHeader(header: string): string {
  const match = header.match(/ b\/(.+)$/);
  return match ? match[1] : header;
}
