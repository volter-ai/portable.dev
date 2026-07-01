/**
 * JsonDbAdapter - JSON file-backed chat/message persistence
 *
 * Implements the full {@link DbAdapter} interface, but persists ONLY chats and
 * messages to JSON files on the per-user workspace volume (via {@link JsonChatStore}).
 * Every other domain (connections, themes, service accounts, push subscriptions)
 * is delegated unchanged to a wrapped adapter. The wrapped adapter is kept
 * intact so the backend remains swappable.
 *
 * LEGACY: this adapter is no longer wired in `server.ts` (the local-first runtime
 * uses SqliteDbAdapter); it is retained as the migration source + rollback path.
 *
 * Read parity: chat reads run through the same DataTransformer.transformChatFromDb
 * used by the SQLite adapter, so callers see an identical shape (snake_case row +
 * camelCase aliases, boolean→number for hidden/archived).
 */

import * as path from 'path';

import { WORKSPACE_DIR } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { JsonChatStore, type ChatRow } from './JsonChatStore.js';
import { DataTransformer } from '../utils/DataTransformer.js';

import type { ChatOrigin, DbAdapter, SaveChatOptions } from '../DbAdapter.js';
import type {
  StoredChat,
  ChatCategory,
  ChatStatus,
  BufferedMessage,
  ServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

/** A `category` (mobile 3-way bucket) supersedes the legacy `archived` boolean. */
function jsonChatMatchesCategory(
  c: ChatRow,
  category: ChatCategory | undefined,
  archived: boolean | undefined
): boolean {
  if (category === 'active') return !c.archived && !c.saved;
  if (category === 'saved') return !!c.saved;
  if (category === 'archived') return !!c.archived;
  return archived === undefined ? true : c.archived === archived;
}

/** Pinned chats float to the top, then recency. */
function jsonPinnedThenRecent(a: ChatRow, b: ChatRow): number {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.last_updated - a.last_updated;
}

export class JsonDbAdapter implements DbAdapter {
  private readonly store: JsonChatStore;
  private readonly transformer = new DataTransformer();

  /**
   * @param wrapped Wrapped adapter handling all non-chat/message domains.
   * @param dataDir  Directory for chat/message JSON files. Defaults to
   *                 `<WORKSPACE_DIR>/.chat-data` (persistent workspace volume).
   */
  constructor(
    private readonly wrapped: DbAdapter,
    dataDir?: string
  ) {
    // Default to a dedicated dir on the persistent workspace volume so chat data
    // survives sandbox restarts (see CLAUDE.md "Claude Code Persistence").
    const resolvedDir = dataDir ?? path.join(WORKSPACE_DIR, '.chat-data');
    this.store = new JsonChatStore(resolvedDir);
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  async initialize(): Promise<boolean> {
    await this.store.initialize();
    // The wrapped adapter still backs connections/themes/etc., so initialize it
    // too. Its failure should not be masked by the local FS being ready.
    const wrappedOk = await this.wrapped.initialize();
    console.log('[JsonDbAdapter] Initialized (chats/messages on JSON, other domains delegated)');
    return wrappedOk;
  }

  async isHealthy(): Promise<boolean> {
    // Chat/message storage is local FS (always reachable once initialized);
    // overall health tracks the wrapped backend used by the other domains.
    return this.wrapped.isHealthy();
  }

  getAdapterType(): string {
    return `JSON(chats) + ${this.wrapped.getAdapterType()}(other)`;
  }

  // ==========================================================================
  // CHAT METHODS (JSON)
  // ==========================================================================

  async saveChat(options: SaveChatOptions): Promise<boolean> {
    const {
      userId,
      chatId,
      type,
      title,
      status,
      repoPath,
      sessionId,
      systemPrompt,
      playwrightDevice,
      summary,
      model,
      permissions,
      agentSetupId,
      parentChatId,
      workflowRunId,
    } = options;

    await this.store.upsertChat(chatId, (existing) => {
      const now = Date.now();
      // saveChat upsert: preserves selected existing fields, applies schema
      // defaults, and (as on upsert) resets hidden/archived to false.
      const row: ChatRow = {
        id: chatId,
        user_id: userId,
        type,
        title,
        summary: summary !== undefined ? summary : (existing?.summary ?? null),
        status: status ?? null,
        hidden: false,
        archived: false,
        last_updated: now,
        repo_path: repoPath ?? null,
        session_id: sessionId ?? null,
        system_prompt: systemPrompt ?? null,
        playwright_device:
          playwrightDevice !== undefined ? playwrightDevice : (existing?.playwright_device ?? null),
        model: model !== undefined ? model : (existing?.model ?? DEFAULT_MODEL_MODE),
        permissions:
          permissions !== undefined ? permissions : (existing?.permissions ?? 'bypass_permissions'),
        effort: existing?.effort ?? null,
        agent_setup_id:
          agentSetupId !== undefined ? agentSetupId : (existing?.agent_setup_id ?? 'freestyle'),
        parent_chat_id:
          parentChatId !== undefined ? parentChatId : (existing?.parent_chat_id ?? null),
        workflow_run_id: workflowRunId ?? null,
        routine_id: existing?.routine_id ?? null,
        last_read_message_id: existing?.last_read_message_id ?? null,
        linked_issue: existing?.linked_issue ?? null,
        created_at: existing?.created_at ?? now,
      };
      return row;
    });

    return true;
  }

  async getChats(
    userId: string,
    _authToken?: string,
    archived?: boolean,
    _portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<StoredChat[]> {
    const chats = await this.store.readAllChats();
    return Array.from(chats.values())
      .filter((c) => c.user_id === userId)
      .filter((c) => jsonChatMatchesCategory(c, category, archived))
      .sort(jsonPinnedThenRecent)
      .map((c) => this.transformer.transformChatFromDb(c));
  }

  async getChatsWithPreviews(
    userId: string,
    limit: number = 50,
    offset: number = 0,
    _authToken?: string,
    archived?: boolean,
    _portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<any[]> {
    const chats = await this.store.readAllChats();
    const page = Array.from(chats.values())
      .filter((c) => c.user_id === userId)
      .filter((c) => jsonChatMatchesCategory(c, category, archived))
      .sort(jsonPinnedThenRecent)
      .slice(offset, offset + limit);

    const previews = await Promise.all(
      page.map(async (chat) => {
        const messages = await this.store.readMessages(chat.id); // ordered by timestamp asc
        const firstUserMessage = messages.find((m) => m.type === 'user_message');
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
        return {
          ...this.transformer.transformChatFromDb(chat),
          message_count: messages.length,
          first_message_data: firstUserMessage?.data,
          last_message_data: lastMessage?.data,
        };
      })
    );

    return previews;
  }

  async getChat(
    chatId: string,
    userId: string,
    _authToken?: string
  ): Promise<StoredChat | undefined> {
    const chat = await this.store.getChat(chatId);
    if (!chat || chat.user_id !== userId) {
      return undefined;
    }
    return this.transformer.transformChatFromDb(chat);
  }

  /**
   * Legacy JSON adapter has no transcript discovery, so a chatId is either a real row
   * ('sqlite') or unknown ('none') — it never forks. (fork-on-first-write.)
   */
  async getChatOrigin(chatId: string, userId: string, _authToken?: string): Promise<ChatOrigin> {
    const chat = await this.store.getChat(chatId);
    return chat && chat.user_id === userId ? { origin: 'sqlite' } : { origin: 'none' };
  }

  async updateChatStatus(
    chatId: string,
    userId: string,
    status: ChatStatus,
    _authToken?: string
  ): Promise<boolean> {
    // Status update is best-effort and reports success regardless.
    await this.store.patchChat(chatId, userId, () => ({ status }));
    return true;
  }

  async updateChatTitle(
    chatId: string,
    userId: string,
    title: string,
    _authToken?: string
  ): Promise<boolean> {
    // Title update is best-effort and reports success regardless.
    await this.store.patchChat(chatId, userId, () => ({ title }));
    return true;
  }

  async updateChatSummary(
    chatId: string,
    userId: string,
    summary: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ summary }));
  }

  async deleteChat(chatId: string, userId: string, _authToken?: string): Promise<boolean> {
    return this.store.deleteChat(chatId, userId);
  }

  async archiveChat(
    chatId: string,
    userId: string,
    archived: boolean,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () =>
      archived ? { archived: true, saved: false } : { archived: false }
    );
  }

  async setChatSaved(
    chatId: string,
    userId: string,
    saved: boolean,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () =>
      saved ? { saved: true, archived: false } : { saved: false }
    );
  }

  async setChatPinned(
    chatId: string,
    userId: string,
    pinned: boolean,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ pinned }));
  }

  async updateChatSession(
    chatId: string,
    userId: string,
    sessionId: string,
    systemPrompt: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({
      session_id: sessionId,
      system_prompt: systemPrompt,
    }));
  }

  async updatePlaywrightDevice(
    chatId: string,
    userId: string,
    device: 'mobile' | 'desktop',
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ playwright_device: device }));
  }

  async updatePermissions(
    chatId: string,
    userId: string,
    permissions: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ permissions }));
  }

  async updateModel(
    chatId: string,
    userId: string,
    model: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ model }));
  }

  async updateEffort(
    chatId: string,
    userId: string,
    effort: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ effort }));
  }

  async updateAgentSetupId(
    chatId: string,
    userId: string,
    agentSetupId: string,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ agent_setup_id: agentSetupId }));
  }

  async updateLastReadMessageId(
    chatId: string,
    userId: string,
    messageId: number,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ last_read_message_id: messageId }));
  }

  async updateLinkedIssue(
    chatId: string,
    userId: string,
    linkedIssue: { owner: string; repo: string; number: number } | null,
    _authToken?: string
  ): Promise<boolean> {
    return this.store.patchChat(chatId, userId, () => ({ linked_issue: linkedIssue }));
  }

  async getLastChatActivityByRepo(
    userId: string,
    _authToken?: string
  ): Promise<Map<string, string>> {
    const chats = await this.store.readAllChats();
    const activityMap = new Map<string, string>();

    for (const row of chats.values()) {
      if (row.user_id !== userId || !row.repo_path || !row.last_updated) {
        continue;
      }
      const existing = activityMap.get(row.repo_path);
      const existingTime = existing ? new Date(existing).getTime() : 0;
      if (row.last_updated > existingTime) {
        activityMap.set(row.repo_path, new Date(row.last_updated).toISOString());
      }
    }

    return activityMap;
  }

  async getChatsByWorkflowRunId(workflowRunId: string, _authToken?: string): Promise<StoredChat[]> {
    const chats = await this.store.readAllChats();
    return Array.from(chats.values())
      .filter((c) => c.workflow_run_id === workflowRunId)
      .sort((a, b) => b.created_at - a.created_at)
      .map((c) => this.transformer.transformChatFromDb(c));
  }

  // ==========================================================================
  // MESSAGE METHODS (JSON)
  // ==========================================================================

  async saveMessage(
    chatId: string,
    type: string,
    data: any,
    timestamp: number,
    _authToken?: string
  ): Promise<boolean> {
    await this.store.appendMessage(chatId, type, data, timestamp);
    return true;
  }

  async getMessages(chatId: string, _authToken?: string): Promise<BufferedMessage[]> {
    return this.store.readMessages(chatId);
  }

  async getMessageCount(chatId: string, _authToken?: string): Promise<number> {
    return this.store.getMessageCount(chatId);
  }

  // ==========================================================================
  // DELEGATED DOMAINS (connections, themes, service accounts, push)
  // All forwarded unchanged to the wrapped adapter.
  // ==========================================================================

  // --- Connections ---
  getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]> {
    return this.wrapped.getUserConnections(options);
  }
  getConnectionCredentials(options: GetConnectionOptions): Promise<any | null> {
    return this.wrapped.getConnectionCredentials(options);
  }
  getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null> {
    return this.wrapped.getConnection(options);
  }
  getConnectionsByService(options: GetConnectionsByServiceOptions): Promise<ServiceConnection[]> {
    return this.wrapped.getConnectionsByService(options);
  }
  storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
    return this.wrapped.storeConnection(options);
  }
  deleteConnection(options: GetConnectionOptions): Promise<void> {
    return this.wrapped.deleteConnection(options);
  }
  renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection> {
    return this.wrapped.renameConnection(options);
  }
  toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection> {
    return this.wrapped.toggleConnectionActive(options);
  }
  getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.wrapped.getActiveConnectionsByService(options);
  }
  hasConnection(options: GetConnectionOptions): Promise<boolean> {
    return this.wrapped.hasConnection(options);
  }

  // --- Themes ---
  getTheme(userEmail: string, authToken?: string): Promise<Record<string, any> | null> {
    return this.wrapped.getTheme(userEmail, authToken);
  }
  saveTheme(
    userEmail: string,
    themeConfig: Record<string, any>,
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.saveTheme(userEmail, themeConfig, authToken);
  }
  deleteTheme(userEmail: string, authToken?: string): Promise<boolean> {
    return this.wrapped.deleteTheme(userEmail, authToken);
  }

  // --- Service Accounts ---
  createServiceAccount(
    serviceAccount: Parameters<DbAdapter['createServiceAccount']>[0],
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.createServiceAccount(serviceAccount, authToken);
  }
  getServiceAccounts(
    userId: string,
    authToken?: string
  ): ReturnType<DbAdapter['getServiceAccounts']> {
    return this.wrapped.getServiceAccounts(userId, authToken);
  }
  getServiceAccount(
    id: string,
    userId: string,
    authToken?: string
  ): ReturnType<DbAdapter['getServiceAccount']> {
    return this.wrapped.getServiceAccount(id, userId, authToken);
  }
  getServiceAccountByPrefix(
    tokenPrefix: string,
    authToken?: string
  ): ReturnType<DbAdapter['getServiceAccountByPrefix']> {
    return this.wrapped.getServiceAccountByPrefix(tokenPrefix, authToken);
  }
  updateServiceAccount(
    id: string,
    userId: string,
    updates: Parameters<DbAdapter['updateServiceAccount']>[2],
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.updateServiceAccount(id, userId, updates, authToken);
  }
  deleteServiceAccount(id: string, userId: string, authToken?: string): Promise<boolean> {
    return this.wrapped.deleteServiceAccount(id, userId, authToken);
  }
  updateServiceAccountUsage(id: string, authToken?: string): Promise<boolean> {
    return this.wrapped.updateServiceAccountUsage(id, authToken);
  }
  updateServiceAccountRateLimit(
    id: string,
    requestsCount: number,
    windowStart: Date,
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.updateServiceAccountRateLimit(id, requestsCount, windowStart, authToken);
  }
  createServiceAccountAuditLog(
    log: Parameters<DbAdapter['createServiceAccountAuditLog']>[0],
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.createServiceAccountAuditLog(log, authToken);
  }
  getServiceAccountAuditLogs(
    serviceAccountId: string,
    options?: Parameters<DbAdapter['getServiceAccountAuditLogs']>[1],
    authToken?: string
  ): ReturnType<DbAdapter['getServiceAccountAuditLogs']> {
    return this.wrapped.getServiceAccountAuditLogs(serviceAccountId, options, authToken);
  }

  // --- Push Subscriptions ---
  savePushSubscription(
    userId: string,
    subscription: Parameters<DbAdapter['savePushSubscription']>[1],
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.savePushSubscription(userId, subscription, authToken);
  }
  removePushSubscription(userId: string, endpoint: string, authToken?: string): Promise<boolean> {
    return this.wrapped.removePushSubscription(userId, endpoint, authToken);
  }
  getUserPushSubscriptions(
    userId: string,
    authToken?: string
  ): ReturnType<DbAdapter['getUserPushSubscriptions']> {
    return this.wrapped.getUserPushSubscriptions(userId, authToken);
  }
  getNotificationSettings(
    userId: string,
    authToken?: string
  ): ReturnType<DbAdapter['getNotificationSettings']> {
    return this.wrapped.getNotificationSettings(userId, authToken);
  }
  updateNotificationSettings(
    userId: string,
    settings: Parameters<DbAdapter['updateNotificationSettings']>[1],
    authToken?: string
  ): Promise<boolean> {
    return this.wrapped.updateNotificationSettings(userId, settings, authToken);
  }
}
