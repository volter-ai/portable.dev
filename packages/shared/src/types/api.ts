/**
 * API request and response types
 * These types define the structure of HTTP API endpoints
 */

import { AgentSetup } from './agentSetup.js';
import { Chat, ChatListItem, ChatMessage } from './chat.js';
import { UserInfo, ApiError, UserSecret, Secret } from './common.js';
import { Generation } from './generations.js';
import {
  Repository,
  RepositoryWithLocal,
  Branch,
  BranchWithDate,
  Issue,
  PullRequest,
  Commit,
  WorkflowRun,
  FileContent,
  Tree,
  LocalRepository,
  GitHubUserProfile,
  CommitGraphNode,
  ChangedFile,
  Worktree,
} from './github.js';

/**
 * ============================================================================
 * AUTHENTICATION ENDPOINTS
 * ============================================================================
 */

/**
 * GitHub User data
 */
export interface User {
  login: string;
  avatar_url: string;
  name?: string;
  email?: string;
  bio?: string;
  public_repos: number;
  total_private_repos?: number;
  owned_private_repos?: number;
  followers: number;
  following: number;
}

/**
 * GET /api/user
 */
export interface GetUserResponse {
  user: User;
  email: string;
  username: string;
  userId: string;
  onWaitlist: boolean;
}

/**
 * GET /api/user/profile
 * Fetches fresh user profile data from GitHub (bypasses session cache)
 */
export interface GetUserProfileResponse {
  profile: GitHubUserProfile;
}

/**
 * GET /api/user/organizations
 * Fetches user's GitHub organizations
 */
export interface GetUserOrganizationsResponse {
  organizations: Array<{
    login: string;
    id: number;
    avatar_url: string;
    description: string | null;
  }>;
}

/**
 * ============================================================================
 * CHAT ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/chats
 * Returns list of chats for the authenticated user
 * Query params: limit (default: 50, max: 200), offset (default: 0)
 */
export interface GetChatsResponse {
  chats: ChatListItem[];
  hasMore: boolean; // Whether there are more chats beyond the current page
  totalCount: number; // Total number of chats (for UI feedback)
}

/**
 * GET /api/chats/:chatId/messages
 * Get messages for a chat (polling endpoint)
 * Query params: after (message ID), limit (default 50)
 */
export interface GetChatMessagesRequest {
  after?: number; // Return messages with ID > after
  limit?: number; // Max messages to return (default 50)
}

/**
 * POST /api/chats/:chatId/messages
 * Send a message to a chat
 */
export interface SendChatMessageRequest {
  content: string;
  context?: any;
  uploadedFiles?: any[];
  autofill?: boolean;
}

/**
 * PATCH /api/chat/:chatId/settings
 * Update chat model and permission settings
 */
export interface UpdateChatSettingsRequest {
  model?: string;
  permissions?: string;
  effort?: string;
}

export interface UpdateChatSettingsResponse {
  success: boolean;
  updated?: {
    model?: string;
    permissions?: string;
    effort?: string;
  };
}

/**
 * GET /api/chat/:chatId/settings
 * Read a chat's persisted settings (model/permissions/agentSetup).
 * Only fields that are actually persisted are returned; the client applies its
 * own defaults for any omitted field.
 */
export interface GetChatSettingsResponse {
  model?: string;
  permissions?: string;
  agentSetupId?: string;
  effort?: string;
}

/**
 * POST /api/chats
 * Create a new chat (for headless API)
 */
export interface CreateChatResponse {
  id: string;
  type: string;
  title: string;
  repoOwner: any;
  repoName: any;
}

/**
 * GET /api/chats/:chatId/messages
 * Get messages for a chat (long polling endpoint)
 */
export interface GetChatMessagesResponse {
  messages: any[];
  hasMore: boolean;
  status: string;
}

/**
 * POST /api/chats/:chatId/messages
 * Send a message to a chat (headless API)
 */
export interface SendChatMessageResponse {
  messageId: string;
  status: string;
}

/**
 * GET /api/chats/:chatId/status
 * Get chat status (headless API)
 */
export interface GetChatStatusResponse {
  status: 'idle' | 'running' | 'interrupted';
  lastActivity?: number;
}

