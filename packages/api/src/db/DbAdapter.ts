import type {
  StoredChat,
  ChatCategory,
  ChatStatus,
  ChatType,
  BufferedMessage,
  ServiceConnection,
  StoredServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

/**
 * Options for saving a chat
 * Using an options object instead of positional parameters for better maintainability
 */
export interface SaveChatOptions {
  userId: string;
  chatId: string;
  type: ChatType;
  title: string;
  status?: ChatStatus;
  repoPath?: string;
  repoFullName?: string;
  sessionId?: string;
  /**
   * Original Claude Code session id to FORK from on first run (rev9 fork-on-first-write).
   * Set only when claiming a discovered terminal transcript into a new Portable chat.
   */
  forkSourceSessionId?: string;
  systemPrompt?: string;
  playwrightDevice?: string;
  summary?: string;
  model?: string;
  permissions?: string;
  agentSetupId?: string;
  parentChatId?: string;
  workflowRunId?: string; // GitHub Actions workflow run ID (for routine tracking)
  authToken?: string;
}

/**
 * Where a chatId comes from — drives the fork-vs-resume decision (rev9 fork-on-first-write).
 * A `discovered` chat is a Claude Code terminal transcript with no Portable row; opening it
 * and sending a message FORKS it (read-only on the source) instead of resuming in place.
 */
export type ChatOrigin =
  | { origin: 'sqlite' }
  | {
      origin: 'discovered';
      /** The source transcript's session id (== the `.jsonl` filename, == the discovered chatId). */
      sourceSessionId: string;
      /** The transcript's REAL cwd — where the forked SDK run must execute. */
      cwd: string;
      /** The matched workspace repo's on-disk root (display/grouping). */
      repoPath: string;
      /** The matched repo's GitHub full_name (owner/repo), for the chat card label. */
      repoFullName: string;
      /** The discovered chat's title. */
      title: string;
    }
  | { origin: 'none' };

/**
 * Database adapter interface
 *
 * Defines the contract for database operations implemented by the local
 * SQLite adapter.
 *
 * This allows the application to switch between storage backends
 * transparently without changing business logic.
 */
export interface DbAdapter {
  /**
   * Initialize the database adapter
   * Returns true if initialization was successful
   */
  initialize(): Promise<boolean>;

  /**
   * Save or update a chat
   * Uses an options object for better maintainability and type safety
   */
  saveChat(options: SaveChatOptions): Promise<boolean>;

  /**
   * Save a raw message to the database
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  saveMessage(
    chatId: string,
    type: string,
    data: any,
    timestamp: number,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Get all chats for a user, sorted by last_updated descending
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @param archived - Optional filter: true for archived only, false for non-archived only, undefined for all
   * @param portableOnly - When true, return ONLY portable-native chats (real SQLite
   *   rows that were opened + messaged in Portable), excluding discovered
   *   ~/.claude/projects transcripts that were merely imported. Terminal-only filter;
   *   adapters without a discovered-transcript union ignore it.
   * @param category - Optional 3-way bucket filter ('active' = not archived AND not
   *   saved, 'saved', 'archived'). When provided it SUPERSEDES `archived`. The mobile
   *   client sends this; the terminal sends only `archived` (back-compat: legacy
   *   `archived=false` means "not archived" and still includes saved chats).
   */
  getChats(
    userId: string,
    authToken?: string,
    archived?: boolean,
    portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<StoredChat[]>;

  /**
   * Get chats with message previews and counts in an optimized way (4 queries instead of N+1)
   * Returns chats with: message_count, first_message_data, last_message_data
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @param archived - Optional filter: true for archived only, false for non-archived only, undefined for all
   * @param portableOnly - See {@link DbAdapter.getChats} (terminal-only portable filter).
   */
  getChatsWithPreviews(
    userId: string,
    limit: number,
    offset: number,
    authToken?: string,
    archived?: boolean,
    portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<any[]>;

  /**
   * Get a specific chat by ID
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getChat(chatId: string, userId: string, authToken?: string): Promise<StoredChat | undefined>;

  /**
   * Classify where a chatId comes from (rev9 fork-on-first-write):
   *  - `'sqlite'`     — a real Portable chat row exists for this user.
   *  - `'discovered'` — NO real row, but a Claude Code terminal transcript with
   *                     `sessionId === chatId` is in scope (JSONL mode only). Carries the
   *                     keys needed to FORK it into a new Portable chat without touching it.
   *  - `'none'`       — neither (unknown chat).
   * Adapters without transcript discovery never return `'discovered'`.
   */
  getChatOrigin(chatId: string, userId: string, authToken?: string): Promise<ChatOrigin>;

  /**
   * Get all messages for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getMessages(chatId: string, authToken?: string): Promise<BufferedMessage[]>;

  /**
   * Update the status of a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateChatStatus(
    chatId: string,
    userId: string,
    status: ChatStatus,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the title of a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateChatTitle(
    chatId: string,
    userId: string,
    title: string,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the summary of a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateChatSummary(
    chatId: string,
    userId: string,
    summary: string,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Delete a chat and all its messages
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  deleteChat(chatId: string, userId: string, authToken?: string): Promise<boolean>;

  /**
   * Archive or unarchive a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  archiveChat(
    chatId: string,
    userId: string,
    archived: boolean,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Save or unsave a chat (the "Saved" category). Saving is mutually exclusive with
   * archiving — implementations clear `archived` when `saved` is set true.
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  setChatSaved(
    chatId: string,
    userId: string,
    saved: boolean,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Pin or unpin a chat (orthogonal to the category — highlighted + floated to top).
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  setChatPinned(
    chatId: string,
    userId: string,
    pinned: boolean,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update chat session information
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateChatSession(
    chatId: string,
    userId: string,
    sessionId: string,
    systemPrompt: string,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update Playwright device mode for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updatePlaywrightDevice(
    chatId: string,
    userId: string,
    device: 'mobile' | 'desktop',
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the permissions mode for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updatePermissions(
    chatId: string,
    userId: string,
    permissions: string,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the model for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateModel(chatId: string, userId: string, model: string, authToken?: string): Promise<boolean>;

  /**
   * Update the agent setup ID for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateAgentSetupId(
    chatId: string,
    userId: string,
    agentSetupId: string,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the last read message ID for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateLastReadMessageId(
    chatId: string,
    userId: string,
    messageId: number,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Update the linked GitHub issue for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateLinkedIssue(
    chatId: string,
    userId: string,
    linkedIssue: { owner: string; repo: string; number: number } | null,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Get the total count of messages for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getMessageCount(chatId: string, authToken?: string): Promise<number>;

  /**
   * Health check - returns true if the database is accessible
   */
  isHealthy(): Promise<boolean>;

  /**
   * Get adapter type for logging
   */
  getAdapterType(): string;

  /**
   * Get the most recent chat activity (last_updated) for each repo_path
   * Returns a map of repo_path -> last_updated timestamp
   * Used to determine "worked on" status based on chat activity
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getLastChatActivityByRepo(userId: string, authToken?: string): Promise<Map<string, string>>;

  // ============================================================================
  // WORKFLOW METHODS
  // ============================================================================

  /**
   * Get all chats with a specific workflow_run_id
   * Used to find chats created by GitHub Actions workflows
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getChatsByWorkflowRunId(workflowRunId: string, authToken?: string): Promise<StoredChat[]>;

  // ============================================================================
  // PUSH SUBSCRIPTION METHODS
  // ============================================================================

  /**
   * Save or update a push notification subscription
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  savePushSubscription(
    userId: string,
    subscription: {
      endpoint: string;
      keys?: {
        p256dh: string;
        auth: string;
      };
      platform?: 'web' | 'ios' | 'android';
      fcmToken?: string;
      deviceInfo?: any;
    },
    authToken?: string
  ): Promise<boolean>;

  /**
   * Remove a push subscription by endpoint
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  removePushSubscription(userId: string, endpoint: string, authToken?: string): Promise<boolean>;

  /**
   * Get all push subscriptions for a user
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getUserPushSubscriptions(
    userId: string,
    authToken?: string
  ): Promise<
    Array<{
      userId: string;
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
      /** FCM device token (native Expo/FCM push); absent for legacy web-push subs. */
      fcmToken?: string;
      deviceInfo?: any;
    }>
  >;

  /**
   * Get notification settings for a user
   * Returns settings from the first subscription found, or null if no subscriptions
   */
  getNotificationSettings(
    userId: string,
    authToken?: string
  ): Promise<{ enabled: boolean; taskComplete: boolean; notifyWhen: 'always' | 'offline' } | null>;

  /**
   * Update notification settings for all of a user's subscriptions
   */
  updateNotificationSettings(
    userId: string,
    settings: Partial<{
      enabled: boolean;
      taskComplete: boolean;
      notifyWhen: 'always' | 'offline';
    }>,
    authToken?: string
  ): Promise<boolean>;

  // ============================================================================
  // THEME METHODS
  // ============================================================================

  /**
   * Get user's theme configuration
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getTheme(userEmail: string, authToken?: string): Promise<Record<string, any> | null>;

  /**
   * Save user's theme configuration
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  saveTheme(
    userEmail: string,
    themeConfig: Record<string, any>,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Delete user's theme configuration
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  deleteTheme(userEmail: string, authToken?: string): Promise<boolean>;

  // ============================================================================
  // SERVICE CONNECTION METHODS
  // ============================================================================

  /**
   * Get all service connections for a user
   */
  getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]>;

  /**
   * Get credentials for a specific connection by name
   * Returns null if not found
   */
  getConnectionCredentials(options: GetConnectionOptions): Promise<any | null>;

  /**
   * Get a specific connection by name
   */
  getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null>;

  /**
   * Get all connections for a specific service type
   */
  getConnectionsByService(options: GetConnectionsByServiceOptions): Promise<ServiceConnection[]>;

  /**
   * Store a new connection (or update existing)
   */
  storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection>;

  /**
   * Delete a connection by name
   */
  deleteConnection(options: GetConnectionOptions): Promise<void>;

  /**
   * Rename a connection
   */
  renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection>;

  /**
   * Toggle connection active status
   * For exclusive services, automatically disables other connections of the same service
   */
  toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection>;

  /**
   * Get active connections for a service (for exclusive services)
   */
  getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]>;

  /**
   * Check if user has a specific connection by name
   */
  hasConnection(options: GetConnectionOptions): Promise<boolean>;

  // ============================================================================
  // SERVICE ACCOUNT METHODS
  // ============================================================================

  /**
   * Create a new service account
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  createServiceAccount(
    serviceAccount: {
      id: string;
      userId: string;
      name: string;
      description?: string;
      tokenPrefix: string;
      tokenEncrypted: any;
      allowedUserIds: string[];
      expiresAt?: Date;
    },
    authToken?: string
  ): Promise<boolean>;

  /**
   * Get all service accounts for a user
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getServiceAccounts(
    userId: string,
    authToken?: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      name: string;
      description?: string;
      tokenPrefix: string;
      allowedUserIds: string[];
      enabled: boolean;
      expiresAt?: Date;
      createdAt: Date;
      updatedAt: Date;
      lastUsedAt?: Date;
    }>
  >;

  /**
   * Get a specific service account by ID (returns encrypted token)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getServiceAccount(
    id: string,
    userId: string,
    authToken?: string
  ): Promise<{
    id: string;
    userId: string;
    name: string;
    description?: string;
    tokenPrefix: string;
    tokenEncrypted: any;
    allowedUserIds: string[];
    enabled: boolean;
    expiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    lastUsedAt?: Date;
  } | null>;

  /**
   * Get service account by token prefix (for validation)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getServiceAccountByPrefix(
    tokenPrefix: string,
    authToken?: string
  ): Promise<{
    id: string;
    userId: string;
    name: string;
    tokenEncrypted: any;
    allowedUserIds: string[];
    enabled: boolean;
    expiresAt?: Date;
    rateLimitWindowStart?: Date;
    rateLimitRequestsCount: number;
  } | null>;

  /**
   * Update service account properties
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateServiceAccount(
    id: string,
    userId: string,
    updates: {
      name?: string;
      description?: string;
      allowedUserIds?: string[];
      enabled?: boolean;
      tokenEncrypted?: any;
    },
    authToken?: string
  ): Promise<boolean>;

  /**
   * Delete a service account
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  deleteServiceAccount(id: string, userId: string, authToken?: string): Promise<boolean>;

  /**
   * Update service account usage tracking
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateServiceAccountUsage(id: string, authToken?: string): Promise<boolean>;

  /**
   * Update rate limit counters for a service account
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  updateServiceAccountRateLimit(
    id: string,
    requestsCount: number,
    windowStart: Date,
    authToken?: string
  ): Promise<boolean>;

  /**
   * Create a service account audit log entry
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  createServiceAccountAuditLog(
    log: {
      serviceAccountId: string;
      userId: string;
      action: 'create' | 'update' | 'delete' | 'rotate' | 'regenerate' | 'use';
      details?: any;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      errorMessage?: string;
    },
    authToken?: string
  ): Promise<boolean>;

  /**
   * Get audit logs for a service account
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  getServiceAccountAuditLogs(
    serviceAccountId: string,
    options?: {
      limit?: number;
      offset?: number;
      action?: string;
      success?: boolean;
    },
    authToken?: string
  ): Promise<
    Array<{
      id: string;
      serviceAccountId: string;
      userId: string;
      action: string;
      details?: any;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      errorMessage?: string;
      createdAt: Date;
    }>
  >;
}
