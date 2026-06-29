/**
 * useRepoGenerations — paginated AI-generations list.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * Generations tab is server state → `useInfiniteQuery` over
 * `GET /api/repos/:owner/:repo/generations?page=&per_page=`. The sandbox response
 * is `{ generations, total_count, has_more_pages }` (shared `GetGenerationsResponse`);
 * `has_more_pages` drives pagination, mirroring `useRepoActions`/`useRepoIssues`.
 *
 * Generations come from a repo's `.volter/generations.json`; a not-yet-cloned repo
 * returns an empty list (the backend already degrades to `{ generations: [] }`).
 */

import { useInfiniteQuery } from '@tanstack/react-query';

import type { Generation, GetGenerationsResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** Page size for the generations list. */
export const GENERATIONS_PAGE_SIZE = 30;

export interface UseRepoGenerations {
  generations: Generation[];
  totalCount: number | undefined;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

export function useRepoGenerations(owner: string, repo: string): UseRepoGenerations {
  const api = useApi();

  const query = useInfiniteQuery({
    queryKey: queryKeys.generations(owner, repo),
    enabled: !!owner && !!repo,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.get<GetGenerationsResponse>(
        `/api/repos/${owner}/${repo}/generations?page=${pageParam}&per_page=${GENERATIONS_PAGE_SIZE}`
      ),
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more_pages ? (lastPageParam as number) + 1 : undefined,
  });

  const generations = query.data?.pages.flatMap((p) => p.generations) ?? [];
  const totalCount = query.data?.pages.at(-1)?.total_count;

  return {
    generations,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && generations.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
  };
}
