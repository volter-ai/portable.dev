/**
 * useRepoIssue — single issue detail + comment / assignee mutations.
 *
 * MVVM ViewModel-as-hook. The detail is server state → `useQuery` over
 * `GET /api/repos/:owner/:repo/issues/:number`, which returns the issue PLUS a
 * `timeline` array (the shared `GetIssueResponse` is `{ issue }`-only and lies
 * about this endpoint — same pattern as README/branches). Comments are the
 * timeline entries whose `event === 'commented'`.
 *
 * Four mutations, each invalidating the detail query on success so the new
 * comment / assignee set / state is reflected:
 *   - addComment  → `POST   .../issues/:number/comments`  body `{ body }`
 *   - addAssignee → `PUT    .../issues/:number/assignees` body `{ assignees }`
 *   - removeAssignee → `DELETE .../issues/:number/assignees` body `{ assignees }`
 *   - setIssueState → `PATCH .../issues/:number` body `{ state, state_reason }`
 *     (the close/reopen action in the task viewer)
 *
 * The RAW `timeline` is also exposed (the task viewer renders every event type);
 * `comments` stays the filtered `commented` subset the
 * repo IssuesTab renders.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { GitHubUser, Issue } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { queryKeys } from '../api/keys';

/** A timeline comment (the `commented` events the backend returns). */
export interface IssueComment {
  id: number;
  body: string | null;
  user?: GitHubUser | null;
  created_at: string;
  html_url?: string;
  event?: string;
}

/**
 * A raw GitHub timeline entry (the backend paginates
 * `issues.listEventsForTimeline`). Every field is optional — which ones exist
 * depends on `event` (labeled → `label`, renamed → `rename`, referenced →
 * `commit_id`, cross-referenced → `source`, committed → `sha`/`message`, …).
 */
export interface IssueTimelineEntry extends Partial<IssueComment> {
  event?: string;
  node_id?: string;
  actor?: GitHubUser | null;
  label?: { name?: string; color?: string };
  rename?: { from?: string; to?: string };
  assignee?: GitHubUser | null;
  milestone?: { title?: string } | null;
  commit_id?: string;
  commit_url?: string;
  sha?: string;
  message?: string;
  author?: { name?: string; date?: string };
  committer?: { name?: string; date?: string };
  review_requester?: GitHubUser | null;
  requested_reviewer?: GitHubUser | null;
  path?: string;
  line?: number;
  /** cross-referenced events: the referencing issue/PR. */
  source?: {
    issue?: {
      number?: number;
      title?: string;
      state?: string;
      pull_request?: unknown;
      merged_at?: string | null;
      html_url?: string;
      repository?: { full_name?: string };
    };
  };
}

/** Sandbox `/issues/:number` response (superset of shared `GetIssueResponse`). */
interface IssueDetailResponse {
  issue: Issue;
  timeline?: IssueTimelineEntry[];
}

export interface UseRepoIssue {
  issue: Issue | undefined;
  comments: IssueComment[];
  /** The RAW chronological timeline (all event types — the task viewer renders them). */
  timeline: IssueTimelineEntry[];
  assignees: GitHubUser[];
  isLoading: boolean;
  isError: boolean;
  /** Post a new comment via `POST .../comments`. */
  addComment: (body: string) => void;
  /** Awaitable comment post (the close-with-comment flow posts FIRST). */
  addCommentAsync: (body: string) => Promise<unknown>;
  isAddingComment: boolean;
  isCommentError: boolean;
  /** Assign a user via `PUT .../assignees`. */
  addAssignee: (login: string) => void;
  /** Unassign a user via `DELETE .../assignees`. */
  removeAssignee: (login: string) => void;
  isMutatingAssignees: boolean;
  /** Close/reopen via `PATCH .../issues/:number` (close-reason semantics). */
  setIssueState: (state: 'open' | 'closed', reason?: string) => void;
  isSettingState: boolean;
  isStateError: boolean;
}

/** Keep only the timeline entries that are actual comments with a body. */
function commentsFromTimeline(timeline: IssueTimelineEntry[] | undefined): IssueComment[] {
  if (!timeline) return [];
  return timeline
    .filter((e) => e.event === 'commented' && typeof e.id === 'number')
    .map((e) => ({
      id: e.id as number,
      body: e.body ?? null,
      user: e.user ?? null,
      created_at: e.created_at ?? '',
      html_url: e.html_url,
      event: e.event,
    }));
}

export function useRepoIssue(owner: string, repo: string, number: number | null): UseRepoIssue {
  const api = useApi();
  const qc = useQueryClient();
  const enabled = !!owner && !!repo && typeof number === 'number';
  const issueNumber = number ?? 0;
  const detailKey = queryKeys.issue(owner, repo, issueNumber);

  const query = useQuery({
    queryKey: detailKey,
    enabled,
    retry: false,
    queryFn: () =>
      api.get<IssueDetailResponse>(`/api/repos/${owner}/${repo}/issues/${issueNumber}`),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: detailKey });

  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      api.post(`/api/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body }),
    onSuccess: invalidate,
  });

  const addAssigneesMutation = useMutation({
    mutationFn: (login: string) =>
      api.put(`/api/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
        assignees: [login],
      }),
    onSuccess: invalidate,
  });

  const removeAssigneesMutation = useMutation({
    mutationFn: (login: string) =>
      api.del(`/api/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, {
        assignees: [login],
      }),
    onSuccess: invalidate,
  });

  // Close/reopen: PATCH with a state_reason
  // ('completed' | 'not_planned' | 'duplicate' on close, 'reopened' on reopen).
  const stateMutation = useMutation({
    mutationFn: ({ state, reason }: { state: 'open' | 'closed'; reason?: string }) =>
      api.patch(`/api/repos/${owner}/${repo}/issues/${issueNumber}`, {
        state,
        state_reason: reason ?? (state === 'closed' ? 'completed' : 'reopened'),
      }),
    onSuccess: invalidate,
  });

  const issue = query.data?.issue;

  return {
    issue,
    comments: commentsFromTimeline(query.data?.timeline),
    timeline: query.data?.timeline ?? [],
    assignees: issue?.assignees ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    addComment: (body: string) => {
      const trimmed = body.trim();
      if (trimmed) commentMutation.mutate(trimmed);
    },
    addCommentAsync: (body: string) => {
      const trimmed = body.trim();
      return trimmed ? commentMutation.mutateAsync(trimmed) : Promise.resolve(undefined);
    },
    isAddingComment: commentMutation.isPending,
    isCommentError: commentMutation.isError,
    addAssignee: (login: string) => {
      const trimmed = login.trim();
      if (trimmed) addAssigneesMutation.mutate(trimmed);
    },
    removeAssignee: (login: string) => removeAssigneesMutation.mutate(login),
    isMutatingAssignees: addAssigneesMutation.isPending || removeAssigneesMutation.isPending,
    setIssueState: (state: 'open' | 'closed', reason?: string) =>
      stateMutation.mutate({ state, reason }),
    isSettingState: stateMutation.isPending,
    isStateError: stateMutation.isError,
  };
}
