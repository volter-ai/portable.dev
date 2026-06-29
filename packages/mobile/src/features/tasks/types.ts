/**
 * Wire types for `GET /api/user/tasks/{cached,refresh}` — the Tasks dashboard
 * endpoints.
 *
 * There is NO shared type for this response, so they are declared here per
 * the established locally-declared-response pattern (`api/hooks.ts`). The
 * backend (`packages/api` `UserHandler.fetchUserTasks`) maps GitHub **GraphQL**
 * nodes by hand into this REST-ish snake_case shape — the shared
 * `Issue`/`PullRequest` types LIE at runtime for it:
 *
 *   - `id` EQUALS the issue/PR NUMBER (not the global GitHub id) — never key
 *     across repos by `id` alone.
 *   - `labels` are `{ name, color }` only (no id/description); `color` has no
 *     leading `#` and can be missing.
 *   - PRs have NO top-level `repository` field — derive the repo from
 *     `repository_url` via the `/repos\/([^/]+)\/([^/]+)$/` regex.
 *   - PR `base.repo` is the raw GraphQL node (`nameWithOwner`, no `full_name`).
 *   - PR `state` may be `'merged'`.
 */

export interface TaskActor {
  login: string;
  avatar_url?: string;
}

export interface TaskLabel {
  name: string;
  /** GitHub label color WITHOUT the leading `#` (may be absent). */
  color?: string;
}

export interface TaskRepositoryRef {
  full_name: string;
  owner: { login: string };
  name: string;
}

export interface TaskIssue {
  /** ⚠️ Equals the issue NUMBER on this endpoint, not the global GitHub id. */
  id: number;
  number: number;
  title: string;
  state: string; // 'open' | 'closed'
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  body?: string | null;
  html_url: string;
  comments?: number;
  labels?: TaskLabel[];
  assignee?: TaskActor | null;
  assignees?: TaskActor[];
  /** The author. */
  user?: TaskActor | null;
  milestone?: { title?: string; due_on?: string | null } | null;
  repository?: TaskRepositoryRef;
  repository_url?: string;
  /** Present on PR-as-issue entries (flips the item into PR rendering). */
  pull_request?: { url?: string; html_url?: string };
}

export interface TaskPr {
  /** ⚠️ Equals the PR NUMBER on this endpoint. */
  id: number;
  number: number;
  title: string;
  state: string; // 'open' | 'closed' | 'merged'
  draft?: boolean;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  body?: string | null;
  html_url: string;
  comments?: number;
  review_comments?: number;
  commits?: number;
  labels?: TaskLabel[];
  user?: TaskActor | null;
  assignee?: TaskActor | null;
  assignees?: TaskActor[];
  /** Always `[]` in `view=all` (the per-repo GraphQL query omits review data). */
  reviewers?: TaskActor[];
  head?: { ref?: string };
  /** Raw GraphQL repository node — `nameWithOwner`, NOT `full_name`. */
  base?: {
    ref?: string;
    repo?: { nameWithOwner?: string; name?: string; owner?: { login: string } };
  };
  repository_url?: string;
  /** Parsed from the body (`closes|fixes|resolves #N`, case-insensitive). */
  linked_issue_numbers?: number[];
}

export type TasksView = 'my' | 'all';

export interface TasksResponse {
  open_issues: TaskIssue[];
  /** Issues closed since the SERVER's local midnight (always viewer-assigned). */
  closed_today: TaskIssue[];
  prs: TaskPr[];
  total_open: number;
  total_closed_today: number;
  total_prs: number;
  user: TaskActor | null;
  view: TasksView | string;
  cached?: boolean;
  /** ms epoch of when the server cached this payload. */
  cacheTimestamp?: number;
  /**
   * Present (still HTTP 200!) when the backend's main GraphQL query failed —
   * arrays come back empty and the degraded payload is server-cached for 24h.
   * It is ignored here (the screen renders the empty state).
   */
  error?: string;
  /**
   * `true` when the user has NO repositories cloned in their sandbox workspace
   * (tasks are scoped to locally cloned repos). The arrays come
   * back empty; the client shows a "clone a repo" guidance state instead of the
   * generic empty state.
   */
  noLocalRepos?: boolean;
}