/**
 * A slash command or skill available to a chat — the items the mobile composer's
 * `/` picker lists. `name` is the invocation name WITHOUT the leading slash; the
 * client sends `/<name> <args>` as the message content, which the Claude Agent SDK
 * runtime expands + executes (slash commands) or the model invokes (skills).
 */
export interface SlashCommandInfo {
  /** Invocation name without the leading slash (e.g. `code-review`). */
  name: string;
  /** Custom slash command, an Agent Skill, or a built-in SDK command. */
  kind: 'command' | 'skill' | 'builtin';
  /** Where it was discovered: the cwd repo, the user's global `~/.claude`, or built into the SDK. */
  scope: 'project' | 'global' | 'builtin';
  /** One-line description parsed from the command/`SKILL.md` frontmatter, when available. */
  description?: string;
  /**
   * The `argument-hint` frontmatter value (e.g. `[pr-number] [priority]`) — the grey
   * hint for what arguments the command takes. Shown as ghost text after `/<name> ` in
   * the composer and beside the picker option. Only ever set from a disk-scanned command/
   * skill (the SDK `system/init` `slash_commands` list carries names only).
   */
  argumentHint?: string;
}

/**
 * GET /api/chats/:chatId/commands
 *
 * Slash commands + skills available to a chat (powers the mobile `/` picker). The
 * authoritative set is the SDK `system/init` `slash_commands` array captured during
 * execution; before a chat has run it falls back to scanning the cwd repo's
 * `.claude/{commands,skills}` + the user's global `~/.claude/skills` (global
 * `~/.claude/commands` are intentionally excluded — `settingSources: ['project']`
 * means the SDK does NOT load them, so listing them would offer commands that never run).
 */
export interface GetChatCommandsResponse {
  commands: SlashCommandInfo[];
}

/**
 * POST /api/chats/:chatId/summarize
 * Summarize chat messages
 */
export interface SummarizeChatResponse {
  summary: any;
}

/**
 * POST /api/generate-project-name
 * Generate project name using AI
 */
export interface GenerateProjectNameResponse {
  name: string;
}

/**
 * POST /api/chats/analyze-intent
 * Analyze user intent for chat/project creation
 */
export interface AnalyzeIntentResponse {
  intentType: string;
  confidence: number;
  suggestedFramework?: string;
  useExistingRepo?: any;
}

/**
 * ============================================================================
 * PROJECT ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/projects/recent
 * Get recent local projects
 */
export interface GetRecentProjectsResponse {
  projects: any[];
}

/**
 * POST /api/projects/create
 * Create new project (explicit project creation endpoint)
 */
export interface CreateProjectResponse {
  owner: string;
  repoName: string;
  [key: string]: any;
}

/**
 * POST /api/projects/create-local
 * Create local folder only (for simple tasks)
 */
export interface CreateLocalFolderResponse {
  folderPath: string;
  [key: string]: any;
}

/**
 * GET /api/task-output
 * Read task output file content (for background bash processes)
 */
export interface GetTaskOutputResponse {
  content: string;
}

/**
 * ============================================================================
 * FILE UPLOAD ENDPOINTS
 * ============================================================================
 */

/**
 * POST /api/upload
 * Request: multipart/form-data with 'file' field
 */
export interface UploadFileRequest {
  file: File | Blob;
}

/**
 * POST /api/upload
 * Response
 */
