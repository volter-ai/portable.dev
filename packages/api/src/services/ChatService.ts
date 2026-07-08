import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { SOPService } from './SOPService.js';
import { DbAdapter, type ChatOrigin } from '../db/DbAdapter.js';
import { BufferedMessage } from '../types/index.js';

import type { ChatStatus, StoredChat, ChatType, ChatCategory } from '@vgit2/shared/types';

/**
 * Options for saving a chat via ChatService
 *
 * Note: model, permissions, and agentSetupId are REQUIRED for new chats.
 * These ensure chats have proper configuration for the UI and execution.
 */
export interface SaveChatServiceOptions {
  userId: string;
  chatId: string;
  type: ChatType;
  title: string;
  status?: ChatStatus;
  repoPath?: string;
  /** GitHub full_name (owner/repo) for the chat's repo, when known. */
  repoFullName?: string;
  /** Original Claude Code session id to FORK from on first run (fork-on-first-write). */
  forkSourceSessionId?: string;
  /**
   * Pre-set session id (rev12 adopt-on-first-write): the ADOPTED terminal
   * session's id, so the first run RESUMES in place ({ resume } without
   * forkSession) instead of forking. Mutually exclusive with
   * `forkSourceSessionId`. Normal chats leave it unset (the SDK init sets it).
   */
  sessionId?: string;
  /** Required - Agent setup determines system prompt and behavior */
  agentSetupId: string;
  /** Required - Model selection (sonnet, haiku, etc.) */
  model: string;
  /** Required - Permission mode (default, allow_all, ask_each_time) */
  permissions: string;
  parentChatId?: string;
  authToken?: string;
}

/**
 * ChatService handles chat message buffering and persistence
 *
 * Uses in-memory buffer for fast access and local SQLite for long-term persistence.
 */
export class ChatService {
  private globalMessageBuffer: Map<string, BufferedMessage[]>;
  public readonly dbAdapter: DbAdapter; // Public for use by other services
  private messageIdCounters: Map<string, number>;
  private onChatCreated?: (userId: string, chat: any) => void;
  private sopService?: SOPService; // Optional: For SOP worksheet cleanup

  constructor(dbAdapter: DbAdapter, sopService?: SOPService) {
    this.globalMessageBuffer = new Map();
    this.messageIdCounters = new Map();
    this.dbAdapter = dbAdapter;
    this.sopService = sopService;

    console.log(`[ChatService] Initialized with ${dbAdapter.getAdapterType()} database adapter`);
  }

  /**
   * Register callback for when a chat is created
   * Used by SocketIOService to notify clients
   */
  setOnChatCreated(callback: (userId: string, chat: any) => void): void {
    this.onChatCreated = callback;
  }

  /**
   * Add a message to the buffer and persist to database
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async bufferMessage(
    userId: string,
    chatId: string,
    type: string,
    data: any,
    authToken?: string
  ): Promise<void> {
    // Verbose log disabled - too noisy
    // console.log(`[ChatService] bufferMessage: type=${type}, chatId=${chatId}`);
    const timestamp = Date.now();

    // Buffer to in-memory for fast access
    this.bufferToMemory(userId, chatId, type, data, timestamp);

    // Persist to database (now awaited to prevent race conditions)
    try {
      await this.persistToDatabase(userId, chatId, type, data, timestamp, authToken);
    } catch (error) {
      console.error('[ChatService] Error persisting message:', error);
      throw error; // Re-throw to let caller handle
    }
  }

  /**
   * Buffer message to in-memory Map
   */
  private bufferToMemory(
    userId: string,
    chatId: string,
    type: string,
    data: any,
    timestamp: number
  ): void {
    const key = `${userId}:${chatId}`;

    if (!this.globalMessageBuffer.has(key)) {
      this.globalMessageBuffer.set(key, []);
      this.messageIdCounters.set(chatId, 1);
    }

    // Get next message ID for this chat (in-memory counter)
    const messageId = this.messageIdCounters.get(chatId) || 1;
    this.messageIdCounters.set(chatId, messageId + 1);

    const prunedData = data;

    const buffer = this.globalMessageBuffer.get(key)!;
    buffer.push({ id: messageId, type, data: prunedData, timestamp });

    // Keep only last 1000 messages per chat to prevent memory issues
    if (buffer.length > 1000) {
      buffer.shift();
    }
  }

