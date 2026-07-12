/**
 * Query key factory for the sandbox API. Centralising keys keeps
 * cache invalidation consistent across hooks and screens.
 */

import type { ChatCategory } from '@vgit2/shared/types';

export const queryKeys = {
  chats: () => ['chats'] as const,
  /** Paginated chat directory (per category: active / saved / archived) — `useInfiniteQuery` key. */
  chatDirectory: (category: ChatCategory) => ['chat-directory', { category }] as const,
  /** Per-chat settings (model/permissions/agentSetup). */
  chatSettings: (chatId: string) => ['chat-settings', chatId] as const,
  /** Slash commands + skills available to a chat (the composer `/` picker). */
  chatCommands: (chatId: string) => ['chat-commands', chatId] as const,
  /** Slash commands + skills available in a repo view (the Overview `/` picker). */
  repoCommands: (owner: string, repo: string) => ['repo-commands', owner, repo] as const,
  user: () => ['user'] as const,
  /** Recent local projects (home input project-selection dropdown). */
  recentProjects: (limit: number) => ['recent-projects', limit] as const,
  connections: () => ['connections'] as const,
  secrets: () => ['secrets'] as const,
  /** Background-process output file (`GET /api/task-output?path=`). */
  taskOutput: (path: string) => ['task-output', path] as const,
  userSettings: () => ['user-settings'] as const,
  /** Claude-account AI credential status (`GET /api/ai-credentials/status`). */
  aiCredentials: () => ['ai-credentials'] as const,
  agentSetups: () => ['agent-setups'] as const,
  mcps: () => ['mcps'] as const,
  pushSettings: () => ['push-settings'] as const,
  /** Custom voice-dictation phrases (on-device biasing vocabulary, stored on the PC). */
  voicePhrases: () => ['voice-phrases'] as const,
  /** GitHub organizations the user belongs to (`GET /api/user/organizations`). */
  organizations: () => ['organizations'] as const,

  /** User tasks dashboard (web TasksPage parity) — one cache entry per view (my/all). */
  userTasks: (view: string) => ['user-tasks', view] as const,

  repos: (params?: Record<string, string | number | undefined>) => ['repos', params ?? {}] as const,
  repo: (owner: string, repo: string) => ['repo', owner, repo] as const,
  /**
   * Overview-tab repo details (`GET /api/repos/:owner/:repo?skipGitOperations=true`)
   * — keyed apart from `repo` (the bare endpoint, which runs the expensive git
   * operations) so the two responses never overwrite each other.
   */
  repoOverview: (owner: string, repo: string) => ['repo-overview', owner, repo] as const,
  branches: (owner: string, repo: string) => ['branches', owner, repo] as const,
  issues: (owner: string, repo: string, params?: Record<string, string | number | undefined>) =>
    ['issues', owner, repo, params ?? {}] as const,
  /** Single issue detail (issue + timeline/comments). */
  issue: (owner: string, repo: string, number: number) => ['issue', owner, repo, number] as const,
  /** All labels defined on a repo (Issues-tab label filter). */
  labels: (owner: string, repo: string) => ['labels', owner, repo] as const,
  pulls: (owner: string, repo: string, params?: Record<string, string | number | undefined>) =>
    ['pulls', owner, repo, params ?? {}] as const,
  /** Single pull-request detail (pr + timeline + files). */
  pull: (owner: string, repo: string, number: number) => ['pull', owner, repo, number] as const,
  /** Lightweight linked-issue badge details (title/state/assignee) for a chat. */
  linkedIssue: (owner: string, repo: string, number: number) =>
    ['linked-issue', owner, repo, number] as const,
  /** Paginated workflow runs (Actions tab) — `useInfiniteQuery` key. */
  workflowRuns: (
    owner: string,
    repo: string,
    params?: Record<string, string | number | undefined>
  ) => ['workflow-runs', owner, repo, params ?? {}] as const,
  /** Single workflow-run detail (run + jobs/steps). */
  workflowRun: (owner: string, repo: string, runId: number) =>
    ['workflow-run', owner, repo, runId] as const,
  /** Workflow files list (Workflows tab). */
  workflows: (owner: string, repo: string) => ['workflows', owner, repo] as const,
  /** Single workflow file content (view). */
  workflowFile: (owner: string, repo: string, path: string) =>
    ['workflow-file', owner, repo, path] as const,
  /** Paginated AI generations (Generations tab) — `useInfiniteQuery` key. */
  generations: (
    owner: string,
    repo: string,
    params?: Record<string, string | number | undefined>
  ) => ['generations', owner, repo, params ?? {}] as const,
  /** Repo collaborators (Settings tab). */
  collaborators: (owner: string, repo: string) => ['collaborators', owner, repo] as const,
  /**
   * Prefix of every per-directory tree level for a repo (`treePrefix ⊂ tree`).
   * Invalidating it refetches the root AND every currently-mounted (expanded)
   * folder level in one shot.
   */
  treePrefix: (owner: string, repo: string) => ['tree', owner, repo] as const,
  tree: (owner: string, repo: string, path: string) => ['tree', owner, repo, path] as const,
  file: (owner: string, repo: string, path: string) => ['file', owner, repo, path] as const,
  /** Git history for a (often deleted/not-found) file — last-commit lookup + restore. */
  fileHistory: (owner: string, repo: string, path: string) =>
    ['file-history', owner, repo, path] as const,
  /** Per-repo working-tree status (branch, ahead/behind, staged/modified/untracked). */
  gitStatus: (owner: string, repo: string) => ['git-status', owner, repo] as const,
  /**
   * Source-control working-tree changes — the grouped Conflicts/Staged/Unstaged/
   * Untracked surface (`GET /api/source-control/:o/:r/status`). Keyed apart from
   * `gitStatus` (the lightweight counters endpoint) so the two never collide.
   */
  workingTreeChanges: (owner: string, repo: string, worktree?: string) =>
    (worktree
      ? ['working-tree-changes', owner, repo, worktree]
      : ['working-tree-changes', owner, repo]) as readonly unknown[],
  /**
   * Per-file unified diff for the source-control Changes view
   * (`GET /api/source-control/:o/:r/file-diff?path=&staged=[&worktree=]`). Keyed
   * by path + staged so the staged/unstaged diffs of the same file never
   * overwrite; the optional `worktree` (Worktrees tab) scopes the diff to a
   * non-main worktree so its diffs never collide with the main checkout's
   * (omitted → the main-checkout key shape).
   */
  sourceControlFileDiff: (
    owner: string,
    repo: string,
    path: string,
    staged: boolean,
    worktree?: string
  ) =>
    (worktree
      ? ['source-control-file-diff', owner, repo, path, staged, worktree]
      : ['source-control-file-diff', owner, repo, path, staged]) as readonly unknown[],
  /**
   * The repo's git worktrees — the read-only Worktrees tab list
   * (`GET /api/source-control/:o/:r/worktrees`). Keyed apart from every other
   * source-control read.
   */
  worktrees: (owner: string, repo: string) => ['worktrees', owner, repo] as const,
  /**
   * Multi-lane commit graph for the source-control Graph segment
   * (`GET /api/source-control/:o/:r/graph` — `useInfiniteQuery`, keyed apart from
   * the working-tree/diff reads).
   */
  commitGraph: (owner: string, repo: string) => ['commit-graph', owner, repo] as const,
  /**
   * A single commit's detail (changed files + patch) for the commit-detail screen
   * (`GET /api/source-control/:o/:r/commit/:sha`). Keyed by sha.
   */
  commitDetail: (owner: string, repo: string, sha: string) =>
    ['commit-detail', owner, repo, sha] as const,
  /** Contextual quick actions derived from the repo's package scripts. */
  quickActions: (owner: string, repo: string) => ['quick-actions', owner, repo] as const,
} as const;
