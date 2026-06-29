/**
 * Common types shared across the client and backend
 * These are foundational types used throughout the application
 */

/**
 * Page context types - describes what page the user is viewing
 * Used to provide context-aware AI responses
 */
export interface PageContext {
  type:
    | 'home'
    | 'repos'
    | 'repo'
    | 'issue'
    | 'pr'
    | 'branches'
    | 'actions'
    | 'commits'
    | 'file'
    | 'directory';
  owner?: string;
  repo?: string;
  issue_number?: number;
  pr_number?: number;
  branch?: string;
  path?: string;
  playwrightDevice?: 'mobile' | 'desktop'; // Device mode for Playwright browser automation
  [key: string]: any;
}

/**
 * User session data stored in Express session
 * Extended via module declaration in backend
 *
 * NOTE: GitHub tokens are kept in session for now as they're used for core authentication
 * throughout the codebase (80+ files). Google Drive and Slack tokens are now stored in
 * database via ConnectionsService as part of the named connections architecture.
 */
export interface SessionData {
  // User identity
  userEmail?: string;
  userId?: string;
  username?: string;
  onWaitlist?: boolean;

  // GitHub authentication (primary auth provider - kept in session)
  githubToken?: string;
  githubUser?: any;

  // Temporary OAuth state (deleted immediately after OAuth callback)
  oauthState?: string;
  returnTo?: string;
  upgradeScopes?: boolean;
  internal?: boolean;
}

/**
 * User info response from authentication
 */
export interface UserInfo {
  email: string;
  username: string;
  userId: string;
  onWaitlist: boolean;
}

/**
 * Claude Code session state
 * Managed in memory on backend for active sessions
 *
 * NEW: Persistent Query Architecture
 * ===================================
 * Instead of starting/stopping/resuming queries, we keep ONE query alive
 * forever and feed it messages via an async queue. The query iterator
 * blocks when the queue is empty (natural pause), and wakes up when we
 * enqueue a new message. This keeps background processes alive indefinitely!
 */
export interface ClaudeSession {
  repo_path: string;
  session_id: string | null;
  query: any; // The SDK Query object (AsyncGenerator) - stays alive until explicitly closed
  messageQueue: any[]; // Legacy message buffer - kept for backward compatibility
  inputQueue?: any; // MessageQueue<SDKUserMessage> for feeding messages to SDK (all sessions use this now)
  signal: { stopped: boolean };
  resolveNextMessage: ((msg: any) => void) | null;
  systemPrompt: string;
  userId?: string; // User ID for session cleanup
  model?: string; // Model selection (sonnet or haiku)
  permissions?: string; // Permission mode (default, plan, accept_edits, bypass_permissions)
  isProcessing?: boolean; // NEW: True when actively processing a message, false when idle/waiting
  authToken?: string; // JWT auth token for database operations (RLS) - stored for error cleanup
  lastActivityAt?: number; // Track last activity for staleness detection
}

/**
 * Buffered message for chat persistence
 */
export interface BufferedMessage {
  id: number; // Auto-incrementing ID for cursor-based pagination
  type: string;
  data: any;
  timestamp: number;
}

/**
 * Repository information for local operations
 */
export interface RepositoryInfo {
  path: string;
  name: string;
  owner?: string;
  repo?: string;
}

/**
 * Clone request options
 */
export interface CloneOptions {
  owner: string;
  repo: string;
  branch?: string;
}

/**
 * Generic API error response
 */
export interface ApiError {
  error: string;
  status?: number;
  details?: any;
}

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T = any> {
  data?: T;
  error?: string;
  status?: number;
}

/**
 * Repo page mode - represents Remote (GitHub) vs Local (cloned) context
 */
export type RepoMode = 'remote' | 'local';

/**
 * Remote mode tabs - GitHub-centric views
 */
export type RemoteTab = 'details' | 'branches' | 'issues' | 'prs' | 'actions' | 'settings';

/**
 * Local mode tabs - Development-centric views
 */
export type LocalTab = 'details' | 'diff' | 'environment' | 'directory';

/**
 * Secret (environment variable)
 * Stored encrypted in vault, automatically added to all projects
 * Can be sourced from manual entry, env editor, or service connections
 */
export interface Secret {
  key: string;
  value: string;
  description?: string;
  source: 'manual' | 'env_editor' | 'connection';
  sourceConnectionId?: string; // Set if source='connection'
  displayName?: string; // Display name for connection-sourced secrets
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

/**
 * @deprecated Use Secret instead. Will be removed in future version.
 */
export type UserSecret = Secret;

/**
 * Allowed user entry from the waitlist
 * Represents a user authorized to access the platform
 */
export interface AllowedUser {
  id: string;
  email: string;
  username: string | null;
  added_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