  /**
   * Persist a message to the database (private helper)
   * Called asynchronously from bufferMessage to avoid blocking real-time flow
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  private async persistToDatabase(
    userId: string,
    chatId: string,
    type: string,
    data: any,
    timestamp: number,
    authToken?: string
  ): Promise<void> {
    // Handle chat creation/updates
    if (type === 'claude_code_start') {
      // Check if chat already exists (user_message may have created it first)
      const existingChat = await this.dbAdapter.getChat(chatId, userId, authToken);

      if (existingChat) {
        // Chat already exists (created by user_message) - update status and ensure repo_path is set
        console.log(
          `[ChatService] Updating existing Claude Code chat: ${chatId}, preserving title: ${existingChat.title?.substring(0, 50) || '(untitled)'}`
        );
        console.log(`[ChatService] Existing chat has agentSetupId: ${existingChat.agent_setup_id}`);
        // Use saveChat to update both status and repo_path while preserving title and summary
        await this.dbAdapter.saveChat({
          userId,
          chatId,
          type: 'claude_code',
          title: existingChat.title, // Preserve existing title
          status: 'running',
          repoPath: data.repo_path, // Set repo_path from claude_code_start data
          sessionId: existingChat.session_id || undefined, // Preserve session_id
          systemPrompt: existingChat.system_prompt || undefined, // Preserve system_prompt
          playwrightDevice: existingChat.playwright_device || undefined, // Preserve playwright_device
          summary: existingChat.summary || undefined, // Preserve summary
          model: data.model || existingChat.model || undefined, // Set model from data or preserve existing
          permissions: data.permissions || existingChat.permissions || undefined, // Set permissions from data or preserve existing
          agentSetupId: existingChat.agent_setup_id || undefined, // Preserve agentSetupId
          authToken,
        });
      } else {
        // Chat doesn't exist yet - create with empty title
        console.log(`[ChatService] Creating Claude Code chat: ${chatId} for user ${userId}`);
        await this.dbAdapter.saveChat({
          userId,
          chatId,
          type: 'claude_code',
          title: '', // Empty title - will be set from first user message
          status: 'running',
          repoPath: data.repo_path,
          sessionId: undefined,
          systemPrompt: undefined,
          playwrightDevice: undefined,
          summary: undefined,
          model: data.model || DEFAULT_MODEL_MODE,
          permissions:
            data.permissions ||
            (() => {
              throw new Error(`Cannot create chat ${chatId}: permissions not provided`);
            })(),
          agentSetupId: undefined, // not provided for new chats (will use default)
          authToken,
        });
      }

      // Notify about chat creation
      if (this.onChatCreated) {
        const chat = await this.dbAdapter.getChat(chatId, userId, authToken);
        if (chat) {
          this.onChatCreated(userId, chat);
        }
      }
    } else if (type === 'user_message' || type === 'assistant_message') {
      // Try to find existing chat with retry logic (handles race condition with chat:create)
      let existingChat = await this.dbAdapter.getChat(chatId, userId, authToken);
      let retries = 0;
      const maxRetries = 3;
      const retryDelay = 100; // ms

      while (!existingChat && retries < maxRetries) {
        console.log(
          `[ChatService] Chat ${chatId} not found, retrying (${retries + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        existingChat = await this.dbAdapter.getChat(chatId, userId, authToken);
        retries++;
      }

      // Auto-create chat if it doesn't exist (fallback for edge cases)
      if (!existingChat) {
        console.log(
          `[ChatService] Chat ${chatId} not found after ${maxRetries} retries, auto-creating...`
        );

        // Extract title from message content (truncate if too long)
        const messageContent = data?.content || '';
        const title =
          messageContent.length > 100
            ? messageContent.substring(0, 100) + '...'
            : messageContent || 'New Chat';

        // Create chat with available data
        await this.dbAdapter.saveChat({
          userId,
          chatId,
          type: 'claude_code',
          title,
          status: 'completed', // Will be updated to "running" when Claude starts
          repoPath: undefined, // will be set later if available
          sessionId: undefined,
          systemPrompt: undefined,
          playwrightDevice: undefined,
          summary: undefined,
          model: data?.model || DEFAULT_MODEL_MODE,
          permissions: data?.permissions || 'bypass_permissions',
          agentSetupId: data?.agentSetupId || 'freestyle', // Default to 'freestyle' (the unopinionated direct-execution agent)
          authToken,
        });

        console.log(`[ChatService] ✓ Auto-created chat ${chatId}: "${title.substring(0, 50)}..."`);

        // Notify about chat creation
        if (this.onChatCreated) {
          const chat = await this.dbAdapter.getChat(chatId, userId, authToken);
          if (chat) {
            this.onChatCreated(userId, chat);
          }
        }
      }
    } else if (type === 'claude_code_complete') {
      console.log(`[ChatService] Marking chat ${chatId} as completed`);
      await this.dbAdapter.updateChatStatus(chatId, userId, 'completed', authToken);
    } else if (type === 'claude_code_error') {
      console.log(`[ChatService] Marking chat ${chatId} as error`);
      await this.dbAdapter.updateChatStatus(chatId, userId, 'error', authToken);
    } else if (type === 'chat_status_update' && data?.status) {
      // Update database when receiving status updates (idle, running, etc.)
      console.log(`[ChatService] Updating chat ${chatId} status to: ${data.status}`);
      await this.dbAdapter.updateChatStatus(chatId, userId, data.status as ChatStatus, authToken);
    }

    const prunedData = data;

    // Save the message
    await this.dbAdapter.saveMessage(chatId, type, prunedData, timestamp, authToken);
  }

  /**
   * Load messages from database into in-memory buffer
   * Used when buffer is empty (e.g., after server restart)
   */
  private async loadMessagesFromDatabase(
    userId: string,
    chatId: string,
    authToken?: string
  ): Promise<BufferedMessage[]> {
    // Verbose log disabled - too noisy
    // console.log(
    //   `[ChatService] Loading messages from database for ${userId}:${chatId}`
    // );

    try {
      const messages = await this.dbAdapter.getMessages(chatId, authToken);

      // Populate the in-memory buffer for future access
      const key = `${userId}:${chatId}`;
      this.globalMessageBuffer.set(key, messages);

      // Sync message ID counter based on loaded messages
      if (messages.length > 0) {
        const maxId = Math.max(...messages.map((m: any) => m.id || 0));
        this.messageIdCounters.set(chatId, maxId + 1);
      } else {
        this.messageIdCounters.set(chatId, 1);
      }

      // Verbose log disabled - too noisy
      // console.log(
      //   `[ChatService] Loaded ${messages.length} messages from database into buffer`
      // );
      return messages;
    } catch (error) {
      console.error(`[ChatService] Error loading messages from database:`, error);
      return [];
    }
  }