export interface UploadFileResponse {
  fileName: string;
  originalName: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * GET /api/uploads/:filename
 * Serves uploaded file (no response type, returns file stream)
 */

/**
 * POST /api/transcribe
 * Request: multipart/form-data with 'audio' field
 */
export interface TranscribeAudioRequest {
  audio: File | Blob;
}

/**
 * POST /api/transcribe
 * Response
 */
export interface TranscribeAudioResponse {
  text: string;
}

/**
 * GET /api/repos/:owner/:repo/file-history/*
 * Check if file existed in git history
 */
export interface GetFileHistoryResponse {
  [key: string]: any;
}

/**
 * POST /api/repos/:owner/:repo/view
 * Track repository view
 */
export interface TrackRepoViewResponse {
  success: boolean;
}

/**
 * POST /api/repos/rescan
 * Drop the running PC's in-memory repo caches for the calling user so a
 * freshly-linked/unlinked local project (junction + repo-views.json written by
 * `portable link`/`unlink`) shows up on the NEXT repos fetch without restarting
 * `portable`. `invalidatedRepoCacheEntries` is the number of ReposCacheService
 * entries dropped; `clearedRepoViewCache` is whether the viewed-repos in-memory
 * cache was reset (forcing a fresh read of repo-views.json).
 */
export interface RescanReposResponse {
  success: boolean;
  invalidatedRepoCacheEntries: number;
  clearedRepoViewCache: boolean;
}

/**
 * ============================================================================
 * GITHUB API ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/repos
 * List all repositories for authenticated user
 * Query params: search, language, sort, page, per_page
 */
export interface GetReposRequest {
  search?: string; // Text search (name, description, README)
  language?: string; // Filter by programming language
  sort?: 'updated' | 'stars' | 'name'; // Sort order (default: updated)
  page?: number; // Page number (default: 1)
  per_page?: number; // Items per page (default: 10)
}

export interface GetReposResponse {
  repos: RepositoryWithLocal[];
  localRepos?: LocalRepository[];
  total_count?: number; // Total count when searching
  page?: number;
  per_page?: number;
  hasMore?: boolean;
}

/**
 * GET /api/repos/:owner/:repo
 * Get repository details with local status
 */
export interface GetRepoResponse {
  repo: RepositoryWithLocal;
  localPath?: string;
  localStatus?: 'cloned' | 'not_cloned' | 'error';
  localBranch?: string;
  gitStatus?: string;
}

/**
 * GET /api/repos/:owner/:repo/tree/*
 * Get directory tree
 */
export interface GetTreeResponse {
  tree: Tree;
}

/**
 * GET /api/repos/:owner/:repo/contents/*
 * Get file or directory contents
 */
export interface GetContentsResponse {
  contents: FileContent | FileContent[];
  isLocal?: boolean;
  localContent?: string;
}

/**
 * GET /api/repos/:owner/:repo/env-files
 * Get list of environment files in local repository
 */
export interface EnvFileInfo {
  filename: string;
  path: string;
  relativePath: string;
  size: number;
  lastModified: number;
  exists: boolean;
}

export interface GetEnvFilesResponse {
  files: EnvFileInfo[];
}

/**
 * GET /api/repos/:owner/:repo/branches
 * List repository branches with commit dates
 */
export interface GetBranchesResponse {
  branches: BranchWithDate[];
}

/**
 * GET /api/repos/:owner/:repo/issues
 * List repository issues
 * Query params: state, labels, assignee, creator, mentioned, sort, direction, since
 */
export interface GetIssuesRequest {
  state?: 'open' | 'closed' | 'all';
  labels?: string;
  assignee?: string;
  creator?: string;
  mentioned?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  since?: string;
  page?: number;
  per_page?: number;
}

export interface GetIssuesResponse {
  issues: Issue[];
  total_count?: number;
  page?: number;
  per_page?: number;
}

/**
 * GET /api/repos/:owner/:repo/issues/:number
 * Get single issue details
 */
export interface GetIssueResponse {
  issue: Issue;
}

/**
 * GET /api/repos/:owner/:repo/pulls
 * List repository pull requests
 * Query params: state, head, base, sort, direction
 */
export interface GetPullsRequest {
  state?: 'open' | 'closed' | 'all';
  head?: string;
  base?: string;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
  page?: number;
  per_page?: number;
}

export interface GetPullsResponse {
  pulls: PullRequest[];
  total_count?: number;
  page?: number;
  per_page?: number;
  // PR creation detection
  canCreatePR: boolean;
  commitsAhead: number;
  currentBranch: string;
  defaultBranch: string;
  upstreamBranch: string | null;
}

/**
 * GET /api/repos/:owner/:repo/pulls/:number
 * Get single pull request details
 */
export interface GetPullResponse {
  pull: PullRequest;
}

/**
 * GET /api/repos/:owner/:repo/commits/:branch
 * List commits for a branch
 */
export interface GetCommitsRequest {
  page?: number;
  per_page?: number;
  since?: string;
  until?: string;
  author?: string;
}

export interface GetCommitsResponse {
  commits: Commit[];
  page?: number;
  per_page?: number;
}

/**
 * GET /api/repos/:owner/:repo/generations
 * List AI media generations from .volter/generations.json
 */
export interface GetGenerationsRequest {
  name?: string;
  version?: string;
  type?: 'image' | 'video' | 'all';
  model?: string;
  search?: string;
  sort?: 'timestamp' | 'name' | 'version';
  direction?: 'asc' | 'desc';
  page?: number;
  per_page?: number;
}

export interface GetGenerationsResponse {
  generations: Generation[];
  total_count: number;
  has_more_pages: boolean;
}

/**
 * GET /api/repos/:owner/:repo/actions/runs
 * List workflow runs
 */
export interface GetActionsRunsRequest {
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  branch?: string;
  event?: string;
  page?: number;
  per_page?: number;
}

export interface GetActionsRunsResponse {
  workflow_runs: WorkflowRun[];
  total_count: number;
}

/**
 * GET /api/user/recent-branches
 * Get recent branches across all repositories
 */
export interface GetRecentBranchesResponse {
  branches: Array<{
    repo: string;
    owner: string;
    branch: BranchWithDate;
  }>;
}

/**
 * GET /api/repos/:owner/:repo/quick-actions
 * Get quick actions based on package.json scripts
 */
export type QuickAction = {
  id: string;
  label: string;
  labelBold?: string; // Optional part of label to render in bold
  icon?: string; // FontAwesome icon name (e.g., 'play', 'rotate-right', 'eye')
  priority?: number;
  hasStatusDot?: boolean; // If true, shows a status dot next to the icon
  statusDotColor?: 'green' | 'yellow' | 'grey'; // Color of the status dot (green = success/active, yellow = working/attention, grey = idle/available)
} & (
  | { type: 'message'; prompt: string }
  | { type: 'runtime'; resourceType: 'tunnel' | 'process'; resourceId: string }
  | { type: 'toggle-summary' } // Toggle summary panel visibility
);

export interface GetQuickActionsResponse {
  quickActions: QuickAction[];
}

/**
 * ============================================================================
 * GIT LOCAL OPERATIONS
 * ============================================================================
 */

/**
 * POST /api/repos/:owner/:repo/clone
 * Clone repository to local workspace
 */
export interface CloneRepoRequest {
  branch?: string;
}

export interface CloneRepoResponse {
  success: boolean;
  path: string;
  message?: string;
  error?: string;
}

/**
 * ============================================================================
 * VIDEO SERVING
 * ============================================================================
 */

/**
 * GET /api/video/:owner/:repo/*
 * Serves video file (no response type, returns video stream)
 */

/**
 * ============================================================================
 * INTERNAL API ENDPOINTS (Container Communication)
 * ============================================================================
 */

/**
 * POST /api/internal/claude/start
 * Internal endpoint used by main container to delegate work to user containers
 * Only available when CONTAINER_MODE=user
 */
export interface InternalClaudeStartRequest {
  chatId: string;
  task: string;
  systemPrompt: string;
  userToken: string;
  userId: string;
  owner?: string; // GitHub owner - container will clone if provided
  repo?: string; // GitHub repo - container will clone if provided
}

/**
 * ============================================================================
 * USER SECRETS ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/user/secrets
 * Get all secrets from all sources (manual, env_editor, connection)
 */
export interface GetUserSecretsResponse {
  secrets: Secret[];
}

/**
 * POST /api/user/secrets
 * Create a new secret
 */
export interface CreateUserSecretRequest {
  key: string;
  value: string;
  description?: string;
  source?: 'manual' | 'env_editor' | 'connection';
  sourceConnectionId?: string;
}

export interface CreateUserSecretResponse {
  success: boolean;
  secret?: Secret;
  error?: string;
}

/**
 * POST /api/user/secrets/from-env
 * Create a secret from env editor (convenience endpoint)
 */
export interface CreateSecretFromEnvRequest {
  key: string;
  value: string;
  description?: string;
}

export interface CreateSecretFromEnvResponse {
  success: boolean;
  secret?: Secret;
  error?: string;
}

/**
 * PATCH /api/user/secrets/:key
 * Update an existing secret
 */
export interface UpdateUserSecretRequest {
  value?: string;
  description?: string;
}

export interface UpdateUserSecretResponse {
  success: boolean;
  secret?: Secret;
  error?: string;
}

/**
 * DELETE /api/user/secrets/:key
 * Delete a user-level secret
 */
export interface DeleteUserSecretResponse {
  success: boolean;
  error?: string;
}

/**
 * ============================================================================
 * SECRETS VAULT ENDPOINTS - Password-manager style saved secrets
 * ============================================================================
 */

/**
 * Saved secret from vault (without value for security)
 */
export interface SavedSecretMetadata {
  key: string;
  lastUsedAt?: string; // ISO date string
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

/**
 * Saved secret from vault (with decrypted value)
 */
export interface SavedSecretWithValue {
  key: string;
  value: string;
}

/**
 * GET /api/secrets/vault
 * Get all saved secrets from vault (keys and metadata only, no values)
 */
export interface GetSavedSecretsResponse {
  savedSecrets: SavedSecretMetadata[];
}

/**
 * GET /api/secrets/vault/:key
 * Get a specific saved secret value from vault (decrypted)
 */
export interface GetSavedSecretResponse {
  key: string;
  value: string;
}

/**
 * POST /api/secrets/vault
 * Save a secret to vault (create or update)
 */
export interface SaveSecretRequest {
  key: string;
  value: string;
}

export interface SaveSecretResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * DELETE /api/secrets/vault/:key
 * Delete a secret from vault
 */
export interface DeleteSavedSecretResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * GET /api/secrets/vault/search?q=query
 * Search vault for secrets (for autocomplete/suggestions)
 */
export interface SearchVaultResult {
  key: string;
  lastUsedAt?: string; // ISO date string
}

export interface SearchVaultResponse {
  results: SearchVaultResult[];
}

/**
 * ============================================================================
 * MCP (Model Context Protocol) ENDPOINTS
 * ============================================================================
 */

/**
 * MCP Server Status
 * Represents the availability and configuration status of an MCP server
 */
export interface McpStatus {
  /** MCP unique identifier (from MCP_REGISTRY) */
  id: string;

