import type { ClaudeSession } from '../../../types/index.js';
import type { HandlerDependencies } from '../types.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSessionStatus, RuntimeClaudeSessionPayload } from '@vgit2/shared/types';

/**
 * SessionHandler - Manages Claude Code session lifecycle
 * Responsibilities:
 * - Track active sessions in memory (Map)
 * - Create, restore, and stop sessions
 * - Add messages to running sessions
 * - Check session status (running, resumable)
 * - Clean up session resources
 */
export class SessionHandler {
  private claudeCodeSessions: Map<string, ClaudeSession>;
  private chatService: any;
  private permissionRequests: Map<
    string,
    {
      resolve: (decision: any) => void;
      toolName: string;
      toolInput: any;
      chatId: string;
      timestamp: number;
    }
  >;
  private pendingPermissions: Map<string, string>;
  private pendingBackgroundBash?: Map<
    string,
    { command: string; description: string; userId: string; chatId: string; repoPath?: string }
  >;

  constructor(
    dependencies: HandlerDependencies,
    claudeCodeSessions: Map<string, ClaudeSession>,
    permissionRequests: Map<
      string,
      {
        resolve: (decision: any) => void;
        toolName: string;
        toolInput: any;
        chatId: string;
        timestamp: number;
      }
    >,
    pendingPermissions: Map<string, string>,
    pendingBackgroundBash?: Map<
      string,
      { command: string; description: string; userId: string; chatId: string; repoPath?: string }
    >
  ) {
    this.claudeCodeSessions = claudeCodeSessions;
    this.chatService = dependencies.chatService;
    this.permissionRequests = permissionRequests;
    this.pendingPermissions = pendingPermissions;
    this.pendingBackgroundBash = pendingBackgroundBash;
  }

