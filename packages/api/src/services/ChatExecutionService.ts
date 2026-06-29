/**
 * ChatExecutionService
 *
 * Core execution logic for chat messages with Claude, decoupled from Socket.IO.
 *
 * This service handles:
 * - Session management (create, resume, inject messages)
 * - System prompt generation
 * - Output handling via pluggable emitters
 * - Message accumulation and persistence
 *
 * The emitter abstraction allows the same execution logic to work with:
 * - SocketEmitter: Real-time broadcast to connected clients
 * - NoOpEmitter: Headless execution (routines, testing)
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { isWorkspaceChatTarget } from '@vgit2/shared/browserConstants';
import { getUserWorkspaceDir, getWorkspaceTmpDir } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { HandshakeVerificationGate } from './HandshakeVerificationGate.js';
import { MessageDeduplicationService } from './MessageDeduplicationService.js';
import { RuntimeStateFormatter } from './RuntimeStateFormatter.js';
import { ensureWorkspaceScaffold } from './workspaceScaffold.js';
import { getAgentSetup } from '../config/agentRegistry.js';
import { OUTDATED_APP_MESSAGE } from '../constants/outdatedClient.js';
import { buildSystemPromptFromSetup } from '../prompts/systemPrompts.js';

import type { ChatService } from './ChatService.js';
import type { ClaudeService } from './ClaudeService.js';
import type { IOutputEmitter } from './emitters/IOutputEmitter.js';
import type { GitLocalService } from './GitLocalService.js';
import type { TunnelService } from './TunnelService.js';
import type { DbAdapter } from '../db/DbAdapter.js';
import type { ExecutionContext } from './types/ExecutionContext.js';
import type { AIStyleMode } from '@vgit2/shared/aiStyles';
import type { PageContext, ChatStatus } from '@vgit2/shared/types';

/**
 * Options for executing a message
 */
export interface ExecuteMessageOptions {
  pageContext?: PageContext;
  model?: string;
  permissions?: string;
  aiStyle?: AIStyleMode;
  customAiStylePrompt?: string;
  agentSetupId?: string;
  uploadedFiles?: any[];
  isCodeProject?: boolean;
}

/**
 * Accumulated assistant message during streaming
 */
interface AccumulatedMessage {
  blocks: any[];
  userId: string;
}

export class ChatExecutionService {
  // Accumulate assistant message blocks during streaming
  private assistantMessageAccumulator: Map<string, AccumulatedMessage> = new Map();

  // Per-chat execution lock to prevent concurrent executeMessage() calls for the same chat
  private executingChats: Set<string> = new Set();

  constructor(
    private chatService: ChatService,
    private claudeService: ClaudeService,
    private gitLocalService: GitLocalService,
    private messageDeduplicationService: MessageDeduplicationService,
    private tunnelService: TunnelService | undefined,
    private processTrackerService: any | undefined,
    private dbAdapter: DbAdapter | undefined,
    private pushNotificationService: any | undefined,
    private sopService: any | undefined,
    private claudeCodeSessions?: Map<string, any>, // Session map
    private reposCacheService?: any, // ReposCacheService for cache invalidation
    private handshakeVerificationGate?: HandshakeVerificationGate // block kill switch
  ) {
    console.log('[ChatExecutionService] Initialized');
  }

  /**
   * Handle chat:join event
   * Get chat messages and status
   */
  async handleChatJoin(
    context: ExecutionContext,
    data: { chatId: string; count?: number }
  ): Promise<any> {
    const { chatId, count = 50 } = data;
    const { userId, authToken } = context;

    // Get messages using Task tool logic
    const messages = await this.chatService.getMessagesAfterId(
      chatId,
      0, // afterId = 0 triggers Task tool search
      count,
      authToken
    );

    // Get total count
    const allMessages = await this.chatService.getBufferedMessages(
      userId,
      chatId,
      undefined,
      authToken
    );
    const totalCount = allMessages.length;
    const hasMore = totalCount > messages.length;

    // Get chat info
    const chat = await this.chatService.getChat(chatId, userId, authToken);
    const title = chat?.title;

    // Determine actual status from session state
    const actualStatus = this.getActualChatStatus(chatId, chat?.status);

    return {
      success: true,
      messages,
      status: actualStatus,
      title,
      hasMore,
      totalCount,
      lastReadMessageId: chat?.last_read_message_id ?? undefined,
      permissions: chat?.permissions ?? null,
    };
  }

  /**
   * Determine actual chat status from session state
   */
  private getActualChatStatus(chatId: string, dbStatus?: ChatStatus | null): string {
    if (!this.claudeCodeSessions) {
      return dbStatus || 'completed';
    }

    const session = this.claudeCodeSessions.get(chatId);

    if (!session || !session.query) {
      return dbStatus === 'running' ? 'completed' : dbStatus || 'completed';
    } else if (session.signal?.stopped) {
      return 'completed';
    } else if (session.isProcessing) {
      return 'running';
    } else {
      return dbStatus === 'idle' ? 'idle' : dbStatus || 'completed';
    }
  }

