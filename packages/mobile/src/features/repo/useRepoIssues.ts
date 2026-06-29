/**
 * useRepoIssues — paginated, filterable issue list.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * issue list is server state → `useInfiniteQuery` over
 * `GET /api/repos/:owner/:repo/issues?state=&page=&per_page=&…`. The sandbox
 * response is a superset of the shared `GetIssuesResponse`
 * (`{ issues, count_on_page, total_count, has_more_pages, per_page }`) — the
 * `has_more_pages` flag drives pagination, mirroring `useRepoBranches`.
 *
 * The filter is the full GitHub-style set the
 * backend supports: `labels` (AND), `assignee`, free-text `text`, and
 * `sort`/`direction`. Each is keyed into the query so changing a filter narrows
 * the list via a fresh fetch. The OPTIONAL params
 * are only sent when set, so the default (open, newest) request stays the bare
 * `?state=open&page=1&per_page=20` (the backend defaults `sort`/`direction` to
 * created/desc).
 *
 * Two co-located helper queries feed the filter UI:
 *   - {@link useRepoLabels}        → `GET .../labels` (the label dropdown)
 *   - {@link useRepoCollaborators} → `GET .../collaborators` (the assignee dropdown)
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { Issue, Label } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import type { Collaborator } from './useRepoSettings';

/** Page size for the issue list. */
export const ISSUES_PAGE_SIZE = 20;

/** The open/closed filter applied to the issue list. */
export type IssueState = 'open' | 'closed';
/** Sort field the backend `issues` endpoint accepts (created = newest/oldest). */
export type IssueSort = 'created' | 'updated';
/** Sort direction. */
export type IssueDirection = 'asc' | 'desc';

/** The full filter set the issue list keys off. */
export interface IssueListFilters {
  state: IssueState;
  /** Label names to AND-filter by (omitted when empty). */
  labels?: string[];
  /** Assignee login to filter by (omitted when empty). */
  assignee?: string;
  /** Free-text title search (omitted when blank). */
  text?: string;
  /**
   * Sort field — OMITTED for the default ("newest"), so the request stays bare
   * (the backend defaults to created/desc). Set it for oldest/updated.
   */
  sort?: IssueSort;
  /** Sort direction (only sent alongside an explicit `sort`). */
  direction?: IssueDirection;
}

/** Sandbox `/issues` response (superset of the shared `GetIssuesResponse`). */
interface IssuesPage {
  issues: Issue[];
  total_count?: number;
  has_more_pages?: boolean;
}

export interface UseRepoIssues {
  issues: Issue[];
  totalCount: number | undefined;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * The set of filter params that are actually sent — used both to build the
 * query string AND as the cache-key discriminator (so flipping any filter
 * refetches). Only set/non-default values appear, keeping the default request
 * (and its key) minimal.
 */
function activeFilterParams(filters: IssueListFilters): Record<string, string> {
  const params: Record<string, string> = { state: filters.state };
  if (filters.sort) params.sort = filters.sort;
  if (filters.direction) params.direction = filters.direction;
  if (filters.labels && filters.labels.length > 0) params.labels = filters.labels.join(',');
  if (filters.assignee) params.assignee = filters.assignee;
  const text = filters.text?.trim();
  if (text) params.text = text;
  return params;
}

export function useRepoIssues(
  owner: string,
  repo: string,
  filters: IssueListFilters
): UseRepoIssues {
  const api = useApi();
  const params = activeFilterParams(filters);

  const query = useInfiniteQuery({
    queryKey: queryKeys.issues(owner, repo, params),
    enabled: !!owner && !!repo,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      // Built from the SAME `params` that key the cache (so the URL and the
      // cache key can never diverge), in a fixed order so the mock gateway
      // (exact METHOD+path+query match) can register it; optional filters
      // appear only when present.
      let path = `/api/repos/${owner}/${repo}/issues?state=${params.state}&page=${pageParam}&per_page=${ISSUES_PAGE_SIZE}`;
      if (params.sort) path += `&sort=${params.sort}`;
      if (params.direction) path += `&direction=${params.direction}`;
      if (params.labels) path += `&labels=${encodeURIComponent(params.labels)}`;
      if (params.assignee) path += `&assignee=${encodeURIComponent(params.assignee)}`;
      if (params.text) path += `&text=${encodeURIComponent(params.text)}`;
      return api.get<IssuesPage>(path);
    },
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more_pages ? (lastPageParam as number) + 1 : undefined,
  });

  const issues = query.data?.pages.flatMap((p) => p.issues) ?? [];
  const totalCount = query.data?.pages.at(-1)?.total_count;

  return {
    issues,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && issues.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
  };
}

/** Sandbox `/labels` response (`{ labels }`). */
interface LabelsResponse {
  labels?: Label[];
}

export interface UseRepoLabels {
  labels: Label[];
  isLoading: boolean;
  isError: boolean;
}

/**
 * All labels defined on the repo — feeds the Issues-tab label dropdown.
 * `retry: false`: a repo with no label-read access (or none yet cloned) simply
 * shows an empty label list rather than blocking the tab.
 */
export function useRepoLabels(owner: string, repo: string): UseRepoLabels {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.labels(owner, repo),
    enabled: !!owner && !!repo,
    retry: false,
    queryFn: () => api.get<LabelsResponse>(`/api/repos/${owner}/${repo}/labels`),
  });
  return {
    labels: query.data?.labels ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Sandbox `/collaborators` response (`{ team_members }`). */
interface CollaboratorsResponse {
  team_members?: Collaborator[];
}

export interface UseRepoCollaborators {
  collaborators: Collaborator[];
  isLoading: boolean;
}

/**
 * Repo collaborators — feeds the Issues-tab assignee dropdown. Shares
 * the `collaborators` query key with the Settings tab (same endpoint, deduped
 * cache). `retry: false`: collaborators legitimately 403/404 for a repo you can
 * read but don't admin (the backend falls back to assignees), so a failure just
 * leaves the dropdown empty.
 */
export function useRepoCollaborators(owner: string, repo: string): UseRepoCollaborators {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.collaborators(owner, repo),
    enabled: !!owner && !!repo,
    retry: false,
    queryFn: () => api.get<CollaboratorsResponse>(`/api/repos/${owner}/${repo}/collaborators`),
  });
  return {
    collaborators: query.data?.team_members ?? [],
    isLoading: query.isLoading,
  };
}
