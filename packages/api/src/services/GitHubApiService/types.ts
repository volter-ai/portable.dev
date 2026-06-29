import { Octokit } from '@octokit/rest';

/**
 * Shared types for GitHubApiService
 */

export interface TokenCacheEntry {
  token: string;
  type: 'oauth' | 'app';
  /** ms epoch when the token expires (GitHub App tokens); absent = no expiry */
  expiresAt?: number;
  /** Shared per-user Octokit (with 401 refresh-and-replay hook), reused across requests */
  octokit: Octokit;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface ReposCacheKey {
  userId: string;
  page: number;
  per_page: number;
  search?: string;
  language?: string;
  sort?: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  staged: number;
  modified: number;
  untracked: number;
}

export interface RepoReasonAndScore {
  reason: string;
  sortScore: number;
  activityType: string;
}

/**
 * Shared dependencies passed to handlers
 */
export interface HandlerDependencies {
  getUserOctokit: (userId: string) => Octokit;
  getOctokitForUser: (userId: string, authToken?: string) => Promise<Octokit>;
  getCachedToken: (userId: string) => string | undefined;
  getGitHubConnectionType: (userId: string) => 'app' | 'oauth' | undefined;
  handleGitHubApiError: (error: any, req: any, res: any, authToken?: string) => boolean;
}
