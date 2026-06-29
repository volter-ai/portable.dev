/**
 * Authentication and GitHub OAuth types
 */

/**
 * GitHub OAuth scopes
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
 */
export type GitHubScope =
  | 'repo'
  | 'repo:status'
  | 'repo_deployment'
  | 'public_repo'
  | 'repo:invite'
  | 'security_events'
  | 'admin:repo_hook'
  | 'write:repo_hook'
  | 'read:repo_hook'
  | 'admin:org'
  | 'write:org'
  | 'read:org'
  | 'admin:public_key'
  | 'write:public_key'
  | 'read:public_key'
  | 'admin:org_hook'
  | 'gist'
  | 'notifications'
  | 'user'
  | 'read:user'
  | 'user:email'
  | 'user:follow'
  | 'project'
  | 'read:project'
  | 'delete_repo'
  | 'write:packages'
  | 'read:packages'
  | 'delete:packages'
  | 'admin:gpg_key'
  | 'write:gpg_key'
  | 'read:gpg_key'
  | 'codespace'
  | 'workflow';

/**
 * Required scopes for Portable functionality
 *
 * - repo: Full repository access (files, secrets, webhooks)
 * - workflow: REQUIRED to modify .github/workflows/ directory
 * - read:org: Read organization membership
 * - read:user: Read user profile information
 * - user:email: Access user email address
 */
export const REQUIRED_SCOPES: GitHubScope[] = [
  'repo',
  'workflow',
  'read:org',
  'read:user',
  'user:email'
];

/**
 * Scope check result
 */
export interface ScopeCheckResult {
  /** Whether the user has all required scopes */
  hasRequiredScopes: boolean;
  /** Current scopes the user has */
  currentScopes: GitHubScope[];
  /** Missing scopes that are required */
  missingScopes: GitHubScope[];
  /** Timestamp of the check */
  timestamp: number;
}

/**
 * Request to check GitHub token scopes
 */
export interface CheckScopesRequest {
  /** Optional: force refresh (bypass cache) */
  forceRefresh?: boolean;
}

/**
 * Response from scope check endpoint
 */
export interface CheckScopesResponse extends ScopeCheckResult {
  /** Whether the user needs to reauthorize (token expired/invalid) */
  needsReauth: boolean;
  /** Whether the user has never connected GitHub (different from expired token) */
  noGitHubConnection?: boolean;
}

/**
 * Token update message (sent from gateway to sandbox)
 * NOTE: GitHub tokens are now managed server-side via ConnectionsService, not sent in JWT
 */
export interface TokenUpdateMessage {
  type: 'token_update';
  /** New JWT token */
  token: string;
  /** Updated scopes */
  scopes: GitHubScope[];
  /** Timestamp of update */
  timestamp: number;
}
