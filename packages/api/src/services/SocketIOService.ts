import { type AIStyleMode } from '@vgit2/shared/aiStyles';
import { debugLog } from '@vgit2/shared/constants';
import { EXPO_RN_ORIGIN_PATTERNS } from '@vgit2/shared/cors';
import { DevicePresenceStore, PairingStateStore, type DeviceInfo } from '@vgit2/shared/secrets';
import { Server, Socket } from 'socket.io';

import { SocketEmitter } from './emitters/SocketEmitter.js';

import type { AuthService } from './AuthService.js';
import type { ChatService } from './ChatService.js';
import type { ClaudeService } from './ClaudeService.js';
import type { GitLocalService } from './GitLocalService.js';
import type { TunnelService } from './TunnelService.js';
import type { DbAdapter } from '../db/DbAdapter.js';
import type { ExecutionContext } from './types/ExecutionContext.js';
import type { PageContext, SandboxMetrics } from '@vgit2/shared/types';
import type { Server as HttpServer } from 'http';

/**
 * SocketIOService
 *
 * Manages Socket.IO connections, rooms, and real-time messaging.
 *
 * Features:
 * - Multi-device sync (same user, multiple tabs/devices)
 * - Room-based architecture (1 chat = 1 room)
 * - Optional Redis adapter for horizontal scaling
 * - Automatic reconnection and state recovery
 */
export class SocketIOService {
  private io: Server;

  // Track last activity time per socket for idle detection
  // socketId -> timestamp
  private socketActivity: Map<string, number> = new Map();

  // Idle timeout interval
  private idleCheckInterval?: NodeJS.Timeout;

  // "Has this PC ever been connected?" marker (read by the launcher at boot to
  // pick the pairing-QR screen vs. the connected menu). Stamped best-effort +
  // throttled on each authenticated device connection. See @vgit2/shared/secrets.
  private readonly pairingState = new PairingStateStore();

  // LIVE "which mobile devices are connected right now?" file — rewritten on every
  // connect/disconnect from the current Socket.IO connections. The launcher polls
  // it to drive the connected menu's right-hand device column. See @vgit2/shared/secrets.
  private readonly devicePresence = new DevicePresenceStore();