  /** Display name */
  name: string;

  /** Human-readable description */
  description: string;

  /** MCP type */
  type: 'external' | 'custom';

  /** Whether this MCP is currently enabled */
  enabled: boolean;

  /** Number of tools provided by this MCP */
  toolCount?: number;

  /** Website URL (for favicon and links) */
  websiteUrl?: string;

  /** Required configuration (tokens, env vars) */
  requirements: string[];

  /** Current status */
  status: 'available' | 'missing_token' | 'disabled';

  /** Color theme for UI */
  colorTheme?: string;

  /** Icon identifier (emoji character, 'fa:icon-name', or URL) */
  icon?: string;

  /** Category for grouping */
  category?: 'automation' | 'development' | 'productivity' | 'platform' | 'media';
}

/**
 * GET /api/mcps/available
 * Returns all MCPs with their availability status
 */
export interface GetMcpsAvailableResponse {
  mcps: McpStatus[];
}

/**
 * ============================================================================
 * AGENT SETUP ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/agent-setups
 * Returns all available agent setups
 */
export interface GetAgentSetupsResponse {
  agentSetups: AgentSetup[];
}

/**
 * ============================================================================
 * SUGGESTIONS ENDPOINTS
 * ============================================================================
 */

/**
 * Structured repository data for suggestions
 */
export interface SuggestionRepo {
  owner: string;
  name: string;
  ownerAvatarUrl?: string;
}

/**
 * A single suggestion for user action
 */
export interface Suggestion {
  /** Brief label (2-4 words) like "Fix profile bug" */
  name: string;
  /** Autocomplete text like " profile page rendering bug in user/dashboard" */
  completion: string;
  /** Structured repo data or null for general tasks */
  repo: SuggestionRepo | null;
  /** Task description or ID this relates to */
  taskReference: string | null;
  /** Issue number if this is from a GitHub issue */
  issueNumber?: number | null;
}

/**
 * POST /api/chats/suggestions
 * Request body for generating contextual suggestions
 * Note: Repos and tasks are fetched automatically from backend
 */
export interface GetSuggestionsRequest {
  /** Current input text (or null/empty for initial suggestions) */
  message?: string | null;
  /** Selected framework (optional) */
  framework?: string | null;
  /** Tasks view ('my' or 'all', defaults to 'my') */
  view?: string;
}

/**
 * POST /api/chats/suggestions
 * Response containing 3 contextual suggestions
 */
export interface GetSuggestionsResponse {
  suggestions: Suggestion[];
}

/**
 * ============================================================================
 * GIT CREDENTIALS
 * ============================================================================
 */

/**
 * POST /api/update-git-credentials
 * Updates the git credentials file with the GitHub token from JWT
 * Only works in remote sandboxes (production mode)
 */
export interface UpdateGitCredentialsRequest {
  // No body needed - token extracted from JWT
}

export interface UpdateGitCredentialsResponse {
  success: boolean;
  message: string;
}

/**
 * ============================================================================
 * CONFIG ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/config
 * Returns configuration for the client (modal mode detection)
 */
export interface GetConfigResponse {
  modalMode: string | null;
}

/**
 * GET /api/dev-info
 * Returns development environment information (build metadata, uptime, etc)
 */
export interface GetDevInfoResponse {
  frontend: any;
  backend: any;
  serverUptime: number;
  nodeVersion: string;
  environment: string | undefined;
}

/**
 * POST /api/repos/:owner/:repo/inject-secrets
 * Inject user secrets into a repository .env file
 */
export interface InjectSecretsResponse {
  success: boolean;
  added: number;
  skipped: number;
  total: number;
  message: string;
}

/**
 * ============================================================================
 * THEME ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/user/theme
 * Returns user theme configuration
 */
export interface GetUserThemeResponse {
  themeConfig: any;
}

/**
 * PUT /api/user/theme
 * Save user theme configuration
 */
export interface SaveUserThemeResponse {
  success: boolean;
}

/**
 * ============================================================================
 * CONNECTION ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/connections
 * Returns all connections for user
 */
export interface GetConnectionsResponse {
  connections: any[];
}

/**
 * GET /api/connections/services
 * Returns all available service configurations
 */
export interface GetServicesResponse {
  services: any[];
}

/**
 * GET /api/connections/:connectionId
 * Returns a single connection by ID
 */
export interface GetConnectionResponse {
  connection: any;
}

/**
 * POST /api/connections/complete-oauth
 * Complete OAuth connection with display name
 */
export interface CompleteOAuthResponse {
  success: boolean;
  connection: any;
  token?: string;
}

/**
 * POST /api/connections
 * Create/update a named connection
 */
export interface CreateConnectionResponse {
  success: boolean;
  connection: any;
}

/**
 * PATCH /api/connections/:connectionId/rename
 * Rename a connection (alias to existing RenameConnectionResponse from connections.ts)
 */
export interface RenameConnectionApiResponse {
  success: boolean;
  connection: any;
}

/**
 * GET /api/connections/:connectionId/account-info
 * Get account info for a connection
 */
export interface GetConnectionAccountInfoResponse {
  accountInfo: any;
}

/**
 * GET /api/connections/github-app/installations
 * List GitHub App installations for the current user
 */
export interface GetGitHubAppInstallationsResponse {
  installations: any[];
}

/**
 * DELETE /api/connections/:connectionId
 * Delete a connection by ID
 */
export interface DeleteConnectionResponse {
  success: boolean;
}

/**
 * PATCH /api/connections/:connectionId/toggle-active
 * Toggle connection active status (enable/disable)
 */
export interface ToggleConnectionActiveResponse {
  success: boolean;
  connection: any;
}

/**
 * POST /api/connections/flyio-cli/auth-url
 * Initiate Fly.io CLI auth (SSO-style)
 */
export interface GetFlyioAuthUrlResponse {
  authUrl: string;
}

/**
 * POST /api/connections/flyio-cli/complete
 * Complete Fly.io CLI auth (check if authenticated and store connection)
 */
export interface CompleteFlyioAuthResponse {
  success: boolean;
  connection: any;
}

/**
 * ============================================================================
 * VERSION ENDPOINTS
 * ============================================================================
 */

/**
 * GET /api/min-version
 * Returns the minimum required client version (no auth required)
 */
export interface MinVersionResponse {
  minimumVersion: string; // e.g. "1.0.27" — minimum semver the client must meet
  currentServerVersion: string; // e.g. "1.0.25" — what the server is running
}

/**
 * ============================================================================
 * ERROR RESPONSES
 * ============================================================================
 */

/**
 * Standard error response for all endpoints
 */
export interface ErrorResponse {
  error: string;
  status?: number;
  details?: any;
  code?: 'GITHUB_SCOPE_REQUIRED' | string; // Special error codes
}

/**
 * 401 Unauthorized
 */
export interface UnauthorizedResponse {
  error:
    | 'Unauthorized: Please log in'
    | 'Not authenticated'
    | 'GitHub token expired. Please log in again.';
}

/**
 * 403 Forbidden
 */
export interface ForbiddenResponse {
  error: 'Access denied';
}

/**
 * 404 Not Found
 */
export interface NotFoundResponse {
  error: 'Repository not found locally' | 'Directory not found' | 'File not found' | string;
}

/**
 * 500 Internal Server Error
 */
export interface InternalServerErrorResponse {
  error: string;
}

/**
 * Response from `POST /api/transcribe` (audio → text).
 * `raw` is present only when post-processing changed the transcription.
 */
export interface TranscribeResponse {
  transcription: string;
  raw?: string;
}

/**
 * Custom voice-dictation phrases (the on-device recognizer's `contextualStrings`
 * biasing vocabulary), stored in the PC's portable metadata. The phone fetches them
 * (cached) and busts the cache when one is added. `version` increments on every change
 * so a client can cheaply detect updates.
 */
export interface VoicePhrasesResponse {
  phrases: string[];
  version: number;
}

/**
 * ============================================================================
 * MOBILE SOURCE CONTROL ENDPOINTS (portable.dev#17)
 * Mounted at /api/source-control. Purely additive. Backed by the repo's local
 * clone under the workspace dir via the git CLI (NOT the GitHub REST API).
 * ============================================================================
 */

/** GET /api/source-control/:owner/:repo/graph */
export interface GetCommitGraphResponse {
  nodes: CommitGraphNode[];
  nextCursor?: string;
  defaultBranch?: string;
  /** Present when a resource limit forced a degraded/empty result. */
  degraded?: boolean;
}

/** GET /api/source-control/:owner/:repo/commit/:sha */
export interface GetCommitDetailResponse {
  sha: string;
  files: ChangedFile[];
  diff: string;
  stats?: { additions: number; deletions: number };
}

/** GET /api/source-control/:owner/:repo/status */
export interface GetWorkingTreeChangesResponse {
  branch: string;
  ahead: number;
  behind: number;
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  conflicted: ChangedFile[];
}

/** GET /api/source-control/:owner/:repo/file-diff */
export interface GetFileDiffResponse {
  path: string;
  diff: string;
}

/** GET /api/source-control/:owner/:repo/worktrees */
export interface GetWorktreesResponse {
  worktrees: Worktree[];
}

/** POST /api/source-control/:owner/:repo/commit */
export interface CommitResponse {
  sha: string;
  branch?: string;
  author?: string;
}

/** POST /api/source-control/:owner/:repo/push */
export interface PushResponse {
  pushed: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
}

/** POST /api/source-control/:owner/:repo/pull */
export interface PullResponse {
  pulled: boolean;
  /**
   * The pull hit merge conflicts and stopped: the working tree now has
   * unmerged files (`pulled: false`). Push stays blocked until they are
   * resolved. Absent on a clean pull.
   */
  conflicts?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
}

/** POST /api/source-control/:owner/:repo/stage | /unstage | /discard */
export interface StageResponse {
  ok: boolean;
  paths: string[];
}

/** POST mutation result for worktree create/remove/prune (reserved for a follow-up issue). */
export interface WorktreeMutationResponse {
  ok: boolean;
  worktrees?: Worktree[];
}
