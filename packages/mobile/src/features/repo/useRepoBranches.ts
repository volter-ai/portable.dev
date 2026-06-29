/**
 * useRepoBranches — paginated branch list + branch comparison.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * branch list is server state → `useInfiniteQuery` over
 * `GET /api/repos/:owner/:repo/branches?page=&per_page=` (the sandbox response is
 * `{ branches, total_count, has_more_pages, … }`; each branch carries
 * `lastCommitDate`/`lastCommitMessage`/`lastCommitAuthor`).
 *
 * Branch comparison: the default action seeds the home chat composer with a "compare <branch> with
 * main" prompt and navigates to the chat (the RN screen renders without a socket,
 * so we hand off to the composer rather than emitting `chat:create` here). The
 * action is injectable so callers/tests can override it.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback } from 'react';

import type { BranchWithDate } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';
import { useChatStore } from '../state';

/** Page size for the branch list. */
export const BRANCHES_PAGE_SIZE = 30;

/** The default branch a comparison targets ("compare with main"). */
export const COMPARE_BASE_BRANCH = 'main';

/**
 * Reserved chat-store draft key for the home composer. Mirrors `HOME_DRAFT_KEY`
 * in the chat feature (`useChatComposer.ts`) — duplicated here as a literal to
 * keep this feature decoupled from the (socket/audio-heavy) chat module graph.
 */
const HOME_DRAFT_KEY = '__home__';

/** Sandbox `/branches` response (superset of the shared `GetBranchesResponse`). */
interface BranchesPage {
  branches: BranchWithDate[];
  total_count?: number;
  has_more_pages?: boolean;
}

export interface UseRepoBranchesOptions {
  /** Navigation seam (default Expo Router's imperative `router.push`). */
  navigate?: (href: string) => void;
  /** Override the branch-comparison action (default seeds the home composer). */
  onCompareBranch?: (branch: BranchWithDate) => void;
}

export interface UseRepoBranches {
  branches: BranchWithDate[];
  totalCount: number | undefined;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  refetch: () => void;
  /** Kick off a comparison of `branch` against the default branch. */
  compareBranch: (branch: BranchWithDate) => void;
}

/** Build the comparison prompt. */
export function buildCompareBranchPrompt(owner: string, repo: string, branch: string): string {
  return [
    `Please help me compare the branch "${branch}" with ${COMPARE_BASE_BRANCH} in ${owner}/${repo}.`,
    '',
    `1. Check out the branch: ${branch}`,
    `2. Compare it with the ${COMPARE_BASE_BRANCH} branch:`,
    '   - Show the differences between branches',
    '   - Identify all changed files',
    '   - Highlight key changes',
    '   - Check for conflicts',
    '3. Provide a summary of files added/modified/deleted, major functional changes,',
    '   any conflicts, and recommendations for merging.',
  ].join('\n');
}

export function useRepoBranches(
  owner: string,
  repo: string,
  options: UseRepoBranchesOptions = {}
): UseRepoBranches {
  const api = useApi();
  const navigate = options.navigate ?? ((href: string) => router.push(href));
  const updateChatDraft = useChatStore((s) => s.updateChatDraft);

  const query = useInfiniteQuery({
    queryKey: queryKeys.branches(owner, repo),
    enabled: !!owner && !!repo,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.get<BranchesPage>(
        `/api/repos/${owner}/${repo}/branches?page=${pageParam}&per_page=${BRANCHES_PAGE_SIZE}`
      ),
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.has_more_pages ? (lastPageParam as number) + 1 : undefined,
  });

  const branches = query.data?.pages.flatMap((p) => p.branches) ?? [];
  const totalCount = query.data?.pages.at(-1)?.total_count;

  const defaultCompare = useCallback(
    (branch: BranchWithDate) => {
      updateChatDraft(HOME_DRAFT_KEY, buildCompareBranchPrompt(owner, repo, branch.name));
      // The home chat composer (where the seeded draft surfaces) is the Home tab
      // at `/` (US-009 bottom-tab navigation).
      navigate('/');
    },
    [updateChatDraft, owner, repo, navigate]
  );

  const compareBranch = options.onCompareBranch ?? defaultCompare;

  return {
    branches,
    totalCount,
    isLoading: query.isLoading,
    isError: query.isError,
    isEmpty: !query.isLoading && !query.isError && branches.length === 0,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
    compareBranch,
  };
}