  constructor(
    httpServer: HttpServer,
    private authService: AuthService,
    private chatService: ChatService,
    private claudeService: ClaudeService,
    private gitLocalService: GitLocalService,
    private claudeCodeSessions: Map<string, any>,
    private chatExecutionService: any, // ChatExecutionService for unified execution
    private runtimeStateService: any, // RuntimeStateService for runtime state collection
    private tunnelService?: TunnelService,
    private processTrackerService?: any,
    private dbAdapter?: DbAdapter,
    private sopService?: any,
    private pushNotificationService?: any // PushNotificationService (avoid circular import)
  ) {
    console.log('[SocketIO] Initializing Socket.IO server...');

    // Initialize Socket.IO
    this.io = new Server(httpServer, {
      cors: {
        origin: [
          'https://portable.dev',
          'https://portable-dev.com',
          'https://app.portable.dev',
          'https://app.portable-dev.com',
          'https://modal.portable.dev',
          'https://modal.portable-dev.com',
          'http://localhost:3000',
          'http://localhost:7878',
          'http://localhost:65534',
          'http://localhost:65535',
          // Mobile app origins
          'capacitor://localhost', // iOS
          'https://localhost', // Android (uses HTTPS scheme)
          // Remote sandbox origin patterns removed: the runtime is now the
          // user's PC behind the stable online relay/gateway (origins above), not
          // an ephemeral remote sandbox.
          // Expo React Native client origins (exp:// dev client, exp+<slug>:// custom
          // scheme). A bare native RN handshake sends no Origin header, which the cors
          // layer treats as allowed. Canonical list lives in @vgit2/shared/cors.
          ...EXPO_RN_ORIGIN_PATTERNS,
        ],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 120000, // 2 minutes - detect dead connections quickly (mobile background)
      pingInterval: 30000, // 30 seconds keepalive ping (faster detection)
      // Enable compression for messages > 1KB
      perMessageDeflate: {
        threshold: 1024,
      },
    });

    // Setup authentication
    this.setupAuth();

    // Setup event handlers
    this.setupEventHandlers();

    // Start idle client detection (5 min timeout)
    this.startIdleClientDetection();

    // Reset the live device-presence file to the CURRENT (empty) socket set on boot.
    // It is otherwise only rewritten on connect/disconnect, so a PREVIOUS instance that
    // died with a device connected leaves a STALE "device connected" entry behind. The
    // launcher's tunnel self-heal reads this (isDeviceConnected) and would WRONGLY
    // suppress a cloudflared cycle — stranding the phone on a dead relay mapping (502)
    // with no recovery. Clearing it here means a fresh boot truthfully reports "no
    // device connected" until a real handshake arrives. Best-effort; never throws.
    this.writeDevicePresence();

    debugLog('[SocketIO] ✓ Socket.IO server initialized');
  }

  /**
   * Setup authentication middleware
   */
  private setupAuth() {
    this.io.use(async (socket, next) => {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      try {
        // Delegate authentication logic to AuthService
        const authResult = await this.authService.validateSocketAuth(token);

        if (!authResult.valid) {
          return next(new Error(authResult.error || 'Invalid authentication'));
        }

        // Store validated auth data in socket
        socket.data.userEmail = authResult.userEmail;
        socket.data.username = authResult.username;
        socket.data.token = token; // JWT auth token

        // Outdated-client detection: capture the handshake-reported app
        // version. Up-to-date clients (native) send `appVersion`;
        // pre-handshake native builds send nothing and are blocked at `chat:message`
        // when the VERIFY_HANDSHAKE kill switch is on.
        socket.data.appVersion =
          typeof socket.handshake.auth.appVersion === 'string'
            ? socket.handshake.auth.appVersion
            : undefined;

        // The app self-reports its make/model (expo-device) so the launcher's
        // terminal UI can name the connected phone (e.g. "Apple iPhone 15 Pro").
        socket.data.deviceName =
          typeof socket.handshake.auth.deviceName === 'string' &&
          socket.handshake.auth.deviceName.trim()
            ? socket.handshake.auth.deviceName.trim()
            : undefined;

        // TEMP diagnostics — what the client actually sent in the handshake.
        console.log(
          `[#1493][handshake] user=${authResult.userEmail} ` +
            `origin=${JSON.stringify(socket.handshake.headers.origin)} ` +
            `appVersion=${JSON.stringify(socket.data.appVersion)} ` +
            `rawAuthAppVersion=${JSON.stringify(socket.handshake.auth.appVersion)}`
        );

        next();
      } catch (error: any) {
        next(new Error(`Authentication failed: ${error?.message || error?.toString?.()}`));
      }
    });
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers() {
    this.io.on('connection', async (socket: Socket) => {
      const { userEmail } = socket.data;
      // Per-connection log is opt-in via PORTABLE_DEBUG (set by `portable start
      // --debug`) so the launcher can stream "a device just connected" to the
      // terminal without this firing on every connect in normal runs.
      if (process.env.PORTABLE_DEBUG) {
        console.log(`[SocketIO] User connected: ${userEmail} (${socket.id})`);
      }

      // Stamp the cross-process "ever connected" marker (US: connected-aware CLI).
      // This socket already passed the JWT/device-token handshake, so it's a real
      // paired device — the precise signal the launcher reads at next boot to drop
      // the QR for the connected menu. Best-effort + throttled; never blocks/throws.
      try {
        this.pairingState.markConnected({ throttleMs: 60_000 });
      } catch {
        // Detection is best-effort — a failed stamp must never affect the connection.
      }

      // Record this device's connect time + refresh the live presence file (read by
      // the launcher for the connected menu's device column). Best-effort.
      socket.data.connectedAt = new Date().toISOString();
      this.writeDevicePresence();

      // Track initial activity (for per-socket idle detection)
      this.updateSocketActivity(socket.id);

      // Don't auto-join chats on connection
      // Users will join rooms explicitly when they open a chat (via chat:join event)
      // This prevents all chats from appearing in tabs immediately

      // Send user's current runtime state (tunnels)
      // This is per-user ephemeral state that doesn't persist across server restarts
      this.sendUserRuntimeState(socket, userEmail);

      // Setup chat event handlers
      this.setupChatHandlers(socket);

      // Setup Claude event handlers
      this.setupClaudeHandlers(socket);

      // Handle ping (for PWA connection health checks)
      socket.on('ping', (data: any, callback: (response: any) => void) => {
        // Update activity on ping (for per-socket idle detection)
        this.updateSocketActivity(socket.id);

        // DON'T record in global idle timer - pings are just keepalive, not real user activity
        // Only real interactions (messages, clicks) should reset the global idle timer

        // Respond immediately to confirm connection is alive
        if (callback) {
          callback({ pong: true, timestamp: Date.now() });
        }
      });

      // Handle disconnect
      socket.on('disconnect', (reason) => {
        console.log(`[SocketIO] User disconnected: ${userEmail} (${socket.id}) - ${reason}`);

        // Clean up activity tracking
        this.socketActivity.delete(socket.id);

        // Refresh the live presence file so the launcher's device column updates
        // (the socket is removed from io.sockets BEFORE this handler runs).
        this.writeDevicePresence();
      });
    });
  }

  /**
   * Rewrite the live device-presence file from the CURRENT Socket.IO connections.
   * Called on every connect/disconnect; best-effort (never throws). The launcher
   * polls this to show which mobile devices are connected in the connected menu.
   */
  private writeDevicePresence(): void {
    try {
      const devices: DeviceInfo[] = [];
      for (const [, socket] of this.io.sockets.sockets) {
        devices.push({
          id: socket.id,
          name: typeof socket.data.deviceName === 'string' ? socket.data.deviceName : undefined,
          appVersion:
            typeof socket.data.appVersion === 'string' ? socket.data.appVersion : undefined,
          connectedAt:
            typeof socket.data.connectedAt === 'string'
              ? socket.data.connectedAt
              : new Date().toISOString(),
        });
      }
      this.devicePresence.write(devices);
    } catch {
      // Presence is best-effort — never affect the connection lifecycle.
    }
  }

  /**
   * Broadcast FULL runtime state to all user's connected sockets
   * Sends complete snapshot - no deltas, always full state
   */
  public broadcastRuntimeStateToUser(userId: string): void {
    const userSockets = this.getUserSockets(userId);
    if (userSockets.length === 0) {
      return;
    }

    console.log(
      `[SocketIO] Broadcasting full runtime state to ${userSockets.length} socket(s) for user ${userId}`
    );

    // Send full state to each socket
    userSockets.forEach((socket) => {
      this.sendUserRuntimeState(socket, userId);
    });
  }

  /**
   * Send user's current runtime state on connection
   * Runtime state includes:
   * - Active Cloudflare tunnels (for dev servers)
   *
   * NOTE: This is per-user ephemeral state, not per-chat.
   * It only includes resources that are currently active in memory.
   * After server restart, this will be empty (which is correct - sessions/tunnels are dead).
   */
  private async sendUserRuntimeState(socket: Socket, userId: string): Promise<void> {
    try {
      // ALWAYS send a full snapshot — empty when nothing is active — so a
      // reconnecting client OVERWRITES any stale runtime state it cached (e.g. a
      // dead `*.trycloudflare.com` dev-server tunnel left over from before a PC
      // restart). Sending nothing on "no active state" was the root cause of the
      // dead preview staying "stuck" in the runtime panel/bubble after a restart.
      const runtimeState = await this.runtimeStateService.getRuntimeStateForBroadcast(userId);
      socket.emit('user:runtime_state', runtimeState);
    } catch (error) {
      console.error(`[SocketIO] Error sending runtime state to ${userId}:`, error);
    }
  }

  /**
   * Removed: Auto-join user's active chats on connection
   *
   * Users now join rooms explicitly when they open a chat (via chat:join event).
   * This prevents all chats from appearing in tabs immediately on page load.
   */

  /**
   * Setup chat event handlers
   */
  private setupChatHandlers(socket: Socket) {
    // Join specific chat room
    socket.on('chat:join', async (data: { chatId: string; count?: number }, callback) => {
      const { chatId } = data;
      const { userEmail } = socket.data;

      // Validate chatId - reject undefined/null/empty
      if (!chatId || chatId === 'undefined' || chatId === 'null') {
        console.error(`[SocketIO] ❌ Invalid chatId in chat:join from ${userEmail}:`, chatId);
        if (callback) {
          callback({ success: false, error: 'Invalid chatId' });
        }
        return;
      }

      try {
        // Join Socket.IO room
        socket.join(chatId);

        // Build execution context
        const context = this.buildExecutionContext(socket, chatId);

        // Delegate to ChatExecutionService
        const response = await this.chatExecutionService.handleChatJoin(context, data);

        callback(response);
      } catch (error: any) {
        console.error(`[SocketIO] Error joining chat ${chatId}:`, error);
        callback({ success: false, error: error.message });
      }
    });

    // Note: We intentionally don't have chat:leave handler
    // Users stay in rooms even after navigating away from chat
    // This ensures they receive real-time updates for unread message counts
    // Rooms are automatically cleaned up when socket disconnects

    // Create new chat
    socket.on(
      'chat:create',
      async (
        data: {
          chatId: string;
          type: 'claude_code';
          title: string;
          owner: string;
          repo: string;
          model?: string;
          permissions?: string;
          agentSetupId?: string;
        },
        callback
      ) => {
        const { chatId } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chatId);

          // Delegate to ChatExecutionService for all business logic
          const result = await this.chatExecutionService.handleChatCreate(context, data);

          if (!result.success) {
            callback({ success: false, error: result.error });
            return;
          }

          // Join room (Socket.IO concern)
          socket.join(chatId);

          // Broadcast to all user's sockets (multi-device sync). Per-socket
          // emit — sockets never join a `user:{id}` room, so the previous
          // `io.to(...)` broadcast was delivered to nobody; this
          // mirrors SocketEmitter.emitToUser.
          for (const userSocket of this.getUserSockets(context.userId)) {
            userSocket.emit('chat:created', { chat: result.chat });
          }

          callback({ success: true });
        } catch (error: any) {
          console.error(`[SocketIO] Error creating chat ${chatId}:`, error);
          callback({ success: false, error: error.message });
        }
      }
    );

    // Send message
    socket.on(
      'chat:message',
      async (
        message: {
          chatId: string;
          messageId?: string; // Unique message ID from the client
          content: string;
          files?: any[];
          context?: PageContext;
          model?: string;
          permissions?: string;
          agentSetupId?: string;
          regenerationRequest?: any;
          aiStyle?: string;
          customAiStylePrompt?: string;
          customDisplay?: any; // Custom display configuration for the message
        },
        callback: (response: { success: boolean; error?: string }) => void
      ) => {
        const { chatId, messageId, context, aiStyle, customAiStylePrompt, files } = message;

        console.log(
          `[SocketIO] 📨 chat:message received: chatId=${chatId}, content="${message.content?.substring(0, 50)}"`
        );

        // Update activity on any message
        this.updateSocketActivity(socket.id);

        // Validate chatId - reject undefined/null/empty
        if (!chatId || chatId === 'undefined' || chatId === 'null') {
          console.error(
            `[SocketIO] ❌ Invalid chatId received from ${socket.data.userEmail}:`,
            chatId
          );
          if (callback) {
            callback({ success: false, error: 'Invalid chatId' });
          }
          return;
        }

        try {
          // Build execution context
          const executionContext = this.buildExecutionContext(socket, chatId);

          // Outdated native build (no version handshake) → do NOT run Claude.
          // Return the ephemeral "update your app" notice instead, persisting
          // nothing. Gated by the gateway VERIFY_HANDSHAKE kill switch
          // (fail-open: never blocks when the flag is off/unreachable). Must join
          // the room first so the emit reaches this socket; nothing else
          // (user_message echo, persistence, execution) runs.
          if (await this.chatExecutionService.shouldBlockOutdatedClient(executionContext)) {
            if (!socket.rooms.has(chatId)) {
              socket.join(chatId);
            }
            this.chatExecutionService.emitOutdatedClientNotice(executionContext);
            callback({ success: true });
            return;
          }

          // Delegate to ChatExecutionService for preparation
          const prepared = await this.chatExecutionService.handleChatMessage(
            executionContext,
            message
          );

          if (!prepared.success) {
            callback({ success: false, error: prepared.error });
            return;
          }

          // FORK-ON-FIRST-WRITE: handleChatMessage may have forked a Claude Code chat into a
          // brand-new Portable chat. Retarget the room join / echo / execution to that new id
          // (it already emitted chat:created + chat:forked so the client navigates). For every
          // normal chat effChatId === chatId and the context is reused unchanged.
          const effChatId = prepared.chatId ?? chatId;
          const execContext =
            effChatId === chatId ? executionContext : this.buildExecutionContext(socket, effChatId);

          // ===== OPTIMISTIC BROADCAST =====

          // Ensure socket is in room
          if (!socket.rooms.has(effChatId)) {
            socket.join(effChatId);
          }

          // Broadcast user message immediately (echo the client's messageId for deduplication)
          this.io.to(effChatId).emit('user_message', {
            chatId: effChatId,
            id: messageId, // Echo the ID from the client
            content: prepared.effectiveContent,
            uploadedFiles: files,
            timestamp: Date.now(),
          });

          // Acknowledge immediately (non-blocking)
          callback({ success: true });

          // ===== ASYNC EXECUTION =====

          // Execute async (don't block callback)
          (async () => {
            try {
              // Execute via ChatExecutionService
              await this.chatExecutionService.executeMessage(
                execContext,
                {
                  content: prepared.effectiveContent!,
                  uploadedFiles: files,
                  context: context,
                },
                {
                  pageContext: context,
                  model: prepared.effectiveModel!,
                  permissions: prepared.effectivePermissions!,
                  aiStyle: aiStyle as AIStyleMode,
                  customAiStylePrompt,
                  agentSetupId: prepared.effectiveAgentSetupId!,
                  uploadedFiles: files,
                  isCodeProject: context?.isCodeProject,
                }
              );

              console.log(`[SocketIO] ChatExecutionService completed for ${effChatId}`);
            } catch (error: any) {
              console.error(`[SocketIO] ChatExecutionService error:`, error);

              // Emit error to clients (transport concern)
              this.io.to(effChatId).emit('claude:status', { chatId: effChatId, status: 'error' });
              this.io.to(effChatId).emit('claude:error', {
                chatId: effChatId,
                error: error.message || 'Failed to process message',
              });
            }
          })();
        } catch (error: any) {
          console.error(`[SocketIO] chat:message handler error:`, error);
          callback({ success: false, error: error.message || 'Internal error' });
        }
      }
    );

    // Load more messages (pagination)
    socket.on(
      'chat:load_more',
      async (
        data: {
          chatId: string;
          afterId: number;
          limit?: number;
        },
        callback
      ) => {
        const { chatId } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chatId);

          // Delegate to ChatExecutionService
          const result = await this.chatExecutionService.handleChatLoadMore(context, data);

          callback(result);
        } catch (error: any) {
          console.error(`[SocketIO] Error loading messages for ${chatId}:`, error);
          callback({ success: false, error: error.message, messages: [], hasMore: false });
        }
      }
    );

    // Mark messages as read
    socket.on(
      'chat:mark_read',
      async (
        data: {
          chatId: string;
          messageId: number;
        },
        callback
      ) => {
        const { chatId } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chatId);

          // Delegate to ChatExecutionService
          const result = await this.chatExecutionService.handleChatMarkRead(context, data);

          callback(result);
        } catch (error: any) {
          console.error(`[SocketIO] Error marking chat ${chatId} as read:`, error);
          callback({ success: false, error: error.message });
        }
      }
    );

    // Update chat settings (model and/or permissions)
    socket.on(
      'chat:update_settings',
      async (
        data: {
          chatId: string;
          settings: { model?: string; permissions?: string };
        },
        callback
      ) => {
        const { chatId } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chatId);

          // Delegate to ChatExecutionService
          const result = await this.chatExecutionService.handleUpdateSettings(context, data);

          callback(result);
        } catch (error: any) {
          console.error(`[SocketIO] Error updating chat ${chatId} settings:`, error);
          callback({ success: false, error: error.message });
        }
      }
    );

    // Note: No chat:leave handler - users stay in rooms for real-time sync
  }

  /**
   * Setup Claude event handlers
   */
  private setupClaudeHandlers(socket: Socket) {
    // Interrupt Claude session
    socket.on('claude:interrupt', async (data: { chatId: string }, callback) => {
      const { chatId } = data;

      try {
        // Build execution context
        const context = this.buildExecutionContext(socket, chatId);

        // Delegate to ChatExecutionService
        const result = await this.chatExecutionService.handleClaudeInterrupt(context, data);

        callback(result);
      } catch (error: any) {
        console.error(`[SocketIO] Error interrupting Claude session ${chatId}:`, error);
        callback({ success: false, error: error.message });
      }
    });

    // Kill a chat's Claude session on demand. Mirrors
    // claude:interrupt but validates ownership and refreshes the runtime panel.
    socket.on('chat:kill-session', async (data: { chatId: string }, callback) => {
      const { chatId } = data;

      try {
        const context = this.buildExecutionContext(socket, chatId);
        const result = await this.chatExecutionService.handleKillSession(context, data);
        callback?.(result);
      } catch (error: any) {
        console.error(`[SocketIO] Error killing Claude session ${chatId}:`, error);
        callback?.({ success: false, error: error.message });
      }
    });

    // Submit secrets
    socket.on(
      'secrets:submit',
      async (
        data: {
          chatId: string;
          secrets: Record<string, string>;
        },
        callback?: (response: { success: boolean; error?: string }) => void
      ) => {
        const { chatId, secrets } = data;

        try {
          // Handle secrets submission (delegate to existing logic)
          // This will be integrated with ClaudeService

          // Notify room
          this.io.to(chatId).emit('secrets:submitted', { chatId });

          callback?.({ success: true });
        } catch (error: any) {
          console.error(`[SocketIO] Error submitting secrets for ${chatId}:`, error);
          callback?.({ success: false, error: error.message });
        }
      }
    );

    // Respond to permission request (approve/deny tool use)
    socket.on(
      'permission:respond',
      async (
        data: {
          requestId: string;
          chatId: string;
          approved: boolean;
        },
        callback
      ) => {
        const { chatId } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chatId);

          // Delegate to ChatExecutionService
          const result = await this.chatExecutionService.handlePermissionResponse(context, data);

          callback(result);
        } catch (error: any) {
          console.error(`[SocketIO] Error responding to permission request:`, error);
          callback({ success: false, error: error.message });
        }
      }
    );

    // Answer user question (response to AskUserQuestion tool)
    socket.on(
      'answer_user_question',
      async (
        data: {
          type: 'answer_user_question';
          request_id: string;
          chat_id: string;
          answers: Record<string, string[]>;
        },
        callback
      ) => {
        const { chat_id } = data;

        try {
          // Build execution context
          const context = this.buildExecutionContext(socket, chat_id);

          // Delegate to ChatExecutionService
          const result = await this.chatExecutionService.handleAnswerUserQuestion(context, data);

          callback?.(result);
        } catch (error: any) {
          console.error(`[SocketIO] Error submitting answers:`, error);
          callback?.({ success: false, error: error.message });
        }
      }
    );
  }

  /**
   * Public method for services to broadcast to rooms
   */
  public broadcastToRoom(chatId: string, event: string, data: any) {
    this.io.to(chatId).emit(event, data);
  }

  /**
   * Get connected sockets for a user
   */
  public getUserSockets(userEmail: string): Socket[] {
    const sockets: Socket[] = [];

    for (const [, socket] of this.io.sockets.sockets) {
      if (socket.data.userEmail === userEmail) {
        sockets.push(socket);
      }
    }

    return sockets;
  }

  /**
   * Build ExecutionContext from socket data.
   * Centralizes extraction of user context for ChatExecutionService.
   *
   * Note: User connection tokens (Google Drive, Slack, GitHub) are managed by
   * ConnectionsService and accessed during tool execution, not passed here.
   */
  private buildExecutionContext(socket: Socket, chatId: string): ExecutionContext {
    const { userEmail, token, username, appVersion } = socket.data;

    // Create SocketEmitter for this chat with runtime state callback
    const emitter = new SocketEmitter(
      this.io,
      chatId,
      userEmail,
      (userId) => this.getUserSockets(userId),
      (userId) => this.broadcastRuntimeStateToUser(userId) // Pass callback explicitly
    );

    return {
      chatId,
      userId: userEmail,
      username,
      authToken: token,
      emitter,
      appVersion,
    };
  }

  /**
   * Get connection count
   */
  public getConnectionCount(): number {
    return this.io.sockets.sockets.size;
  }

  /**
   * Start idle client detection
   * Checks for inactive sockets every minute and disconnects them if idle > 5 minutes
   */
  private startIdleClientDetection() {
    const IDLE_CHECK_INTERVAL = 60000; // Check every 1 minute
    const IDLE_TIMEOUT = 300000; // 5 minutes idle = disconnect

    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      const socketsToDisconnect: Socket[] = [];

      // Check all connected sockets
      for (const [socketId, socket] of this.io.sockets.sockets) {
        const lastActivity = this.socketActivity.get(socketId);

        // Skip if no activity tracked yet (just connected)
        if (!lastActivity) continue;

        const idleTime = now - lastActivity;

        if (idleTime > IDLE_TIMEOUT) {
          console.log(
            `[SocketIO] Socket ${socketId} (${socket.data.userEmail}) idle for ${Math.round(
              idleTime / 1000
            )}s - disconnecting`
          );
          socketsToDisconnect.push(socket);
        }
      }

      // Disconnect idle sockets
      socketsToDisconnect.forEach((socket) => {
        socket.emit('session:expired', {
          reason: 'Idle for more than 5 minutes',
        });
        socket.disconnect(true);
        this.socketActivity.delete(socket.id);
      });

      if (socketsToDisconnect.length > 0) {
        debugLog(`[SocketIO] Disconnected ${socketsToDisconnect.length} idle socket(s)`);
      }
    }, IDLE_CHECK_INTERVAL);

    debugLog('[SocketIO] ✓ Idle client detection started (development mode)');
  }

  /**
   * Update socket activity timestamp
   */
  private updateSocketActivity(socketId: string) {
    this.socketActivity.set(socketId, Date.now());
  }

  /**
   * Emit an event to every connected socket of a single user (multi-device).
   * Mirrors SocketEmitter.emitToUser — never `io.to('user:...')` (no socket joins
   * that room). Used by the session reaper to push `session:reaped`.
   */
  public emitToUser(userId: string, event: string, data: any): void {
    for (const socket of this.getUserSockets(userId)) {
      socket.emit(event, data);
    }
  }

  /**
   * Broadcast event to ALL connected clients (all sockets, all rooms)
   * Used for system-wide notifications like shutdown warnings
   */
  public broadcastToAll(event: string, data: any) {
    console.log(
      `[SocketIO] Broadcasting to all ${this.io.sockets.sockets.size} connected clients: ${event}`,
      data
    );
    this.io.emit(event, data);
  }

  /**
   * Quiet broadcast of host CPU/RAM metrics (`sandbox:metrics`, ~2s from
   * HostMetricsService) to every connected client. Host-global (single-user PC),
   * so this is the UN-logged sibling of broadcastToAll — no-op when nobody is
   * connected.
   */
  public broadcastSandboxMetrics(metrics: SandboxMetrics): void {
    if (this.io.sockets.sockets.size === 0) return;
    this.io.emit('sandbox:metrics', metrics);
  }

  /**
   * Graceful shutdown
   */
  public async shutdown() {
    console.log('[SocketIO] Shutting down...');

    // Stop idle client detection
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

    // Clear activity tracking
    this.socketActivity.clear();

    // Close all connections
    this.io.close();

    console.log('[SocketIO] ✓ Shutdown complete');
  }
}
