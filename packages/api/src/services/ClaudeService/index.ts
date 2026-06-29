import { ChatService } from '../ChatService.js';
import { DevServerMonitorService } from '../DevServerMonitorService.js';
import { McpService } from '../mcp/McpService.js';
import { MediaProcessingService } from '../MediaProcessingService.js';
import { ActionHandler } from './handlers/ActionHandler.js';
import { AgentHandler } from './handlers/AgentHandler.js';
import { ExecutionHandler } from './handlers/ExecutionHandler.js';
import { PermissionHandler } from './handlers/PermissionHandler.js';
import { ProcessHandler } from './handlers/ProcessHandler.js';
import { SessionHandler } from './handlers/SessionHandler.js';
import { StreamHandler } from './handlers/StreamHandler.js';

import type { ClaudeSession } from '../../types/index.js';
import type { LocalAiHelper } from '../ai/LocalAiHelper.js';
import type { ConnectionsService } from '../ConnectionsService.js';
import type { GitLocalService } from '../GitLocalService.js';
import type { SecretsService } from '../SecretsService.js';
import type { TunnelService } from '../TunnelService.js';

// Import handlers

import type {
  HandlerDependencies,
  PermissionRequest,
  PendingBackgroundBash,
  PendingToolUse,
  SubAgentInfo,
} from './types.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { RuntimeClaudeSessionPayload } from '@vgit2/shared/types';

/**
 * ClaudeService - Main facade for Claude Agent SDK integration
 *
 * This is the refactored modular version that delegates to specialized handlers:
 * - ProcessHandler: Background bash process checking
 * - AgentHandler: Agent configuration and setup
 * - SessionHandler: Session lifecycle management
 * - PermissionHandler: Tool permission requests
 * - ActionHandler: Action extraction from messages
 * - StreamHandler: Stream message processing
 * - ExecutionHandler: Core session execution orchestration
 *
 * Architecture:
 * - Handlers are stateless where possible
 * - Shared state (sessions, permissions) passed via constructor
 * - Each handler has single responsibility
 * - Main ClaudeService maintains API compatibility
 */
export class ClaudeService {
  // Core dependencies
  private anthropic?: Anthropic;
  private chatService: ChatService;
  private mcpService: McpService;
  private mediaProcessingService: MediaProcessingService;
  private devServerMonitor: DevServerMonitorService;
  private gitLocalService?: GitLocalService;
  private tunnelService?: TunnelService;
  private processTrackerService?: any;
  private secretsService?: SecretsService;
  private connectionsService?: ConnectionsService;

  // Shared state
  private claudeCodeSessions: Map<string, ClaudeSession>;
  private permissionRequests: Map<string, PermissionRequest> = new Map();
  private pendingPermissions: Map<string, string> = new Map();
  private postCompressionFlags: Map<string, boolean> = new Map();
  private activeSubAgents: Map<string, SubAgentInfo> = new Map();
  private pendingBackgroundBash?: Map<string, PendingBackgroundBash>;
  private pendingToolUses?: Map<string, PendingToolUse>;
  private askUserMcpServer?: any;

  // Circular dependency injections
  private socketIOService?: any;
  private chatExecutionService?: any;

  // Handlers
  private processHandler: ProcessHandler;
  private agentHandler: AgentHandler;
  private sessionHandler: SessionHandler;
  private permissionHandler: PermissionHandler;
  private actionHandler: ActionHandler;
  private streamHandler: StreamHandler;
  private executionHandler: ExecutionHandler;

  constructor(
    chatService: ChatService,
    mcpService: McpService,
    claudeCodeSessions?: Map<string, ClaudeSession>,
    _containerService?: any,
    gitLocalService?: GitLocalService,
    tunnelService?: TunnelService,
    processTrackerService?: any,
    secretsService?: SecretsService,
    connectionsService?: ConnectionsService,
    localAiHelper?: LocalAiHelper
  ) {
    this.chatService = chatService;
    this.mcpService = mcpService;
    this.mediaProcessingService = new MediaProcessingService();
    this.devServerMonitor = new DevServerMonitorService(
      tunnelService,
      claudeCodeSessions || new Map()
    );
    this.gitLocalService = gitLocalService;
    this.tunnelService = tunnelService;
    this.processTrackerService = processTrackerService;
    this.secretsService = secretsService;
    this.connectionsService = connectionsService;
    this.claudeCodeSessions = claudeCodeSessions || new Map();

    // Initialize custom AskUser MCP server (callbacks will be configured per-session)
    // Note: In the original architecture, callbacks were set up per-session in startClaudeCodeSession
    // For now, we initialize without callbacks - they should be configured during execution
    this.askUserMcpServer = undefined; // Will be initialized per-session with proper callbacks

    // Build dependencies object for handlers
    const dependencies: HandlerDependencies = {
      chatService,
      mcpService,
      mediaProcessingService: this.mediaProcessingService,
      devServerMonitor: this.devServerMonitor,
      gitLocalService,
      tunnelService,
      processTrackerService,
      secretsService,
      connectionsService,
      localAiHelper,
      socketIOService: undefined, // Will be injected later
      chatExecutionService: undefined, // Will be injected later
    };

    // Initialize handlers
    this.processHandler = new ProcessHandler(dependencies, this.claudeCodeSessions);

    this.agentHandler = new AgentHandler(dependencies);

    this.sessionHandler = new SessionHandler(
      dependencies,
      this.claudeCodeSessions,
      this.permissionRequests,
      this.pendingPermissions,
      this.pendingBackgroundBash
    );

    this.permissionHandler = new PermissionHandler(
      dependencies,
      this.permissionRequests,
      this.pendingPermissions
    );

    this.actionHandler = new ActionHandler(dependencies);

    this.streamHandler = new StreamHandler(
      dependencies,
      this.activeSubAgents,
      this.postCompressionFlags,
      this.pendingBackgroundBash,
      this.pendingToolUses,
      this.askUserMcpServer
    );

    // ExecutionHandler coordinates all other handlers
    this.executionHandler = new ExecutionHandler(
      dependencies,
      {
        sessionHandler: this.sessionHandler,
        streamHandler: this.streamHandler,
        permissionHandler: this.permissionHandler,
        agentHandler: this.agentHandler,
        actionHandler: this.actionHandler,
      },
      this.claudeCodeSessions,
      this.permissionRequests,
      this.pendingPermissions
    );

    console.log('[ClaudeService] Modular architecture initialized with 7 specialized handlers');
  }