  /**
   * Get buffered messages for a specific chat
   * Priority: Memory → Database (lazy load)
   */
  async getBufferedMessages(
    userId: string,
    chatId: string,
    since?: number,
    authToken?: string
  ): Promise<BufferedMessage[]> {
    let buffer: BufferedMessage[] = [];

    // Try in-memory buffer first
    const key = `${userId}:${chatId}`;
    const memoryBuffer = this.globalMessageBuffer.get(key);

    if (memoryBuffer && memoryBuffer.length > 0) {
      buffer = memoryBuffer;
      // Verbose log disabled - too noisy
      // console.log(`[ChatService] Loaded ${buffer.length} messages from memory for ${key}`);
    }

    // Lazy load from database if memory is empty
    if (buffer.length === 0) {
      // Verbose log disabled - too noisy
      // console.log(`[ChatService] Buffer empty, loading from database for ${userId}:${chatId}...`);
      buffer = await this.loadMessagesFromDatabase(userId, chatId, authToken);
    }

    // Ensure all messages have IDs (for backwards compatibility with old data)
    buffer = buffer.map((msg, index) => ({
      ...msg,
      id: msg.id || index + 1,
    }));

    if (since) {
      return buffer.filter((msg) => msg.timestamp > since);
    }

    return buffer;
  }

