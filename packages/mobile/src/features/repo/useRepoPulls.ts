/**
 * useRepoPulls — paginated, open/closed-filterable pull-request list.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The PR list is
 * server state → `useInfiniteQuery` over
 * `GET /api/repos/:owner/:repo/pulls?state=&page=&per_page=`. The sandbox
 * response is a superset of the shared `GetPullsResponse`; NOTE the pulls
 * endpoint reports pagination with **camelCase** `totalCount`/`hasMore` (NOT the
 * snake_case `total_count`/`has_more_pages` the issues/branches endpoints use) —
 * `hasMore` drives `getNextPageParam`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';

import type { PullRequest } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import type { IssueState } from './useRepoIssues';

/** Page size for the PR list. */
export const PULLS_PAGE_SIZE = 20;

/** Sandbox `/pulls` response (superset of the shared `GetPullsResponse`). */
interface PullsPage {
  pulls: PullRequest[];
  totalCount?: number;
  hasMore?: boolean;
}

export interface UseRepoPulls {
  pulls: PullRequest[];
  totalCount: number | undefined;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

export function useRepoPulls(owner: string, repo: string, state: IssueState): UseRepoPulls {
  const api = useApi();

  const query = useInfiniteQuery({
    queryKey: queryKeys.pulls(owner, repo, { state }),
    enabled: !!owner && !!repo,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.get<PullsPage>(
        `/api/repos/${owner}/${repo}/pulls?state=${state}&page=${pageParam}&per_page=${PULLS_PAGE_SIZE}`
      ),
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? (lastPageParam as number) + 1 : undefined,
  });

  const pulls = query.data?.pages.flatMap((p) => p.pulls) ?? [];
  const totalCount = query.data?.pages.at(-1)?.totalCount;

  return {
    pulls,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && pulls.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
  };
}