  /**
   * Handle chat:mark_read event
   */
  async handleChatMarkRead(
    context: ExecutionContext,
    data: { chatId: string; messageId: number }
  ): Promise<{ success: boolean; error?: string }> {
    const { chatId, messageId } = data;
    const { userId, authToken, emitter } = context;

    try {
      await this.chatService.updateLastReadMessageId(chatId, userId, messageId, authToken);

      console.log(
        `[ChatExecutionService] ${userId} marked chat ${chatId} as read up to message ${messageId}`
      );

      // Broadcast to all user's sockets (multi-device sync)
      if (emitter.emitToUser) {
        emitter.emitToUser(userId, 'chat:read_updated', { chatId, messageId });
      }

      return { success: true };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error marking chat ${chatId} as read:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle chat:load_more event
   * Load additional messages with pagination
   */
  async handleChatLoadMore(
    context: ExecutionContext,
    data: { chatId: string; afterId: number; limit?: number }
  ): Promise<{
    success: boolean;
    messages: any[];
    hasMore: boolean;
    error?: string;
  }> {
    const { chatId, afterId, limit = 50 } = data;
    const { authToken } = context;

    try {
      const messages = await this.chatService.getMessagesAfterId(chatId, afterId, limit, authToken);

      return {
        success: true,
        messages,
        hasMore: messages.length === limit,
      };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error loading messages for ${chatId}:`, error);
      return {
        success: false,
        error: error.message,
        messages: [],
        hasMore: false,
      };
    }
  }

  /**
   * Outdated-client guard.
   *
   * True when the connection is a bare native React Native build (no `Origin`
   * header) that sent NO `appVersion` in its Socket.IO handshake — i.e. a
   * pre-handshake build, too old for any client-side version gate to reach.
   * Any up-to-date native build (sends an `appVersion`) is NEVER flagged.
   *
   * Per the issue owner's decision this is ABSENCE-only (we do not compare the
   * reported version against the latest) — a recovery net for the very old
   * builds that predate the handshake.
   */
  isOutdatedNativeClient(context: ExecutionContext): boolean {
    // Absence-only: any client that does not report an `appVersion` in its
    // handshake is outdated. The old `isNativeRn`/Origin gate was DROPPED — the
    // real iOS RN socket sends the sandbox URL as its `Origin`, so it never
    // matched and the block never fired. Up-to-date native builds send
    // `appVersion` and are never flagged.
    return !context.appVersion;
  }

  /**
   * Should this chat:message be blocked as an outdated native build?
   *
   * Two conditions, AND-ed:
   *   1. {@link isOutdatedNativeClient} — a bare native RN client with no
   *      `appVersion` (cheap, synchronous; the common up-to-date case short-
   *      circuits here and never touches the network).
   *   2. The gateway-controlled kill switch is ON — `VERIFY_HANDSHAKE=true`,
   *      fetched + cached + fail-open by {@link HandshakeVerificationGate}.
   *
   * With no gate wired (tests / legacy callers) the kill switch is treated as OFF
   * → never block. This is the safe default: the block only ever fires when it is
   * BOTH an outdated client AND verification has been deliberately enabled.
   */
  async shouldBlockOutdatedClient(context: ExecutionContext): Promise<boolean> {
    const isOutdated = this.isOutdatedNativeClient(context);
    const gateWired = !!this.handshakeVerificationGate;
    // Only consult the (network) kill switch when the cheap synchronous check
    // already flagged the client — preserves the original short-circuit.
    const verifyHandshake =
      isOutdated && gateWired ? await this.handshakeVerificationGate!.isEnabled() : false;
    const block = isOutdated && gateWired && verifyHandshake;

    // TEMP diagnostics — logged on every chat:message so the sandbox log
    // shows exactly why a client was (or wasn't) blocked.
    console.log(
      `[#1493][block-decision] chat=${context.chatId} user=${context.userId} ` +
        `appVersion=${JSON.stringify(context.appVersion)} ` +
        `isOutdated=${isOutdated} gateWired=${gateWired} verifyHandshake=${verifyHandshake} ` +
        `=> block=${block}`
    );

    return block;
  }

  /**
   * Emit the ephemeral "update your app" notice to an outdated native client
   * INSTEAD of running Claude. Rendered via the same assistant-text
   * stream path every build (old ones included) already knows how to render.
   *
   * It is deliberately NOT persisted (no `bufferMessage`) and carries no numeric
   * message id, so it never enters chat history, is never fed to Claude as
   * context, and never advances the chat's read cursor.
   */
  emitOutdatedClientNotice(context: ExecutionContext): void {
    const { chatId, emitter } = context;
    emitter.emit('claude:stream', {
      chatId,
      block: { type: 'text', text: OUTDATED_APP_MESSAGE, blockId: `outdated-${randomUUID()}` },
    });
    emitter.emit('claude:status', { chatId, status: 'completed' });
  }

  /**
   * Handle chat:message event - Prepare message for execution
   * This method validates, fetches defaults, and buffers the message.
   * It does NOT execute the message - that's done separately to allow optimistic broadcast.
   */
  async handleChatMessage(
    context: ExecutionContext,
    data: {
      chatId: string;
      messageId?: string;
      content: string;
      files?: any[];
      pageContext?: PageContext;
      model?: string;
      permissions?: string;
      agentSetupId?: string;
      aiStyle?: string;
      customAiStylePrompt?: string;
    }
  ): Promise<{
    success: boolean;
    error?: string;
    /**
     * The chat id the rest of the pipeline must use. Normally === the incoming chatId,
     * but when a Claude-Code-originated chat is FORKED on first write this is the NEW
     * Portable chat id (the caller must retarget room join / echo / executeMessage to it).
     */
    chatId?: string;
    effectiveContent?: string;
    effectiveModel?: string;
    effectivePermissions?: string;
    effectiveAgentSetupId?: string;
  }> {
    const { content, pageContext, model, permissions, agentSetupId, files } = data;
    const { userId, authToken } = context;

    try {
      // Validate chatId
      if (!data.chatId || data.chatId === 'undefined' || data.chatId === 'null') {
        console.error(`[ChatExecutionService] Invalid chatId:`, data.chatId);
        return { success: false, error: 'Invalid chat ID' };
      }

      // FORK-ON-FIRST-WRITE: if this is a Claude Code terminal chat that Portable has never
      // written to (a discovered transcript, no real row), claim it into a BRAND-NEW Portable
      // chat and run the rest of the pipeline against that new id. The original CC transcript
      // is never resumed/mutated — the actual fork happens in the SDK (startNewSession →
      // forkFromSessionId). Returns the same id for every normal chat.
      const chatId = await this.forkDiscoveredChatIfNeeded(context, data.chatId, {
        model,
        permissions,
        agentSetupId,
      });

      // Fetch chat to get defaults
      const chat = await this.chatService.getChat(chatId, userId, authToken);

      // Resolve effective parameters (use provided values, fall back to chat defaults)
      const effectiveModel = model || chat?.model || DEFAULT_MODEL_MODE;
      const effectivePermissions = permissions || chat?.permissions || 'ask_each_time';
      const effectiveAgentSetupId = agentSetupId || chat?.agent_setup_id || 'freestyle';

      const effectiveContent = content;

      // Buffer user message (now awaited to prevent race conditions)
      await this.chatService.bufferMessage(
        userId,
        chatId,
        'user_message',
        {
          content: effectiveContent,
          uploadedFiles: files,
          context: pageContext,
          customDisplay: undefined,
        },
        authToken
      );

      console.log(
        `[ChatExecutionService] Message prepared for ${chatId}: model=${effectiveModel}, permissions=${effectivePermissions}`
      );

      return {
        success: true,
        chatId,
        effectiveContent,
        effectiveModel,
        effectivePermissions,
        effectiveAgentSetupId,
      };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error preparing message for ${data.chatId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * FORK-ON-FIRST-WRITE. If `chatId` is a Claude-Code-originated chat that Portable
   * has never written to — a *discovered* terminal transcript with no real SQLite row — claim
   * it into a brand-new Portable chat and return that new id; otherwise return `chatId`
   * unchanged.
   *
   * The claim creates a real row with `fork_source_session_id` set (and `session_id` null),
   * so the subsequent `startNewSession` runs the SDK with `{ resume: source, forkSession: true }`
   * — the source `.jsonl` is read-only, a new transcript/session id is minted, and the original
   * CC chat stays intact and still visible in Portable's list as its own card.
   *
   * Emits `chat:created` (so the new chat appears) + `chat:forked` (so the originating client
   * navigates to it) to all of the user's sockets, and joins them to the new room.
   */
  private async forkDiscoveredChatIfNeeded(
    context: ExecutionContext,
    chatId: string,
    opts: { model?: string; permissions?: string; agentSetupId?: string }
  ): Promise<string> {
    const { userId, authToken, emitter } = context;

    const origin = await this.chatService.getChatOrigin(chatId, userId, authToken);
    if (origin.origin !== 'discovered') {
      return chatId; // normal Portable chat (or unknown) — resume/create as before
    }

    const newChatId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Claim a real Portable row. repo_path = the transcript's REAL cwd so the forked SDK run
    // executes in the same dir the source ran in; repo_full_name drives the card label.
    // session_id stays null (set by the SDK init); fork_source_session_id triggers the fork.
    await this.chatService.saveChat({
      userId,
      chatId: newChatId,
      type: 'claude_code',
      title: origin.title,
      status: 'completed',
      repoPath: origin.cwd,
      repoFullName: origin.repoFullName,
      forkSourceSessionId: origin.sourceSessionId,
      model: opts.model || DEFAULT_MODEL_MODE,
      permissions: opts.permissions || 'default',
      agentSetupId: opts.agentSetupId || 'freestyle',
      parentChatId: undefined,
      authToken,
    });

    console.log(
      `[ChatExecutionService] Fork-on-first-write: claimed CC chat ${chatId} (session ${origin.sourceSessionId}) → new Portable chat ${newChatId}`
    );

    // Surface the new chat on every device + navigate the originating client into it.
    if (emitter.emitToUser && emitter.joinUserToRoom) {
      const newChat = await this.chatService.getChat(newChatId, userId, authToken);
      emitter.emitToUser(userId, 'chat:created', { chat: newChat });
      emitter.joinUserToRoom(userId, newChatId);
      emitter.emitToUser(userId, 'chat:forked', { oldChatId: chatId, newChatId });
    }

    if (this.reposCacheService && userId) {
      this.reposCacheService.invalidateUser(userId);
    }

    return newChatId;
  }

  /**
   * Handle chat:create event
   * Validates data, constructs repo path, checks filesystem, and creates chat record
   */
  async handleChatCreate(
    context: ExecutionContext,
    data: {
      chatId: string;
      type: 'claude_code';
      title: string;
      owner: string;
      repo: string;
      model: string;
      permissions: string;
      agentSetupId: string;
    }
  ): Promise<{
    success: boolean;
    error?: string;
    chat?: {
      id: string;
      type: string;
      title: string;
      messages: any[];
      status: string;
      repo_path: string;
      model: string;
      permissions: string;
      agentSetupId: string;
      lastUpdated: number;
      hidden: boolean;
      archived: boolean;
    };
  }> {
    const { chatId, type, title, owner, repo, model, permissions, agentSetupId } = data;
    const { userId, authToken } = context;

    try {
      // Workspace (scratch / one-off) chat: the home widget sent the reserved
      // `__workspace__` owner because the message isn't about a specific repo. There is
      // NOTHING to clone or validate against GitHub — the chat runs in `<workspace>/tmp`
      // (resolved at execution time) and is persisted with a NULL repo_path so the mobile
      // list groups it under the synthetic "Workspace" project. Scaffold the workspace +
      // tmp CLAUDE.md so the cwd is a proper Claude project.
      if (isWorkspaceChatTarget(owner)) {
        await ensureWorkspaceScaffold(getUserWorkspaceDir(userId));

        await this.chatService.saveChat({
          userId,
          chatId,
          type,
          title,
          status: 'completed',
          repoPath: undefined, // no repo → "Workspace" group, runs in <workspace>/tmp
          agentSetupId,
          model,
          permissions,
          parentChatId: undefined,
          authToken,
        });

        console.log(
          `[ChatExecutionService] ${userId} created workspace (scratch) chat ${chatId} — runs in <workspace>/tmp, no repo`
        );

        if (this.reposCacheService && userId) {
          this.reposCacheService.invalidateUser(userId);
        }

        return {
          success: true,
          chat: {
            id: chatId,
            type,
            title,
            messages: [],
            status: 'completed',
            repo_path: '', // no repo
            model,
            permissions,
            agentSetupId,
            lastUpdated: Date.now(),
            hidden: false,
            archived: false,
          },
        };
      }

      // Import validation utilities
      const { validateChatCreationData } = await import('./utils/validationHelpers.js');

      // Validate all required fields
      const validation = validateChatCreationData({
        chatId,
        title,
        owner,
        repo,
        model,
        permissions,
        agentSetupId,
      });

      if (!validation.valid) {
        console.error(
          `[ChatExecutionService] ❌ Chat creation validation failed for ${userId}:`,
          validation.error
        );
        return { success: false, error: validation.error };
      }

      // resolve the REAL on-disk path so portable USES the user's
      // pre-existing checkout (a FLAT clone at `<workspace>/<dir>`) instead of cloning
      // a duplicate two-level copy of it. Falls back to the canonical
      // `<workspace>/<owner>/<repo>` path when the repo isn't present yet (auto-cloned
      // just below).
      const repo_path = await this.gitLocalService.resolveLocalRepoPath(userId, owner, repo);

      // Ensure repo directory exists — auto-clone if missing so chat creation
      // never fails due to a "not cloned yet" race (e.g. user taps chat before
      // the repo page has triggered its own clone).
      try {
        const repoStat = await fs.stat(repo_path);
        if (!repoStat.isDirectory()) {
          console.error(
            `[ChatExecutionService] ❌ Chat creation failed for ${userId}: Path exists but is not a directory: ${repo_path}`
          );
          return {
            success: false,
            error: 'Repository path is not a directory.',
          };
        }
      } catch {
        console.log(
          `[ChatExecutionService] Repo not found at ${repo_path} — auto-cloning ${owner}/${repo} for ${userId}`
        );
        try {
          await this.gitLocalService.cloneRepositoryForUser(owner, repo, userId, authToken);
          console.log(
            `[ChatExecutionService] ✓ Auto-cloned ${owner}/${repo} for ${userId} at ${repo_path}`
          );
        } catch (cloneError: any) {
          console.error(
            `[ChatExecutionService] ❌ Auto-clone failed for ${userId} on ${owner}/${repo}:`,
            cloneError
          );
          if (cloneError?.code === 'INSUFFICIENT_GITHUB_PERMISSIONS') {
            return {
              success: false,
              error: 'GitHub connection required. Please connect your GitHub account to continue.',
            };
          }
          return {
            success: false,
            error: `Failed to clone repository "${owner}/${repo}": ${cloneError?.message || 'unknown error'}`,
          };
        }
      }

      console.log(
        `[ChatExecutionService] ${userId} creating chat ${chatId} for ${owner}/${repo} at ${repo_path}, agentSetupId: ${agentSetupId || 'not set'}`
      );

      // Save chat to database with actual path
      await this.chatService.saveChat({
        userId,
        chatId,
        type,
        title,
        status: 'completed', // Initial status (not yet running)
        repoPath: repo_path,
        agentSetupId,
        model,
        permissions,
        parentChatId: undefined, // not used for GitHub repos
        authToken,
      });

      console.log(
        `[ChatExecutionService] ✓ Chat ${chatId} created: "${title.substring(0, 50)}${title.length > 50 ? '...' : ''}"`
      );

      // Invalidate repos cache after successful chat creation
      // This ensures the client gets fresh isLocal status on next API call
      if (this.reposCacheService && userId) {
        const invalidated = this.reposCacheService.invalidateUser(userId);
        console.log(
          `[ChatExecutionService] Cache invalidation after chat creation: ${invalidated ? 'success' : 'no cache entry found'}`
        );
      }

      // Return chat object for broadcasting
      return {
        success: true,
        chat: {
          id: chatId,
          type,
          title,
          messages: [],
          status: 'completed',
          repo_path,
          model,
          permissions,
          agentSetupId,
          lastUpdated: Date.now(),
          hidden: false,
          archived: false,
        },
      };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error creating chat ${chatId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle chat:update_settings event
   */
  async handleUpdateSettings(
    context: ExecutionContext,
    data: { chatId: string; settings: { model?: string; permissions?: string } }
  ): Promise<{ success: boolean; error?: string }> {
    const { chatId, settings } = data;
    const { userId, authToken, emitter } = context;

    try {
      // Update settings in database
      await this.chatService.updateChatSettings(chatId, userId, settings, authToken);

      console.log(`[ChatExecutionService] ${userId} updated chat ${chatId} settings:`, settings);

      // Broadcast to all sockets in the room
      emitter.emit('chat:settings_updated', { chatId, settings });

      // If permissions changed and there's an active session, interrupt it
      if (settings.permissions && this.claudeService) {
        const session = this.claudeService.getSession(chatId);
        if (session && session.query) {
          console.log(
            `[ChatExecutionService] Permissions changed for active session ${chatId}, interrupting...`
          );
          await this.claudeService.stopSession(chatId, userId);
          emitter.emit('claude:interrupted', {
            chatId,
            reason: 'permissions_changed',
          });
        }
      }

      return { success: true };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error updating chat ${chatId} settings:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Interrupt every currently running Claude session. Used by the memory watchdog
   * as a last-resort measure to free memory before the kernel SIGKILLs the sandbox.
   * Returns the chatIds that were successfully stopped.
   */
  async interruptAllActive(reason: string): Promise<string[]> {
    const chatIds = this.claudeService.getRunningChatIds?.() ?? [];
    if (chatIds.length === 0) return [];

    console.log(
      `[ChatExecutionService] interruptAllActive(${reason}) — stopping ${chatIds.length} session(s)`
    );

    const stopped: string[] = [];
    for (const chatId of chatIds) {
      try {
        const ok = await this.claudeService.stopSession(chatId, 'memory-watchdog');
        if (ok) stopped.push(chatId);
      } catch (err) {
        console.error(`[ChatExecutionService] interruptAllActive error for ${chatId}:`, err);
      }
    }
    return stopped;
  }

  /**
   * Handle claude:interrupt event
   */
  async handleClaudeInterrupt(
    context: ExecutionContext,
    data: { chatId: string }
  ): Promise<{ success: boolean; error?: string }> {
    const { chatId } = data;
    const { userId, emitter } = context;

    try {
      console.log(`[ChatExecutionService] Claude interrupt requested for ${chatId} by ${userId}`);

      const stopped = await this.claudeService.stopSession(chatId, userId);

      if (stopped) {
        console.log(`[ChatExecutionService] Successfully stopped session ${chatId}`);
        emitter.emit('claude:interrupted', { chatId });
        return { success: true };
      } else {
        console.log(`[ChatExecutionService] Session ${chatId} not found or already stopped`);
        return { success: false, error: 'Session not found' };
      }
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error interrupting Claude session ${chatId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle chat:kill-session event.
   *
   * User-initiated termination from the runtime panel. Validates the chat
   * belongs to the requesting user, gracefully aborts the live session
   * (`stopSession` frees the subprocess while PRESERVING `session_id`, so the
   * next message resumes transparently), then rebroadcasts the runtime state so
   * every device's panel drops the killed session.
   */
  async handleKillSession(
    context: ExecutionContext,
    data: { chatId: string }
  ): Promise<{ success: boolean; error?: string }> {
    const { chatId } = data;
    const { userId, emitter } = context;

    try {
      const session = this.claudeService.getSession(chatId);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Ownership: a user may only kill their own chat's session.
      if (session.userId && session.userId !== userId) {
        console.warn(
          `[ChatExecutionService] ${userId} attempted to kill session ${chatId} owned by ${session.userId}`
        );
        return { success: false, error: 'Not authorized' };
      }

      console.log(`[ChatExecutionService] Kill-session requested for ${chatId} by ${userId}`);

      const stopped = await this.claudeService.stopSession(chatId, userId);

      // Refresh the runtime panel on every device (the session is now gone).
      if (emitter.broadcastRuntimeStateToUser) {
        emitter.broadcastRuntimeStateToUser(userId);
      }

      if (stopped) {
        // Stop the chat UI's typing indicator if the chat is open.
        emitter.emit('claude:interrupted', { chatId });
        return { success: true };
      }
      return { success: false, error: 'Session not running' };
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error killing session ${chatId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle permission:respond event
   */
  async handlePermissionResponse(
    context: ExecutionContext,
    data: { requestId: string; chatId: string; approved: boolean }
  ): Promise<{ success: boolean; message?: string; code?: string; error?: string }> {
    const { requestId, approved } = data;
    const { userId } = context;

    try {
      console.log(
        `[ChatExecutionService] Permission response from ${userId}: ${
          approved ? 'APPROVED' : 'DENIED'
        }`
      );

      const result = this.claudeService.resolvePermissionRequest(requestId, approved);
      return result;
    } catch (error: any) {
      console.error(
        `[ChatExecutionService] Error responding to permission request ${requestId}:`,
        error
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle answer_user_question event
   */
  async handleAnswerUserQuestion(
    context: ExecutionContext,
    data: {
      request_id: string;
      chat_id: string;
      answers: Record<string, string[]>;
    }
  ): Promise<{ success: boolean; error?: string }> {
    const { request_id, answers } = data;
    const { userId } = context;

    try {
      console.log(`[ChatExecutionService] User ${userId} answering question ${request_id}`);

      // Submit answers to MCP server
      const { submitAnswersToMcp } = await import('../mcp/AskUserMcpServer.js');
      const success = submitAnswersToMcp(request_id, answers);

      if (success) {
        console.log(`[ChatExecutionService] Answers submitted to MCP server successfully`);
        return { success: true };
      } else {
        console.warn(`[ChatExecutionService] Failed to submit answers - request not found`);
        return {
          success: false,
          error: 'Request not found or already answered',
        };
      }
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error submitting answers:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a chat message with Claude.
   * Works with any emitter - socket, no-op, or custom.
   */
  async executeMessage(
    context: ExecutionContext,
    message: { content: string; uploadedFiles?: any[]; context?: PageContext },
    options: ExecuteMessageOptions = {}
  ): Promise<void> {
    // chatId may be RETARGETED by the fork guard below, so it is mutable; the rest of
    // the identity (user/auth/emitter) is stable across a fork.
    const { userId, username, authToken, emitter } = context;
    let chatId = context.chatId;

    try {
      // ===== FORK-ON-FIRST-WRITE GUARD (durability — single execution chokepoint) =====
      // The ONE place every caller funnels through (socket chat:message, AND the
      // non-interactive portable_execute cross-chat send that bypasses handleChatMessage).
      // A chat that originated in Claude Code (a discovered transcript with no Portable
      // row) must NEVER be resumed in place — that would mutate its shared `.jsonl`. Fork
      // it into a new Portable chat first. IDEMPOTENT: a no-op the moment the chat has a
      // real SQLite row, so the socket path (already forked in handleChatMessage, which
      // passes the new id here) is never double-forked.
      const forkedChatId = await this.forkDiscoveredChatIfNeeded(context, chatId, {
        model: options.model,
        permissions: options.permissions,
        agentSetupId: options.agentSetupId,
      });
      if (forkedChatId !== chatId) {
        chatId = forkedChatId;
        context = { ...context, chatId };
      }

      // ===== DEDUPLICATION CHECK =====
      // Check for duplicate message (prevents double-submission)
      if (this.messageDeduplicationService.isDuplicate(userId, chatId, message.content)) {
        console.log(
          `[ChatExecutionService] Duplicate message detected for chat ${chatId}, ignoring`
        );
        return; // Silently ignore duplicate
      }

      // Track message hash (prevents duplicate submission within short time window)
      this.messageDeduplicationService.addHash(userId, chatId, message.content);

      // ===== EXECUTION =====
      // Try to restore session from database if not in memory
      const restored = await this.claudeService.restoreSessionFromDatabase(
        chatId,
        userId,
        authToken
      );
      if (restored) {
        console.log(`[ChatExecutionService] Session ${chatId} restored from database`);
      }

      // Check if we can resume an existing session
      const canResume = this.claudeService.canResumeSession(chatId);
      const isRunning = this.claudeService.isSessionRunning(chatId);

      console.log(`[ChatExecutionService] Session status for ${chatId}:`, {
        restored,
        canResume,
        isRunning,
      });

      // Get existing session if it exists
      let existingSession = this.claudeService.getSession(chatId);

      // Check if session parameters changed (permissions or model)
      if (isRunning && existingSession) {
        const permissionsChanged = existingSession.permissions !== options.permissions;
        const modelChanged = existingSession.model !== options.model;

        if (permissionsChanged || modelChanged) {
          console.log(
            `[ChatExecutionService] Session parameters changed for ${chatId}, recreating session`
          );

          // Stop existing session
          await this.claudeService.stopSession(chatId, userId);

          // Clear session reference
          existingSession = undefined;
        } else {
          // Parameters unchanged - use normal message injection path (quick, no lock needed)
          console.log(
            `[ChatExecutionService] Session ${chatId} is already running, adding message to queue`
          );

          const added = this.claudeService.addMessageToSession(chatId, message.content, userId);

          if (added) {
            console.log(
              `[ChatExecutionService] Message queued successfully, Claude will process it`
            );

            // Emit status update
            emitter.emit('claude:status', { chatId, status: 'running' });

            // Refresh the runtime panel: this live session just went idle →
            // running. The output adapter / runtime_state_update path
            // doesn't exist on this branch (we return before creating it), so
            // broadcast directly.
            if (emitter.broadcastRuntimeStateToUser) {
              emitter.broadcastRuntimeStateToUser(userId);
            }

            // Persist running status
            await this.chatService.bufferMessage(
              userId,
              chatId,
              'chat_status_update',
              { status: 'running' },
              authToken
            );
          } else {
            console.error(
              `[ChatExecutionService] Failed to queue message - session not found or not running`
            );
          }
          return;
        }
      }

      // ===== SESSION START/RESUME LOCK =====
      // Prevent concurrent session creation for the same chat
      // (message injection above is allowed through without lock)
      if (this.executingChats.has(chatId)) {
        console.warn(
          `[ChatExecutionService] Chat ${chatId} is already starting/resuming a session, ignoring concurrent request`
        );
        return;
      }
      this.executingChats.add(chatId);

      try {
        // Check if we can resume the session
        if (canResume && existingSession) {
          console.log(`[ChatExecutionService] Resuming session: ${chatId}`);
          await this.resumeSession(context, existingSession, message, options);
        } else {
          console.log(`[ChatExecutionService] Starting new session: ${chatId}`);
          await this.startNewSession(context, message, options);
        }
      } finally {
        this.executingChats.delete(chatId);
      }
    } catch (error: any) {
      console.error(`[ChatExecutionService] Error processing message for ${chatId}:`, error);

      emitter.emit('claude:error', {
        chatId,
        error: error.message || 'Failed to process message',
      });

      // Re-throw error so callers can handle it (important for testing)
      throw error;
    }
  }

  /**
   * Ensure the repo at `repoPath` is available for the chat. If the directory is
   * MISSING ENTIRELY, clone it from GitHub using the user's stored credentials
   * (recovers a never-cloned repo so starting a chat doesn't fail).
   *
   * If a directory already EXISTS at `repoPath` we NEVER delete it — not even
   * when it isn't a git checkout. An existing directory may be a real working
   * copy the user pointed us at (e.g. an external repo surfaced into the
   * workspace), and auto-deleting it would destroy their uncommitted work. A
   * valid `.git` checkout is used directly; a non-git directory is left
   * untouched and used as-is (no clone, no delete). The previous
   * delete-and-re-clone recovery (for wiped remote sandbox volumes) was removed —
   * the local-first workspace lives on the user's own persistent disk, so the
   * safety risk of deleting real work outweighs auto-recovering a partial clone.
   */
  private async ensureRepoCloned(
    repoPath: string,
    userId: string,
    authToken: string | undefined,
    chatId: string
  ): Promise<void> {
    const gitDir = path.join(repoPath, '.git');

    let hasDir = false;
    try {
      await fs.access(repoPath);
      hasDir = true;
    } catch {
      // missing entirely
    }

    if (hasDir) {
      try {
        await fs.access(gitDir);
        return; // valid git checkout — use it directly
      } catch {
        // Directory exists but is not a git checkout. NEVER delete it — it may be
        // the user's own working copy (an external repo surfaced into the
        // workspace). Leave it untouched and use it as-is (no clone, no delete).
        console.warn(
          `[ChatExecutionService] [${userId}] ${repoPath} exists but is not a git checkout — using it as-is (no clone, no delete) for chat ${chatId}`
        );
        return;
      }
    }

    const { getRepoFromPath } = await import('@vgit2/shared/utils/pathHelpers');
    const repoFullName = getRepoFromPath(repoPath, getUserWorkspaceDir(userId));
    if (!repoFullName) {
      throw new Error(
        `[ChatExecutionService] Cannot auto-clone for chat ${chatId}: could not extract owner/repo from path ${repoPath}`
      );
    }
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(
        `[ChatExecutionService] Cannot auto-clone for chat ${chatId}: invalid owner/repo parsed from ${repoPath}`
      );
    }

    console.log(
      `[ChatExecutionService] [${userId}] Auto-cloning ${owner}/${repo} for chat ${chatId} (workspace missing at ${repoPath})`
    );
    try {
      await this.gitLocalService.cloneRepositoryForUser(owner, repo, userId, authToken);
    } catch (cloneError: any) {
      if (cloneError?.code === 'INSUFFICIENT_GITHUB_PERMISSIONS') {
        throw new Error(
          'GitHub connection required. Please connect your GitHub account to continue.'
        );
      }
      throw new Error(
        `[ChatExecutionService] Auto-clone failed for ${owner}/${repo} (chat ${chatId}): ${cloneError?.message || 'unknown error'}`
      );
    }

    try {
      await fs.access(gitDir);
    } catch {
      throw new Error(
        `[ChatExecutionService] Auto-clone of ${owner}/${repo} completed but ${gitDir} is still missing`
      );
    }
    console.log(
      `[ChatExecutionService] [${userId}] ✓ Auto-clone succeeded for chat ${chatId} at ${repoPath}`
    );
  }

  /**
   * Resume an existing Claude session
   */
  private async resumeSession(
    context: ExecutionContext,
    existingSession: any,
    message: { content: string; uploadedFiles?: any[]; context?: PageContext },
    options: ExecuteMessageOptions
  ): Promise<void> {
    const { chatId, userId, username, authToken, emitter } = context;

    // Get chat from database to read current permissions and agent setup
    const chat = await this.chatService.getChat(chatId, userId, authToken);
    const chatPermissions = chat?.permissions || options.permissions;
    const chatAgentSetupId = chat?.agent_setup_id || undefined;

    if (!chatPermissions) {
      throw new Error(`[ChatExecutionService] Permissions not set for chat ${chatId}`);
    }

    console.log(`[ChatExecutionService] Using permissions for session:`, {
      fromOptions: options.permissions,
      fromChat: chat?.permissions,
      using: chatPermissions,
    });

    // Ensure repo directory exists — auto-clone if the workspace volume was
    // wiped (e.g. sandbox restart). Without this, resuming an existing chat
    // whose repo was deleted would hard-fail and force the user to start over.
    const repoPath = existingSession.repo_path;
    await this.ensureRepoCloned(repoPath, userId, authToken, chatId);

    // Create output adapter
    const outputAdapter = this.createOutputAdapter(context);

    // Call startClaudeCodeSession - it will handle inject/resume internally
    await this.claudeService.startClaudeCodeSession({
      ws: outputAdapter,
      chatId,
      repoPath: existingSession.repo_path,
      task: message.content,
      uploadedFiles: message.uploadedFiles,
      systemPrompt: existingSession.systemPrompt,
      userId,
      username,
      playwrightDevice: message.context?.playwrightDevice || 'mobile',
      model: options.model,
      permissions: chatPermissions,
      authToken,
      agentSetupId: chatAgentSetupId,
      emitter: context.emitter, // Pass emitter for portable_execute SDK
    });
  }

  /**
   * Start a new Claude session
   */
  private async startNewSession(
    context: ExecutionContext,
    message: { content: string; uploadedFiles?: any[]; context?: PageContext },
    options: ExecuteMessageOptions
  ): Promise<void> {
    const { chatId, userId, username, authToken, emitter } = context;

    // Get chat from database to read repo_path
    const chat = await this.chatService.getChat(chatId, userId, authToken);

    if (!chat) {
      throw new Error(`Chat ${chatId} not found in database`);
    }

    // FORK-ON-FIRST-WRITE: a chat claimed from a Claude Code transcript carries
    // fork_source_session_id with session_id still null. Fork from that source so the SDK
    // mints a NEW session/transcript and the original CC `.jsonl` is never mutated. Once the
    // SDK init persists the new session_id, later turns resume normally (this stays undefined).
    const forkFromSessionId =
      chat.session_id == null && chat.fork_source_session_id
        ? chat.fork_source_session_id
        : undefined;

    // NEW: Create SOP worksheet if agent requires it
    let sopWorksheetPath: string | undefined;
    let sopWorksheetContent: string | undefined;

    const agentSetup = getAgentSetup(options.agentSetupId || 'freestyle');
    if (agentSetup.requiresSOP) {
      if (!this.sopService) {
        throw new Error(
          `[ChatExecutionService] CRITICAL: SOPService not initialized but agent '${agentSetup.id}' requires SOP worksheet`
        );
      }

      try {
        const sopResult = await this.sopService.loadSOP(chat.repo_path || undefined);

        sopWorksheetPath = await this.sopService.createWorksheet(sopResult.content, chatId);

        sopWorksheetContent = sopResult.content;

        console.log(
          `[ChatExecutionService] SOP worksheet created: ${sopWorksheetPath} (source: ${sopResult.source})`
        );
      } catch (error) {
        console.error('[ChatExecutionService] CRITICAL: Failed to create SOP worksheet:', error);
        throw new Error(
          `[ChatExecutionService] Agent '${agentSetup.id}' requires SOP worksheet but creation failed: ${error}`
        );
      }
    }

    let repoPath: string;
    let systemPrompt: string;

    // Check if this is an exploration/non-code project
    const isCodeProject = options.isCodeProject ?? message.context?.isCodeProject !== false;

    let repoOwner: string | undefined;
    let repoName: string | undefined;

    // Use repo_path from database if available
    if (chat.repo_path) {
      const { getRepoFromPath } = await import('@vgit2/shared/utils/pathHelpers');
      const repoFullName = getRepoFromPath(chat.repo_path, getUserWorkspaceDir(userId));

      if (repoFullName) {
        // Two-level (portable-cloned) / legacy path: reconstruct under the CURRENT
        // workspace root (implicit migration of an orphaned absolute path). Behaviour
        // is unchanged from the prior two-level layout.
        [repoOwner, repoName] = repoFullName.split('/');
        const userWorkspace = getUserWorkspaceDir(userId);
        repoPath = path.join(userWorkspace, repoOwner, repoName);
      } else {
        // a FLAT clone (no owner in the path, e.g. `<workspace>/<repo>`) —
        // the persisted absolute path IS authoritative; use it directly. Resolve the
        // repo identity (for the system prompt) from discovery, else the dir name.
        repoPath = chat.repo_path;
        try {
          const discovered = await this.gitLocalService.getLocalRepositories(userId);
          const match = discovered.find(
            (r: { full_name: string; localPath: string }) =>
              path.resolve(r.localPath) === path.resolve(chat.repo_path!)
          );
          if (match?.full_name?.includes('/')) {
            [repoOwner, repoName] = match.full_name.split('/');
          }
        } catch {
          // discovery failed — fall back to the dir name below
        }
        if (!repoName) {
          repoName = path.basename(chat.repo_path);
        }
      }

      console.log(
        `[ChatExecutionService] [${userId}] New session: ${chatId} (${repoOwner}/${repoName}) ${isCodeProject ? '(code project)' : '(exploration)'}`
      );

      // Only check for git repository if this is a code project
      if (isCodeProject) {
        await this.ensureRepoCloned(repoPath, userId, authToken, chatId);
      }

      // Get list of locally cloned repositories (filesystem scan only, no API call)
      const localRepos = await this.gitLocalService.getLocalRepositories(userId);
      const localReposList = this.formatLocalReposList(localRepos);

      // Collect runtime state
      const runtimeState = await this.collectRuntimeState(userId, repoPath);

      // Build system prompt
      systemPrompt = this.buildSystemPrompt({
        agentSetupId: options.agentSetupId,
        repoOwner,
        repoName,
        repoPath,
        localReposList,
        pageContext: options.pageContext || message.context,
        runtimeState,
        permissions: options.permissions,
        aiStyle: options.aiStyle,
        customAiStylePrompt: options.customAiStylePrompt,
        isCodeProject,
        username,
        userEmail: userId,
        userId,
        sopWorksheetPath,
        sopWorksheetContent,
      });
    } else {
      // Home-widget / no-repo chat: a generic one-off task. It is evaluated in the
      // workspace SCRATCH folder (`<workspace>/tmp`), which is its own Claude project
      // (see `ensureWorkspaceScaffold` → `tmp/CLAUDE.md`). It carries no Portable project
      // and is grouped under the synthetic "Workspace" project in the app.
      repoPath = getWorkspaceTmpDir(userId);
      await ensureWorkspaceScaffold(getUserWorkspaceDir(userId));
      console.log(
        `[ChatExecutionService] [${userId}] New session: ${chatId} (workspace scratch — tmp)`
      );

      const localRepos = await this.gitLocalService.getLocalRepositories(userId);
      const localReposList = this.formatLocalReposList(localRepos);

      systemPrompt = this.buildSystemPrompt({
        agentSetupId: options.agentSetupId,
        repoPath,
        localReposList,
        pageContext: options.pageContext || message.context,
        permissions: options.permissions,
        aiStyle: options.aiStyle,
        customAiStylePrompt: options.customAiStylePrompt,
        isCodeProject: false,
        username,
        userEmail: userId,
        userId,
        sopWorksheetPath,
        sopWorksheetContent,
      });
    }

    if (!systemPrompt) {
      throw new Error('Failed to generate system prompt');
    }

    // Ensure directory exists
    await fs.mkdir(repoPath, { recursive: true });

    // Initialize git for explorations AND every repo-less general-workspace chat
    // (empty repo_path → the orchestrator scratch dir): the per-chat `git init`
    // satisfies ExecutionHandler's `<cwd>/.git` requirement (idempotent — a re-run on
    // an existing scratch dir is a no-op `git init`).
    if (!isCodeProject || !chat.repo_path) {
      await this.initializeGitForExploration(repoPath, username, userId);
    }

    console.log(`[ChatExecutionService] [${userId}] Final repoPath: ${repoPath}`);
    console.log(
      `[ChatExecutionService] [${userId}] Task: ${message.content.substring(0, 100)}${message.content.length > 100 ? '...' : ''}`
    );

    // Emit status update - session is starting
    emitter.emit('claude:status', {
      chatId,
      status: 'running',
      repoPath,
      task: message.content,
    });

    // Buffer the start event
    await this.chatService.bufferMessage(
      userId,
      chatId,
      'claude_code_start',
      {
        tool_use_id: chatId,
        repo_path: repoPath,
        task: message.content,
        model: options.model,
        permissions: options.permissions,
      },
      authToken
    );

    try {
      // Create output adapter and start session
      const outputAdapter = this.createOutputAdapter(context);

      await this.claudeService.startClaudeCodeSession({
        ws: outputAdapter,
        chatId,
        repoPath,
        task: message.content,
        uploadedFiles: options.uploadedFiles || message.uploadedFiles,
        systemPrompt,
        userId,
        username,
        owner: repoOwner,
        repo: repoName,
        playwrightDevice: message.context?.playwrightDevice || 'mobile',
        model: options.model,
        permissions: options.permissions,
        authToken,
        agentSetupId: options.agentSetupId,
        forkFromSessionId, // Fork-on-first-write (undefined for normal new chats)
        emitter, // Pass emitter for portable_execute SDK
      });
    } catch (error: any) {
      console.error('[ChatExecutionService] Claude Code error:', error);
      emitter.emit('claude:error', {
        chatId,
        error: error.message || 'Failed to run Claude Code',
      });
    }
  }

  /**
   * Create output adapter that translates Claude output to emitter calls.
   * This replaces the "mock WebSocket" pattern from SocketIOService.
   *
   * The adapter:
   * 1. Receives ws.send() calls from ClaudeService
   * 2. Accumulates blocks for persistence (ALWAYS)
   * 3. Emits to clients via the emitter (MAY BE NO-OP)
   */
  private createOutputAdapter(context: ExecutionContext): any {
    const { chatId, userId, authToken, emitter } = context;
    const self = this;

    return {
      // Always return OPEN state
      get readyState() {
        return 1; // WebSocket.OPEN
      },

      send: async (message: string) => {
        try {
          const data = JSON.parse(message);

          // Handle each message type
          if (data.type === 'navigate') {
            emitter.emit('navigate', data);
          } else if (data.type === 'chat:linkIssue') {
            console.log(
              `[ChatExecutionService] Linking issue to chat ${chatId}:`,
              data.linkedIssue
            );
            await self.chatService.updateLinkedIssue(chatId, userId, data.linkedIssue, authToken);
            emitter.emit('chat:linkedIssueUpdated', {
              chatId,
              linkedIssue: data.linkedIssue,
            });
          } else if (data.type === 'claude_code_stream') {
            // Accumulate blocks (ALWAYS - for persistence)
            if (data.blocks && Array.isArray(data.blocks)) {
              if (!self.assistantMessageAccumulator.has(chatId)) {
                self.assistantMessageAccumulator.set(chatId, {
                  blocks: [],
                  userId,
                });
              }

              for (const block of data.blocks) {
                self.assistantMessageAccumulator.get(chatId)!.blocks.push(block);

                // Emit to clients (may be no-op)
                emitter.emit('claude:stream', { chatId, block });
              }
            }
          } else if (data.type === 'claude_code_start') {
            emitter.emit('claude:status', { chatId, status: 'running' });
            await self.chatService.bufferMessage(
              userId,
              chatId,
              'chat_status_update',
              { status: 'running' },
              authToken
            );
          } else if (data.type === 'claude_code_completed') {
            emitter.emit('claude:status', { chatId, status: 'completed' });
            const previewBody = self.extractNotificationPreview(chatId);
            await self.saveAccumulatedMessage(chatId, userId, authToken);
            await self.sendPushNotificationIfOffline(
              userId,
              chatId,
              authToken,
              emitter,
              previewBody
            );
          } else if (data.type === 'chat_status_update') {
            if (data.status === 'completed') {
              emitter.emit('claude:status', { chatId, status: 'completed' });
              const previewBody = self.extractNotificationPreview(chatId);
              await self.saveAccumulatedMessage(chatId, userId, authToken);
              await self.sendPushNotificationIfOffline(
                userId,
                chatId,
                authToken,
                emitter,
                previewBody
              );
            } else if (data.status === 'idle') {
              emitter.emit('claude:status', { chatId, status: 'idle' });
              const previewBody = self.extractNotificationPreview(chatId);
              await self.saveAccumulatedMessage(chatId, userId, authToken);
              await self.sendPushNotificationIfOffline(
                userId,
                chatId,
                authToken,
                emitter,
                previewBody
              );
            } else if (data.status === 'error') {
              emitter.emit('claude:error', { chatId, error: 'Session error' });
            } else if (data.status === 'running') {
              emitter.emit('claude:status', { chatId, status: 'running' });
            } else if (data.status === 'compressing') {
              emitter.emit('claude:status', {
                chatId,
                status: 'compressing',
                timestamp: Date.now(),
              });
            }
          } else if (data.type === 'tunnel_created' || data.type === 'runtime_state_update') {
            // Broadcast runtime state to user
            if (emitter.broadcastRuntimeStateToUser) {
              emitter.broadcastRuntimeStateToUser(userId);
            }
            console.log(`[ChatExecutionService] Runtime state broadcast to ${userId}`);
          } else if (data.type === 'claude_code_interrupted') {
            emitter.emit('claude:interrupted', { chatId });
          } else if (data.type === 'claude_code_error') {
            emitter.emit('claude:error', { chatId, error: data.error });
          } else if (data.type === 'request_permission') {
            // Permissions are embedded in tool_use blocks
            console.log(`[ChatExecutionService] Permission request for tool: ${data.tool_name}`);
          } else if (data.type === 'request_user_secrets') {
            emitter.emit('secrets:request', {
              chatId,
              secretKeys: data.secret_keys,
              filePath: data.file_path,
            });
          } else if (data.type === 'secrets_submitted') {
            emitter.emit('secrets:submitted', { chatId });
          } else if (data.type === 'container_status') {
            emitter.emit('container:status', {
              chatId,
              status: data.status,
              message: data.message,
            });
          } else if (data.type === 'user_message_echo') {
            emitter.emit('message:echo', { chatId, content: data.content });
          } else if (data.type === 'chat_created') {
            // For chat_created, we need to emit to all user sockets
            // This is socket-specific behavior, so use emitToUser if available
            if (emitter.emitToUser && emitter.joinUserToRoom) {
              emitter.emitToUser(userId, 'chat:created', { chat: data.chat });
              emitter.joinUserToRoom(userId, data.chat.id);
            }
          } else {
            // Generic fallback
            emitter.emit(data.type, data);
          }
        } catch (error) {
          console.error(`[ChatExecutionService] Error parsing message:`, error);
        }
      },
    };
  }

  /**
   * Save accumulated assistant message blocks to database
   */
  private async saveAccumulatedMessage(
    chatId: string,
    userId: string,
    authToken?: string
  ): Promise<void> {
    const accumulated = this.assistantMessageAccumulator.get(chatId);

    if (!accumulated || accumulated.blocks.length === 0) {
      console.log(`[ChatExecutionService] saveAccumulatedMessage: No blocks to save for ${chatId}`);
      return;
    }

    console.log(
      `[ChatExecutionService] saveAccumulatedMessage: Saving ${accumulated.blocks.length} blocks for ${chatId}`
    );

    // Clear accumulator immediately
    this.assistantMessageAccumulator.delete(chatId);

    try {
      // Fetch chat to get agent setup ID
      const chat = await this.chatService.getChat(chatId, userId, authToken);

      // Use ChatService to buffer and persist
      await this.chatService.bufferMessage(
        userId,
        chatId,
        'assistant',
        { blocks: accumulated.blocks },
        authToken
      );

      console.log(`[ChatExecutionService] Assistant message saved for ${chatId}`);
    } catch (error) {
      console.error(`[ChatExecutionService] Failed to save accumulated message:`, error);
    }
  }

  /**
   * Extract notification preview text from accumulated blocks before they are cleared.
   * Returns the last text block's content truncated to 100 chars, or a fallback message.
   */
  private extractNotificationPreview(chatId: string): string {
    const accumulated = this.assistantMessageAccumulator.get(chatId);
    if (!accumulated || accumulated.blocks.length === 0) {
      return 'Claude has finished responding';
    }

    const textBlocks = accumulated.blocks.filter(
      (block: any) => block.type === 'text' && (block.text || block.content)
    );

    if (textBlocks.length === 0) {
      return 'Claude has finished responding';
    }

    const lastTextBlock = textBlocks[textBlocks.length - 1];
    const text = (lastTextBlock.text || lastTextBlock.content || '').trim();

    if (!text) {
      return 'Claude has finished responding';
    }

    return text.length > 100 ? text.substring(0, 100) + '...' : text;
  }

  /**
   * Send push notification if user is offline
   */
  private async sendPushNotificationIfOffline(
    userId: string,
    chatId: string,
    authToken?: string,
    emitter?: IOutputEmitter,
    previewBody?: string
  ): Promise<void> {
    if (!this.pushNotificationService) {
      return;
    }

    try {
      // Create callback to check if user is online via the emitter
      // SocketEmitter has isUserOnline() method, NoOpEmitter doesn't (always sends)
      const isUserOnline =
        emitter && 'isUserOnline' in emitter
          ? (uid: string) => (emitter as any).isUserOnline(uid)
          : undefined;

      // Fetch chat title for rich notification content
      let notificationTitle = 'Chat completed';
      try {
        const chat = await this.chatService.getChat(chatId, userId, authToken);
        if (chat?.title) {
          notificationTitle = chat.title;
        }
      } catch (error) {
        console.warn('[ChatExecutionService] Failed to fetch chat title for notification:', error);
      }

      const notificationBody = previewBody || 'Claude has finished responding';

      await this.pushNotificationService.sendIfOffline(
        userId,
        {
          title: notificationTitle,
          body: notificationBody,
          chatId,
          data: { chatId },
        },
        authToken,
        isUserOnline
      );
    } catch (error) {
      console.warn('[ChatExecutionService] Failed to send push notification:', error);
    }
  }

  /**
   * Format local repos list for system prompt
   */
  private formatLocalReposList(localRepos: any[]): string {
    if (localRepos.length === 0) {
      return '\n\nNo repositories are currently cloned locally.';
    }

    return (
      '\n\nLOCALLY CLONED REPOSITORIES:\n' +
      localRepos.map((r: any) => `- ${r.full_name} (${r.localPath})`).join('\n')
    );
  }

  /**
   * Collect runtime state for system prompt
   */
  private async collectRuntimeState(userId: string, repoPath: string): Promise<string> {
    if (!this.tunnelService || !this.processTrackerService) {
      return '';
    }

    try {
      return await RuntimeStateFormatter.formatRuntimeStateForRepo(userId, repoPath, {
        tunnelService: this.tunnelService,
        processTrackerService: this.processTrackerService,
      });
    } catch (error) {
      console.warn('[ChatExecutionService] Failed to format runtime state:', error);
      return '';
    }
  }

  /**
   * Build system prompt based on context
   */
  private buildSystemPrompt(params: {
    agentSetupId?: string;
    repoOwner?: string;
    repoName?: string;
    repoPath: string;
    localReposList: string;
    pageContext?: PageContext;
    runtimeState?: string;
    permissions?: string;
    aiStyle?: AIStyleMode;
    customAiStylePrompt?: string;
    isCodeProject: boolean;
    username: string;
    userEmail: string;
    userId?: string;
    sopWorksheetPath?: string;
    sopWorksheetContent?: string;
  }): string {
    const {
      agentSetupId,
      repoOwner,
      repoName,
      repoPath,
      localReposList,
      pageContext,
      runtimeState,
      permissions,
      aiStyle,
      customAiStylePrompt,
      isCodeProject,
      username,
      userEmail,
      userId,
      sopWorksheetPath,
      sopWorksheetContent,
    } = params;

    if (!agentSetupId) {
      throw new Error('Agent setup ID is required. All chats must have an agent configuration.');
    }

    return buildSystemPromptFromSetup(
      agentSetupId,
      {
        owner: repoOwner,
        repo: repoName,
        repoPath,
        localReposList,
        pageContext,
        runtimeState,
        permissionMode: permissions,
        aiStyle,
        customAiStylePrompt,
        username,
        userEmail,
        userId,
        sopWorksheetPath,
        sopWorksheetContent,
      },
      this.tunnelService
    );
  }

  /**
   * Initialize git for exploration projects
   */
  private async initializeGitForExploration(
    repoPath: string,
    username: string,
    userEmail: string
  ): Promise<void> {
    const { execSync } = await import('child_process');
    const fsSync = await import('fs');

    // CRITICAL: Validate directory exists before running git commands
    // Without this check, execSync with invalid cwd can fall back to current directory,
    // polluting the server's own git config (e.g., setting user to 'testuser' in tests)
    if (!fsSync.existsSync(repoPath)) {
      throw new Error(
        `Repository directory does not exist: ${repoPath}. Cannot initialize git for exploration.`
      );
    }

    try {
      execSync('git init', { cwd: repoPath });
      execSync(`git config user.name "${username}"`, { cwd: repoPath });
      execSync(`git config user.email "${userEmail}"`, { cwd: repoPath });
      console.log(`[ChatExecutionService] ✓ Initialized local git for exploration at ${repoPath}`);
    } catch (error) {
      throw new Error(
        `[ChatExecutionService] Failed to initialize git for exploration at ${repoPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