  /**
   * Clear buffer for a specific chat
   */
  async clearBuffer(userId: string, chatId: string): Promise<void> {
    const key = `${userId}:${chatId}`;
    this.globalMessageBuffer.delete(key);
    console.log(`[ChatService] Cleared buffer for ${key}`);
  }

  /**
   * Get all chats for a user
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @param archived - Optional filter: true for archived only, false for non-archived only, undefined for all
   */
  async getChats(
    userId: string,
    authToken?: string,
    archived?: boolean,
    portableOnly?: boolean,
    category?: ChatCategory
  ): Promise<StoredChat[]> {
    return this.dbAdapter.getChats(userId, authToken, archived, portableOnly, category);
  }

  /**
   * Get a specific chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async getChat(
    chatId: string,
    userId: string,
    authToken?: string
  ): Promise<StoredChat | undefined> {
    return this.dbAdapter.getChat(chatId, userId, authToken);
  }

  /**
   * Classify a chatId's origin (fork-on-first-write): a real Portable row
   * ('sqlite'), a discovered Claude Code terminal transcript ('discovered' — the one to
   * FORK), or unknown ('none'). Thin delegate to the db adapter.
   */
  async getChatOrigin(chatId: string, userId: string, authToken?: string): Promise<ChatOrigin> {
    return this.dbAdapter.getChatOrigin(chatId, userId, authToken);
  }

  /**
   * Save or update a chat
   * Uses an options object for better maintainability and type safety
   */
  async saveChat(options: SaveChatServiceOptions): Promise<boolean> {
    const {
      userId,
      chatId,
      type,
      title,
      status,
      repoPath,
      repoFullName,
      forkSourceSessionId,
      sessionId,
      agentSetupId,
      model,
      permissions,
      parentChatId,
      authToken,
    } = options;

    // Validate required fields
    if (!model) {
      throw new Error(`[ChatService] Cannot save chat ${chatId}: model is required`);
    }
    if (!permissions) {
      throw new Error(`[ChatService] Cannot save chat ${chatId}: permissions is required`);
    }
    if (!agentSetupId) {
      throw new Error(`[ChatService] Cannot save chat ${chatId}: agentSetupId is required`);
    }

    console.log(`[ChatService] saveChat called with:`, {
      chatId,
      agentSetupId,
      model,
      permissions,
      parentChatId,
      hasAuthToken: !!authToken,
    });

    const result = await this.dbAdapter.saveChat({
      userId,
      chatId,
      type,
      title,
      status,
      repoPath,
      repoFullName,
      // rev12 adopt-on-first-write: an adopted terminal chat is saved WITH its
      // session id so the first run resumes in place. Normal chats pass none.
      sessionId,
      forkSourceSessionId,
      systemPrompt: undefined,
      playwrightDevice: undefined,
      summary: undefined,
      model,
      permissions,
      agentSetupId,
      parentChatId,
      authToken,
    });

    if (!result) {
      console.error(`[ChatService] Failed to save chat ${chatId}`);
    }

    return result;
  }

