// ============================================================================
// SHARED TYPES FOR ALL TOOLS
// ============================================================================

import type { ChatExecutionService } from '../services/ChatExecutionService.js';
import type { ChatService } from '../services/ChatService.js';
import type { ConnectionsService } from '../services/ConnectionsService.js';
import type { IOutputEmitter } from '../services/emitters/IOutputEmitter.js';
import type { GitLocalService } from '../services/GitLocalService.js';
import type { SecretsService } from '../services/SecretsService.js';
import type { TunnelService } from '../services/TunnelService.js';

export interface ToolExecutionContext {
  userId: string;
  emitEvent: (event: string, data: any) => void;
  chatId: string;
  repoPath?: string;
  ws?: any; // Mock WebSocket for Socket.IO compatibility
  gitLocalService?: GitLocalService; // Optional: for git operations
  tunnelService?: TunnelService; // Optional: for dynamic tunnel creation
  chatService?: ChatService; // Optional: for chat operations (list, analyze, update, etc.)
  chatExecutionService?: ChatExecutionService; // Optional: for triggering execution of new chats
  secretsService?: SecretsService; // Optional: for user secrets management (portable_execute)
  connectionsService?: ConnectionsService; // Optional: for user connections (portable_execute)
  emitter?: IOutputEmitter; // Optional: output emitter for real-time notifications (portable_execute)
  model?: string; // Model selection (sonnet, haiku, etc.)
  permissions?: string; // Permission mode (default, plan, accept_edits, bypass_permissions)
  authToken?: string; // Optional: JWT auth token
}

export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface NavigationMessage {
  type: 'navigate';
  chat_id: string;
  path: string;
  tab?: string;
  filters?: any;
  preloadedData?: any;
}