  /**
   * Set SocketIOService (called after construction to avoid circular dependency)
   */
  public setSocketIOService(socketIOService: any): void {
    this.socketIOService = socketIOService;
    // Inject into handlers that need it
    if (this.actionHandler) {
      (this.actionHandler as any).socketIOService = socketIOService;
    }
    if (this.streamHandler) {
      (this.streamHandler as any).socketIOService = socketIOService;
    }
    console.log('[ClaudeService] SocketIOService injected into handlers');
  }

  /**
   * Set ChatExecutionService (called after construction to avoid circular dependency)
   */
  public setChatExecutionService(chatExecutionService: any): void {
    this.chatExecutionService = chatExecutionService;
    console.log('[ClaudeService] ChatExecutionService injected');
  }

  /**
   * Set LocalAiCredentialsService. Local-first only: the PC's own
   * Claude subscription OAuth / ANTHROPIC_API_KEY drives AI calls (never a JWT
   * claim). Injected into the ExecutionHandler.
   */
  public setLocalAiCredentialsService(
    service: import('../LocalAiCredentialsService.js').LocalAiCredentialsService
  ): void {
    this.executionHandler.setLocalAiCredentialsService(service);
    console.log('[ClaudeService] LocalAiCredentialsService injected (local-first AI credentials)');
  }

  // ============================================================================
  // PUBLIC API - Delegates to appropriate handlers
  // ============================================================================

  /**
   * Start a new Claude Code session
   * Delegates to ExecutionHandler
   */
  async startClaudeCodeSession(params: any): Promise<void> {
    return this.executionHandler.startClaudeCodeSession(params);
  }

  /**
   * Stop a running session
   * Delegates to SessionHandler
   */
  async stopSession(chatId: string, userId?: string): Promise<boolean> {
    return this.sessionHandler.stopSession(chatId, userId);
  }

  /**
   * Get session by chat ID
   * Delegates to SessionHandler
   */
  getSession(chatId: string): ClaudeSession | undefined {
    return this.sessionHandler.getSession(chatId);
  }

  /**
   * Get all sessions
   * Delegates to SessionHandler
   */
  getAllSessions(): Map<string, ClaudeSession> {
    return this.sessionHandler.getAllSessions();
  }

  /**
   * Get all active sessions with metadata
   * Delegates to SessionHandler
   */
  getAllActiveSessions(): Array<{ chatId: string; userId: string }> {
    return this.sessionHandler.getAllActiveSessions();
  }

  /**
   * Check if session is running
   * Delegates to SessionHandler
   */
  isSessionRunning(chatId: string): boolean {
    return this.sessionHandler.isSessionRunning(chatId);
  }

  /**
   * Get IDs of all currently running chat sessions
   * Delegates to SessionHandler
   */
  getRunningChatIds(): string[] {
    return this.sessionHandler.getRunningChatIds();
  }

  /**
   * Enumerate the user's live Claude sessions for the runtime panel.
   * Delegates to SessionHandler.
   */
  getClaudeSessionInfos(userId: string): RuntimeClaudeSessionPayload[] {
    return this.sessionHandler.getClaudeSessionInfos(userId);
  }

  /**
   * Expose DevServerMonitor for MemoryWatchdog (port-based kill).
   */
  getDevServerMonitor(): DevServerMonitorService {
    return this.devServerMonitor;
  }

  /**
   * Check if session can be resumed
   * Delegates to SessionHandler
   */
  canResumeSession(chatId: string): boolean {
    return this.sessionHandler.canResumeSession(chatId);
  }

  /**
   * Remove session from map
   * Delegates to SessionHandler
   */
  removeSession(chatId: string): void {
    return this.sessionHandler.removeSession(chatId);
  }

  /**
   * Restore session from database
   * Delegates to SessionHandler
   */
  async restoreSessionFromDatabase(
    chatId: string,
    userId: string,
    authToken?: string
  ): Promise<boolean> {
    return this.sessionHandler.restoreSessionFromDatabase(chatId, userId, authToken);
  }

  /**
   * Add message to running session
   * Delegates to SessionHandler
   */
  addMessageToSession(chatId: string, content: string | any[], userId: string): boolean {
    return this.sessionHandler.addMessageToSession(chatId, content, userId);
  }

  /**
   * Check bash output for background process
   * Delegates to ProcessHandler
   */
  async checkBashOutput(bashId: string): Promise<any> {
    return this.processHandler.checkBashOutput(bashId);
  }

  /**
   * Resolve permission request
   * Delegates to PermissionHandler
   */
  resolvePermissionRequest(
    requestId: string,
    approved: boolean,
    answers?: Record<string, string[]>
  ) {
    return this.permissionHandler.resolvePermissionRequest(requestId, approved, answers);
  }
}
