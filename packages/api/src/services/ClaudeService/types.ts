import type { ClaudeSession } from '../../types/index.js';
import type { LocalAiHelper } from '../ai/LocalAiHelper.js';
import type { ChatService } from '../ChatService.js';
import type { ConnectionsService } from '../ConnectionsService.js';
import type { DevServerMonitorService } from '../DevServerMonitorService.js';
import type { IOutputEmitter } from '../emitters/IOutputEmitter.js';
import type { GitLocalService } from '../GitLocalService.js';
import type { LocalAiCredentialsService } from '../LocalAiCredentialsService.js';
import type { McpService } from '../mcp/McpService.js';
import type { MediaProcessingService } from '../MediaProcessingService.js';
import type { SecretsService } from '../SecretsService.js';
import type { TunnelService } from '../TunnelService.js';
import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type Anthropic from '@anthropic-ai/sdk';
import type { WebSocket } from 'ws';

/**
 * Shared dependencies injected into all handlers
 */
export interface HandlerDependencies {
  chatService: ChatService;
  mcpService: McpService;
  mediaProcessingService: MediaProcessingService;
  devServerMonitor: DevServerMonitorService;
  gitLocalService?: GitLocalService;
  tunnelService?: TunnelService;
  processTrackerService?: any;
  secretsService?: SecretsService;
  connectionsService?: ConnectionsService;
  socketIOService?: any;
  chatExecutionService?: any;
  // Local-first AI credentials — Claude OAuth or ANTHROPIC_API_KEY,
  // resolved locally (never from a JWT claim). Present only in local mode.
  localAiCredentialsService?: LocalAiCredentialsService;
  // Local-first one-shot AI helper (direct-to-Anthropic) — used by ActionHandler to
  // extract follow-up actions. Present only in local mode.
  localAiHelper?: LocalAiHelper;
}

/**
 * Permission request metadata
 */
export interface PermissionRequest {
  resolve: (decision: PermissionResult) => void;
  toolName: string;
  toolInput: any;
  chatId: string;
  timestamp: number;
}

/**
 * Pending background bash metadata
 */
export interface PendingBackgroundBash {
  command: string;
  description: string;
  userId: string;
  chatId: string;
  repoPath?: string;
}

/**
 * Pending tool use metadata
 */
export interface PendingToolUse {
  toolName: string;
  toolInput: any;
}

/**
 * Sub-agent metadata
 */
export interface SubAgentInfo {
  type: string;
  name: string;
  chatId: string;
}

/**
 * API routing mode for Anthropic calls
 */
export type ApiRoutingMode = 'proxy' | 'direct';

/**
 * Parameters for starting a Claude Code session
 */
export interface StartClaudeCodeSessionParams {
  ws: WebSocket;
  chatId: string;
  repoPath: string;
  task: string;
  uploadedFiles?: any[];
  systemPrompt: string;
  userId: string;
  username: string;
  owner?: string;
  repo?: string;
  playwrightDevice?: 'mobile' | 'desktop';
  model?: string;
  permissions?: string;
  authToken?: string;
  sessionGitHubToken?: string;
  agentSetupId?: string;
  emitter?: IOutputEmitter;
}

/**
 * Parameters for executing a Claude Code session
 */
export interface ExecuteClaudeCodeSessionParams {
  chatId: string;
  userMessage: string;
  repoPath: string;
  modelId: string;
  userId: string;
  ws: WebSocket;
  userEmail?: string;
  sessionId?: string;
  permissionMode?: PermissionMode;
  resuming?: boolean;
  skipPersistence?: boolean;
  conversationHistory?: any[];
  authToken?: string;
}

/**
 * Check bash output result
 */
export interface CheckBashOutputResult {
  output: string;
  isRunning: boolean;
}
