/**
 * useCommitGraph — the source-control commit-graph ViewModel (portable.dev#17).
 *
 * MVVM ViewModel-as-hook over `GET /api/source-control/:owner/:repo/graph`
 * (the isolated source-control factory). The commit log is server state →
 * `useInfiniteQuery` paginated by the response's `nextCursor`. The lane layout
 * ({@link computeCommitLanes}) is recomputed (memoized) over the accumulated
 * nodes, so lanes refine incrementally as pages load.
 *
 * `retry: false` (AC parity with the other source-control reads): a degraded /
 * empty graph is a normal `200`, and a real failure should surface immediately.
 * The query is gated behind `enabled` so the SourceControlTab only fetches when
 * the Graph segment is active.
 *
 * `staleTime: 0` (the OverviewTab chat-preview precedent) — the PC commits
 * out-of-band with no socket signal, so every remount refetches the loaded
 * pages in the background instead of trusting a cached log.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { CommitGraphNode, GetCommitGraphResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import { computeCommitLanes, type LaneRow } from './commitLanes';

export interface UseCommitGraphOptions {
  /** Gate the graph read (default `true`). The tab passes `segment === 'graph'`. */
  enabled?: boolean;
}

export interface UseCommitGraph {
  nodes: CommitGraphNode[];
  /** Per-row lane layout, aligned 1:1 with `nodes`. */
  lanes: LaneRow[];
  defaultBranch?: string;
  /** True when a resource limit forced an empty/degraded result. */
  degraded: boolean;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  /** Awaitable refetch of every loaded page (backs the pull-to-refresh spinner). */
  refetch: () => Promise<void>;
}

export function useCommitGraph(
  owner: string,
  repo: string,
  options: UseCommitGraphOptions = {}
): UseCommitGraph {
  const api = useApi();
  const enabled = (options.enabled ?? true) && !!owner && !!repo;

  const query = useInfiniteQuery({
    queryKey: queryKeys.commitGraph(owner, repo),
    enabled,
    retry: false,
    staleTime: 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<GetCommitGraphResponse>(
        `/api/source-control/${owner}/${repo}/graph${
          pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''
        }`
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const nodes = useMemo(() => query.data?.pages.flatMap((p) => p.nodes) ?? [], [query.data]);
  const lanes = useMemo(() => computeCommitLanes(nodes), [nodes]);
  const degraded = query.data?.pages.some((p) => p.degraded) ?? false;
  const defaultBranch = query.data?.pages[0]?.defaultBranch;

  return {
    nodes,
    lanes,
    defaultBranch,
    degraded,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: query.isSuccess && nodes.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: async () => {
      await query.refetch();
    },
  };
}