  /**
   * Get session by chat ID
   */
  getSession(chatId: string): ClaudeSession | undefined {
    return this.claudeCodeSessions.get(chatId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, ClaudeSession> {
    return this.claudeCodeSessions;
  }

  /**
   * Get all active sessions with their metadata (for error cleanup)
   * Returns array of {chatId, userId} for sessions that are currently processing
   */
  getAllActiveSessions(): Array<{ chatId: string; userId: string }> {
    const activeSessions: Array<{ chatId: string; userId: string }> = [];

    for (const [chatId, session] of this.claudeCodeSessions.entries()) {
      // Include all sessions that have a query (active or resumable)
      // This ensures we clean up even sessions that are in a bad state
      if (session.userId) {
        activeSessions.push({
          chatId,
          userId: session.userId,
        });
      }
    }

    return activeSessions;
  }

  /**
   * Check if a session exists and is running.
   * With unified cleanup, a session is running iff it has both query AND inputQueue.
   * (Cleanup always sets both to null/undefined when the for-await loop exits.)
   */
  isSessionRunning(chatId: string): boolean {
    const session = this.claudeCodeSessions.get(chatId);
    return !!(session && session.query && session.inputQueue);
  }

  /**
   * Get IDs of all currently running chat sessions.
   * Only returns sessions where Claude is actively generating a response
   * (isProcessing=true), NOT idle sessions waiting for user input.
   */
  getRunningChatIds(): string[] {
    const runningIds: string[] = [];
    for (const [chatId, session] of this.claudeCodeSessions.entries()) {
      if (session && session.isProcessing) {
        runningIds.push(chatId);
      }
    }
    return runningIds;
  }

  /**
   * Check if a session can be resumed (has session_id but no active query).
   * With unified cleanup, query is always null when subprocess exits.
   */
  canResumeSession(chatId: string): boolean {
    const session = this.claudeCodeSessions.get(chatId);
    return !!(session && session.session_id && !session.query);
  }

  /**
   * Remove a session from the map (cleanup)
   */
  removeSession(chatId: string): void {
    this.claudeCodeSessions.delete(chatId);
    console.log(`[SessionHandler] Removed session ${chatId}`);
  }

  /**
   * Restore a session from the database (used after server restart)
   * Loads session_id, repo_path, and systemPrompt from the database
   * and recreates the ClaudeSession object (without the query iterator)
   */
  async restoreSessionFromDatabase(
    chatId: string,
    userId: string,
    authToken?: string
  ): Promise<boolean> {
    console.log(`[SessionHandler] Restoring session ${chatId} from database`);

    // Check if session is already in memory
    const existingSession = this.claudeCodeSessions.get(chatId);
    if (existingSession) {
      console.log(`[SessionHandler] Session ${chatId} already exists in memory`);
      return true;
    }

    try {
      // Load chat from database (with authToken for RLS)
      const chat = await this.chatService.getChat(chatId, userId, authToken);
      if (!chat) {
        console.error(`[SessionHandler] Chat ${chatId} not found in database`);
        return false;
      }

      // Check if chat has session info
      if (!chat.session_id || !chat.repo_path) {
        console.error(`[SessionHandler] Chat ${chatId} has no session_id or repo_path`);
        return false;
      }

      console.log(
        `[SessionHandler] Restoring session: session_id=${chat.session_id}, repo_path=${chat.repo_path}`
      );

      // Recreate ClaudeSession object (without query iterator - will be created on resume)
      // Conversation history is preserved by Claude SDK via session_id resume mechanism
      const restoredSession: ClaudeSession = {
        repo_path: chat.repo_path,
        session_id: chat.session_id,
        query: null, // No active query until resumed
        messageQueue: [],
        signal: { stopped: false },
        resolveNextMessage: null,
        systemPrompt: chat.system_prompt || '',
        isProcessing: false, // Restored sessions start as idle (not processing)
        userId, // Store userId for cleanup
        authToken, // Store authToken for error cleanup
      };

      this.claudeCodeSessions.set(chatId, restoredSession);
      console.log(`[SessionHandler] ✓ Session ${chatId} restored successfully`);
      return true;
    } catch (error: any) {
      console.error(`[SessionHandler] Error restoring session:`, error);
      return false;
    }
  }

  /**
   * Add a message to a running session
   * Enqueues message into the inputQueue which wakes up the for-await loop
   *
   * @param chatId - Chat ID
   * @param content - Message content (string or content blocks array)
   * @param userId - User ID
   * @returns true if message was enqueued successfully
   */
  addMessageToSession(chatId: string, content: string | any[], userId: string): boolean {
    const session = this.claudeCodeSessions.get(chatId);

    if (!session || !session.query || !session.inputQueue) {
      return false;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      session_id: session.session_id || chatId,
      parent_tool_use_id: null,
    };

    try {
      session.inputQueue.enqueue(userMessage);
    } catch {
      return false;
    }

    session.isProcessing = true;
    session.lastActivityAt = Date.now(); // idle-reaper activity tracking
    return true;
  }

  /**
   * True if any pending tool-permission request belongs to this chat — i.e. the
   * session is paused awaiting a user decision (status `waiting`).
   */
  private hasPendingPermission(chatId: string): boolean {
    for (const request of this.permissionRequests.values()) {
      if (request.chatId === chatId) return true;
    }
    return false;
  }

  /**
   * Enumerate the user's LIVE Claude sessions for the runtime panel.
   *
   * Only sessions holding a live subprocess (query + inputQueue, not stopping)
   * are returned — a fully-torn-down chat retains just a `session_id` string and
   * holds no meaningful memory, so it is omitted. Status is derived from the
   * processing flag + pending-permission state; `idleMs` is measured from
   * `lastActivityAt` (set on every turn start/complete).
   */
  getClaudeSessionInfos(userId: string, now: number = Date.now()): RuntimeClaudeSessionPayload[] {
    const infos: RuntimeClaudeSessionPayload[] = [];

    for (const [chatId, session] of this.claudeCodeSessions.entries()) {
      if (!session || session.userId !== userId) continue;
      // Only live subprocesses consume memory worth surfacing.
      if (!session.query || !session.inputQueue) continue;
      // A stopping session (manual kill / reap in flight) is on its way out.
      if (session.signal?.stopped) continue;

      const status: ClaudeSessionStatus = session.isProcessing
        ? this.hasPendingPermission(chatId)
          ? 'waiting'
          : 'running'
        : 'idle';

      const lastActivityAt =
        typeof session.lastActivityAt === 'number' ? session.lastActivityAt : 0;
      const idleMs =
        status === 'idle' && lastActivityAt > 0 ? Math.max(0, now - lastActivityAt) : 0;

      infos.push({
        chatId,
        repoPath: session.repo_path,
        status,
        isProcessing: !!session.isProcessing,
        lastActivityAt,
        idleMs,
        resumable: !!session.session_id,
      });
    }

    return infos;
  }

  /**
   * Stop a running Claude Code session
   * Closes the inputQueue → iterator ends → cleanup fires → background processes killed
   * IMPORTANT: Keeps session in map for resumption (with closed queue)
   */
  async stopSession(chatId: string, userId?: string): Promise<boolean> {
    const session = this.claudeCodeSessions.get(chatId);
    if (!session) return false;

    try {
      if (!session.inputQueue) {
        this.claudeCodeSessions.delete(chatId);
        return false;
      }

      // Set stopped signal — for-await loop will break on next iteration
      session.signal.stopped = true;

      // Close queue so generator stops yielding
      session.inputQueue.close();

      // Force the query iterator to stop immediately
      if (session.query && typeof session.query.return === 'function') {
        try {
          await Promise.race([
            session.query.return(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('query.return() timeout')), 3000)
            ),
          ]);
        } catch {
          // Expected — iterator may already be exhausted or timeout
        }
      }

      // Clean up permission requests
      for (const [requestId, request] of this.permissionRequests.entries()) {
        if (request.chatId === chatId) {
          this.permissionRequests.delete(requestId);
          this.pendingPermissions.delete(`${chatId}:${request.toolName}`);
        }
      }

      // Clean up pending background bash entries
      if (this.pendingBackgroundBash) {
        for (const [toolUseId, metadata] of this.pendingBackgroundBash.entries()) {
          if (metadata.chatId === chatId) {
            this.pendingBackgroundBash.delete(toolUseId);
          }
        }
      }

      // Note: query/inputQueue/isProcessing are cleaned by the unified finally block
      // in ExecutionHandler when the for-await loop exits after signal.stopped=true.
      // Session stays in map for resumption (session_id preserved).

      return true;
    } catch (error: any) {
      console.error('[SessionHandler] Error stopping session:', error);
      throw error;
    }
  }
}
