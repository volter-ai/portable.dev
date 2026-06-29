/**
 * useRepoActions — paginated workflow-run list.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * Actions tab is server state → `useInfiniteQuery` over
 * `GET /api/repos/:owner/:repo/actions/runs?page=&per_page=`. The sandbox
 * response is `{ runs, total_count, page, per_page, has_more_pages }` — the
 * `has_more_pages` flag drives pagination,
 * mirroring `useRepoIssues`/`useRepoBranches`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';

import type { WorkflowRun } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** Page size for the workflow-run list. */
export const ACTIONS_PAGE_SIZE = 20;

/** Sandbox `/actions/runs` response (superset of the shared shapes). */
interface ActionsPage {
  runs: WorkflowRun[];
  total_count?: number;
  has_more_pages?: boolean;
}

export interface UseRepoActions {
  runs: WorkflowRun[];
  totalCount: number | undefined;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

export function useRepoActions(owner: string, repo: string): UseRepoActions {
  const api = useApi();

  const query = useInfiniteQuery({
    queryKey: queryKeys.workflowRuns(owner, repo),
    enabled: !!owner && !!repo,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.get<ActionsPage>(
        `/api/repos/${owner}/${repo}/actions/runs?page=${pageParam}&per_page=${ACTIONS_PAGE_SIZE}`
      ),
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more_pages ? (lastPageParam as number) + 1 : undefined,
  });

  const runs = query.data?.pages.flatMap((p) => p.runs) ?? [];
  const totalCount = query.data?.pages.at(-1)?.total_count;

  return {
    runs,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && runs.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
  };
}
