/**
 * useRepoPull — single pull-request detail.
 *
 * MVVM ViewModel-as-hook. The detail is server state → `useQuery` over
 * `GET /api/repos/:owner/:repo/pulls/:number`, which returns the PR PLUS
 * `timeline` + `files` (the shared `GetPullResponse` is `{ pull }`-only and lies
 * about this endpoint — the backend keys it `pr`, same loose-shared-type pattern
 * as the issue detail). Read-only: PR mutations (review-request, merge) are not
 * supported here.
 */

import { useQuery } from '@tanstack/react-query';

import type { PullRequest } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import type { IssueComment, IssueTimelineEntry } from './useRepoIssue';

/** A changed file in the PR (subset of the GitHub files payload we render). */
export interface PullFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  /** Unified diff hunk (absent for binary/huge files) — the task viewer renders it. */
  patch?: string;
}

/** Sandbox `/pulls/:number` response (superset of shared `GetPullResponse`). */
interface PullDetailResponse {
  pr: PullRequest;
  timeline?: IssueTimelineEntry[];
  files?: PullFile[];
}

export interface UseRepoPull {
  pull: PullRequest | undefined;
  comments: IssueComment[];
  /** The RAW chronological timeline (all event types — the task viewer renders them). */
  timeline: IssueTimelineEntry[];
  files: PullFile[];
  isLoading: boolean;
  isError: boolean;
}

function commentsFromTimeline(timeline: IssueTimelineEntry[] | undefined): IssueComment[] {
  if (!timeline) return [];
  return timeline
    .filter((e) => (e.event === 'commented' || e.event === 'reviewed') && typeof e.id === 'number')
    .map((e) => ({
      id: e.id as number,
      body: e.body ?? null,
      user: e.user ?? null,
      created_at: e.created_at ?? '',
      html_url: e.html_url,
      event: e.event,
    }));
}

export function useRepoPull(owner: string, repo: string, number: number | null): UseRepoPull {
  const api = useApi();
  const enabled = !!owner && !!repo && typeof number === 'number';
  const pullNumber = number ?? 0;

  const query = useQuery({
    queryKey: queryKeys.pull(owner, repo, pullNumber),
    enabled,
    retry: false,
    queryFn: () => api.get<PullDetailResponse>(`/api/repos/${owner}/${repo}/pulls/${pullNumber}`),
  });

  return {
    pull: query.data?.pr,
    comments: commentsFromTimeline(query.data?.timeline),
    timeline: query.data?.timeline ?? [],
    files: query.data?.files ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