  /**
   * Update chat status
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateChatStatus(
    chatId: string,
    userId: string,
    status: ChatStatus,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.updateChatStatus(chatId, userId, status, authToken);
  }

  /**
   * Update chat session info
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateChatSession(
    chatId: string,
    userId: string,
    sessionId: string,
    systemPrompt: string,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.updateChatSession(chatId, userId, sessionId, systemPrompt, authToken);
  }

  /**
   * Update Playwright device mode for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updatePlaywrightDevice(
    chatId: string,
    userId: string,
    device: 'mobile' | 'desktop',
    authToken?: string
  ): Promise<boolean> {
    return await this.dbAdapter.updatePlaywrightDevice(chatId, userId, device, authToken);
  }

  /**
   * Update the permissions mode for a chat
   * Used when user selects a permission mode from ExitPlanMode buttons
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updatePermissions(
    chatId: string,
    userId: string,
    permissions: string,
    authToken?: string
  ): Promise<boolean> {
    return await this.dbAdapter.updatePermissions(chatId, userId, permissions, authToken);
  }

  /**
   * Update chat settings (model and/or permissions and/or agentSetupId)
   * Used when user changes settings in the UI
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateChatSettings(
    chatId: string,
    userId: string,
    settings: {
      model?: string;
      permissions?: string;
      agentSetupId?: string;
      effort?: string;
    },
    authToken?: string
  ): Promise<void> {
    // Update model if provided
    if (settings.model !== undefined) {
      await this.dbAdapter.updateModel(chatId, userId, settings.model, authToken);
    }

    // Update permissions if provided
    if (settings.permissions !== undefined) {
      await this.dbAdapter.updatePermissions(chatId, userId, settings.permissions, authToken);
    }

    // Update agentSetupId if provided
    if (settings.agentSetupId !== undefined) {
      await this.dbAdapter.updateAgentSetupId(chatId, userId, settings.agentSetupId, authToken);
    }

    // Update effort if provided
    if (settings.effort !== undefined) {
      await this.dbAdapter.updateEffort(chatId, userId, settings.effort, authToken);
    }
  }

  /**
   * Update the last read message ID for a chat.
   * Used to track unread messages — best-effort, so it never throws.
   *
   * Returns `false` (without persisting) when the chat has no persistent row,
   * e.g. a discovered/terminal chat sourced only from the shared
   * `~/.claude/projects` transcripts — those have nowhere to store a read
   * cursor and are not an error. A genuine IO failure still throws from the
   * adapter's write and propagates to the caller.
   *
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateLastReadMessageId(
    chatId: string,
    userId: string,
    messageId: number,
    authToken?: string
  ): Promise<boolean> {
    return this.dbAdapter.updateLastReadMessageId(chatId, userId, messageId, authToken);
  }

  /**
   * Update linked GitHub issue for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateLinkedIssue(
    chatId: string,
    userId: string,
    linkedIssue: { owner: string; repo: string; number: number } | null,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.updateLinkedIssue(chatId, userId, linkedIssue, authToken);
  }

  /**
   * Get the total count of messages for a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async getMessageCount(chatId: string, authToken?: string): Promise<number> {
    return this.dbAdapter.getMessageCount(chatId, authToken);
  }

  /**
   * Get chat messages (history)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async getMessages(chatId: string, authToken?: string): Promise<BufferedMessage[]> {
    return this.dbAdapter.getMessages(chatId, authToken);
  }

  /**
   * Get messages after a specific message ID (for polling)
   * If afterId=0, returns the LATEST N messages (for initial sync)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async getMessagesAfterId(
    chatId: string,
    afterId: number,
    limit: number = 50,
    authToken?: string
  ): Promise<BufferedMessage[]> {
    const messages = await this.dbAdapter.getMessages(chatId, authToken);

    // Special case: afterId=0 means initial sync
    if (afterId === 0) {
      console.log(
        `[ChatService] getMessagesAfterId: chatId=${chatId}, total messages=${messages.length}, limit=${limit}`
      );

      // Message A: Start at the latest message
      const messageA = messages.length - 1;

      // Message B: Count backwards `limit` messages from A
      const messageB = Math.max(0, messageA - limit + 1);

      console.log(
        `[ChatService] Message A (latest): ${messageA}, Message B (${limit} back): ${messageB}`
      );

      // Search backwards from BEFORE messageB to find a Task tool (message C)
      let messageC = -1;

      for (let i = messageB - 1; i >= 0; i--) {
        const message = messages[i];

        // Check if this is a claude_code_block message with a Task tool
        if (
          message.type === 'claude_code_block' &&
          message.data &&
          message.data.type === 'tool_use' &&
          message.data.toolName === 'Task'
        ) {
          messageC = i;
          console.log(`[ChatService] ✓ Found Task tool at index ${i} (message C)`);
          break;
        }
      }

      // If Task tool found (messageC), return from C onwards
      // Otherwise return from B onwards
      const startIndex = messageC !== -1 ? messageC : messageB;
      const result = messages.slice(startIndex);

      console.log(
        `[ChatService] Returning ${result.length} messages from index ${startIndex} to ${messages.length - 1}`
      );
      return result;
    }

    // Normal case: return messages after the given ID
    const filtered = messages.filter((msg: any) => msg.id > afterId);
    return filtered.slice(0, limit);
  }

  /**
   * Archive a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async archiveChat(
    chatId: string,
    userId: string,
    archived: boolean = true,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.archiveChat(chatId, userId, archived, authToken);
  }

  /**
   * Save / unsave a chat (the "Saved" category). Mutually exclusive with archive.
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async setChatSaved(
    chatId: string,
    userId: string,
    saved: boolean = true,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.setChatSaved(chatId, userId, saved, authToken);
  }

  /**
   * Pin / unpin a chat (orthogonal to the category — floats to top + highlighted).
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async setChatPinned(
    chatId: string,
    userId: string,
    pinned: boolean = true,
    authToken?: string
  ): Promise<void> {
    await this.dbAdapter.setChatPinned(chatId, userId, pinned, authToken);
  }

  /**
   * Delete a chat
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async deleteChat(chatId: string, userId: string, authToken?: string): Promise<void> {
    // Clean up SOP worksheet if SOPService is available
    if (this.sopService) {
      try {
        await this.sopService.cleanupWorksheet(chatId);
        console.log(`[ChatService] Cleaned up SOP worksheet for chat ${chatId}`);
      } catch (error) {
        console.warn(`[ChatService] Failed to cleanup SOP worksheet for chat ${chatId}:`, error);
      }
    }

    await this.dbAdapter.deleteChat(chatId, userId, authToken);
  }

  /**
   * Update chat title in database
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateChatTitle(
    chatId: string,
    userId: string,
    title: string,
    authToken?: string
  ): Promise<boolean> {
    try {
      await this.dbAdapter.updateChatTitle(chatId, userId, title, authToken);
      return true;
    } catch (error) {
      console.error('[ChatService] Error updating chat title:', error);
      return false;
    }
  }

  /**
   * Update chat summary in database
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   */
  async updateChatSummary(
    chatId: string,
    userId: string,
    summary: string,
    authToken?: string
  ): Promise<boolean> {
    try {
      await this.dbAdapter.updateChatSummary(chatId, userId, summary, authToken);
      return true;
    } catch (error) {
      console.error('[ChatService] Error updating chat summary:', error);
      return false;
    }
  }

  /**
   * Get buffer statistics
   */
  getBufferStats(): {
    totalChats: number;
    totalMessages: number;
    chats: Array<{ key: string; messageCount: number }>;
  } {
    let totalMessages = 0;
    const chats: Array<{ key: string; messageCount: number }> = [];

    for (const [key, buffer] of this.globalMessageBuffer.entries()) {
      totalMessages += buffer.length;
      chats.push({ key, messageCount: buffer.length });
    }

    return {
      totalChats: this.globalMessageBuffer.size,
      totalMessages,
      chats,
    };
  }
}
