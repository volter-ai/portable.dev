/**
 * GitHub API types
 * These types define structures returned from GitHub API and Octokit
 */

/**
 * GitHub user/organization
 */
export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: 'User' | 'Organization';
  name?: string | null;
  date?: string;
}

/**
 * GitHub organization
 * Returned from orgs.listForAuthenticatedUser()
 */
export interface Organization {
  login: string;
  id: number;
  avatar_url: string;
  description: string | null;
  html_url: string;
}

/**
 * GitHub authenticated user profile
 * Returned from users.getAuthenticated() with full profile stats
 */
export interface GitHubUserProfile {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  type: 'User' | 'Organization';
  name: string | null;
  email: string | null;
  bio: string | null;
  public_repos: number;
  total_private_repos: number;
  owned_private_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
}

/**
 * GitHub repository
 */
export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  private: boolean;
  description: string | null;
  homepage: string | null;
  html_url: string;
  fork: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  topics?: string[];
  visibility?: 'public' | 'private' | 'internal';
}

/**
 * Git status information
 */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  staged: number;
  modified: number;
  untracked: number;
  /**
   * True when the status was served from a stale cache or zeroed out after the
   * git computation hit its resource budget (timeout / output cap / breaker
   * cooldown) on a large repo — counts may be inaccurate. Absent on a normal
   * successful status. Consumers should avoid clobbering known-good data with a
   * degraded payload. See GitLocalService.getRepoStatusSafe (backend).
   */
  degraded?: boolean;
}

/**
 * Local repository status
 */
export interface LocalRepository {
  path: string;
  exists: boolean;
  status?: string;
  branch?: string;
  lastFetch?: string;
}

/**
 * Repository with local status
 */
export interface RepositoryWithLocal extends Repository {
  localPath?: string;
  localStatus?: 'cloned' | 'not_cloned' | 'error';
  localBranch?: string;
  gitStatus?: GitStatus;
  reason?: string; // Human-readable reason why this repo is shown (e.g., "Worked 2h ago", "Viewed 3d ago", "Updated 1w ago")
  isNew?: boolean; // True if user has never viewed this repo before
  isLocal?: boolean; // Simplified flag for UI to check if repo is cloned locally
  hasUnpulledChanges?: boolean; // True if gitStatus.behind > 0
  hasUnpushedChanges?: boolean; // True if gitStatus.ahead > 0
}

/**
 * GitHub branch
 */
export interface Branch {
  name: string;
  commit: {
    sha: string;
    url: string;
    commit?: Commit;
  };
  author?: GitHubUser | null;
  protected: boolean;
  lastCommitAuthor?: string;
  sha?: string;
  lastCommitDate?: string;
}

/**
 * Branch with commit date
 */
export interface BranchWithDate extends Branch {
  lastCommitDate?: string;
  lastCommitMessage?: string;
}

/**
 * GitHub issue
 */
export interface Issue {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: GitHubUser;
  labels: Label[];
  assignees: GitHubUser[];
  milestone: Milestone | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body: string | null;
  html_url: string;
  assignee?: GitHubUser | null;
  pull_request?: {
    url: string;
    html_url: string;
  };
  repository?: Repository | null;
  repository_url?: string;
}

/**
 * GitHub label
 */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/**
 * GitHub milestone
 */
export interface Milestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  open_issues: number;
  closed_issues: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  due_on: string | null;
}

/**
 * GitHub pull request
 */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: GitHubUser;
  labels: Label[];
  assignees: GitHubUser[];
  milestone: Milestone | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  body: string | null;
  html_url: string;
  head: {
    ref: string;
    sha: string;
    repo: Repository | null;
  };
  base: {
    ref: string;
    sha: string;
    repo: Repository;
  };
  draft: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/**
 * GitHub commit
 */
export interface Commit {
  sha: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
  };
  author: GitHubUser | null;
  committer: GitHubUser | null;
  parents: Array<{
    sha: string;
    url: string;
  }>;
  html_url: string;
}

/**
 * GitHub workflow run
 */
export interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;
  workflow_id: number;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
  html_url: string;
  display_title?: string;
  head_commit?: Commit['commit'] | null;
  actor?: GitHubUser | null;
  currentJob?: {
    id: number;
    name: string;
    step_number: number | null;
    step_name: string | null;
    total_steps: number;
  };
}

/**
 * GitHub file/directory content
 */
export interface FileContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  content?: string;
  encoding?: string;
}

/**
 * GitHub tree entry
 */
export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  url: string;
}

/**
 * GitHub tree
 */
export interface Tree {
  sha: string;
  url: string;
  tree: TreeEntry[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Mobile Source Control (portable.dev#17) — local-git contracts.
// Purely additive. These describe data derived from the repo's local clone
// under the workspace dir (git CLI), NOT the GitHub REST API. The lightweight
// CommitGraphNode intentionally does NOT reuse the heavy GitHub-REST `Commit`
// above.
// ---------------------------------------------------------------------------

/**
 * A ref (decoration) pointing at a local-git commit.
 */
export interface CommitRef {
  name: string;
  type: 'head' | 'branch' | 'remote' | 'tag';
}

/**
 * A single node in the local commit DAG used by the mobile commit graph.
 */
export interface CommitGraphNode {
  sha: string;
  parents: string[];
  refs: CommitRef[];
  author: string;
  date: string;
  subject: string;
}

/**
 * A changed file in the working tree or in a commit.
 */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  insertions?: number;
  deletions?: number;
  previousPath?: string;
}

/**
 * A git worktree (from `git worktree list --porcelain`).
 */
export interface Worktree {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  isMain: boolean;
}
