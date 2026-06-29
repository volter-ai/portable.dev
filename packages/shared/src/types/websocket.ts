/**
 * WebSocket message types for real-time communication
 * These types define the structure of messages sent between the client and backend via WebSocket
 */

import { ChatMessage, ChatStatus, ClaudeCodeBlock, CustomDisplay } from './chat.js';
import { PageContext, BufferedMessage } from './common.js';

import type { ModelMode } from '../models.js';

/**
 * ============================================================================
 * OUTGOING MESSAGES (Client → Backend)
 * ============================================================================
 */

/**
 * User message sent from the client
 */
export interface UserMessage {
  type: 'user_message';
  chat_id: string;
  content: string;
  context: PageContext;
  userToken: string | null;
  onWaitlist: boolean;
  autofill?: boolean;
  uploadedFiles?: any[];
  model?: ModelMode;
  aiStyle?: string;
  customAiStylePrompt?: string;
  customDisplay?: CustomDisplay; // Custom display configuration for the message
}

/**
 * Request to sync chat messages from backend
 */
export interface SyncChatMessage {
  type: 'sync_chat';
  chat_id: string;
  userToken: string;
  limit: number;
  offset: number;
}

/**
 * Interrupt Claude Code session
 */
export interface ClaudeCodeInterruptMessage {
  type: 'claude_code_interrupt';
  tool_use_id: string;
}

/**
 * Submit environment secrets to backend
 */
export interface SubmitSecretsMessage {
  type: 'submit_secrets';
  chat_id: string;
  file_path: string;
  secrets: Record<string, string>;
  keys_set: string[];
}

/**
 * Cancel secrets submission
 */
export interface SecretsCancelledMessage {
  type: 'secrets_cancelled';
  chat_id: string;
}

/**
 * Permission response (approve/deny tool use)
 */
export interface PermissionResponseMessage {
  type: 'permission_response';
  request_id: string;
  chat_id: string;
  approved: boolean;
}

/**
 * Answer user questions (response to AskUserQuestion tool)
 */
export interface AnswerUserQuestionMessage {
  type: 'answer_user_question';
  request_id: string;
  chat_id: string;
  answers: Record<string, string[]>; // Question index (as string) -> selected option labels or ["Other: custom text"]
}

/**
 * Request browser resize via CDP
 */
export interface BrowserResizeMessage {
  type: 'runtime:browser_resize';
  sessionId: string;
  width: number;
  height: number;
}

/**
 * Union type for all outgoing messages
 */
export type OutgoingMessage =
  | UserMessage
  | SyncChatMessage
  | ClaudeCodeInterruptMessage
  | SubmitSecretsMessage
  | SecretsCancelledMessage
  | PermissionResponseMessage
  | AnswerUserQuestionMessage
  | BrowserResizeMessage;

/**
 * ============================================================================
 * INCOMING MESSAGES (Backend → Client)
 * ============================================================================
 */

/**
 * Streaming text chunk from Claude API
 */
export interface StreamChunkMessage {
  type: 'stream_chunk';
  chat_id?: string;
  content: string;
}

/**
 * Stream completed
 */
export interface StreamDoneMessage {
  type: 'stream_done';
  chat_id?: string;
}

/**
 * Tool use notification
 */
export interface ToolUseMessage {
  type: 'tool_use';
  chat_id?: string;
  tool: string;
}

/**
 * Navigate to a different page with preloaded data
 */
export interface NavigateMessage {
  type: 'navigate';
  chat_id?: string;
  path: string;
  tab?: string;
  filters?: any;
  preloadedData?: any;
}

/**
 * Claude Code session started
 */
export interface ClaudeCodeStartMessage {
  type: 'claude_code_start';
  chat_id: string;
  tool_use_id: string;
  repo_path: string;
  task: string;
}

/**
 * Claude Code streaming output
 */
export interface ClaudeCodeStreamMessage {
  type: 'claude_code_stream';
  chat_id: string;
  blocks: ClaudeCodeBlock[];
  isPostCompression?: boolean; // Flag to indicate this message comes after context compression
}

/**
 * Claude Code individual block (for Redis buffering)
 */
export interface ClaudeCodeBlockMessage {
  type: 'claude_code_block';
  chat_id: string;
  block: ClaudeCodeBlock;
}

/**
 * Chat status update
 */
export interface ChatStatusUpdateMessage {
  type: 'chat_status_update';
  chat_id: string;
  status: ChatStatus;
}

/**
 * Claude Code session interrupted
 */
export interface ClaudeCodeInterruptedMessage {
  type: 'claude_code_interrupted';
  chat_id: string;
}

/**
 * Claude Code error
 */
export interface ClaudeCodeErrorMessage {
  type: 'claude_code_error';
  chat_id: string;
  error: string;
}

/**
 * Resume Claude Code session
 */
export interface ResumeClaudeCodeMessage {
  type: 'resume_claude_code';
  chat_id: string;
  message: string;
}

/**
 * Generic error message
 */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/**
 * Acknowledgement message
 */
export interface AckMessage {
  type: 'ack';
}

/**
 * Chat sync response with messages
 */
export interface ChatSyncResponseMessage {
  type: 'chat_sync_response';
  chat_id: string;
  messages: ChatMessage[];
  has_more: boolean;
  total_count: number;
  offset?: number;
  status?: ChatStatus;
}

/**
 * Secrets submitted confirmation
 */
export interface SecretsSubmittedMessage {
  type: 'secrets_submitted';
  chat_id: string;
  file_path: string;
  keys_set?: string[];
}

/**
 * Secrets cancelled confirmation
 */
export interface SecretsCancelledAckMessage {
  type: 'secrets_cancelled_ack';
  chat_id: string;
}

/**
 * Request user secrets (triggered by tool)
 */
export interface RequestUserSecretsMessage {
  type: 'request_user_secrets';
  chat_id: string;
  file_path: string;
  keys: string[];
  descriptions: Record<string, string>;
}

/**
 * Request permission from user (canUseTool callback)
 */
export interface RequestPermissionMessage {
  type: 'request_permission';
  chat_id: string;
  request_id: string;
  tool_name: string;
  tool_input: any;
}

/**
 * Request user answers to questions (AskUserQuestion tool)
 * @deprecated Legacy permission-based approach
 */
export interface RequestUserAnswersMessage {
  type: 'request_user_answers';
  chat_id: string;
  request_id: string;
  questions: any[]; // AskUserQuestion[] from chat types
}

/**
 * Ask user questions via custom MCP tool (new approach)
 * This is sent when the custom mcp__user__ask_user tool fires
 */
export interface AskUserQuestionMessage {
  type: 'ask_user_question';
  chat_id: string;
  request_id: string;
  questions: any[]; // AskUserQuestion[] from chat types
}

/**
 * Union type for all incoming messages
 */
export type IncomingMessage =
  | StreamChunkMessage
  | StreamDoneMessage
  | ToolUseMessage
  | NavigateMessage
  | ClaudeCodeStartMessage
  | ClaudeCodeStreamMessage
  | ClaudeCodeBlockMessage
  | ChatStatusUpdateMessage
  | ClaudeCodeInterruptedMessage
  | ClaudeCodeErrorMessage
  | ResumeClaudeCodeMessage
  | ErrorMessage
  | AckMessage
  | ChatSyncResponseMessage
  | SecretsSubmittedMessage
  | SecretsCancelledAckMessage
  | RequestUserSecretsMessage
  | RequestPermissionMessage
  | RequestUserAnswersMessage
  | AskUserQuestionMessage;

/**
 * Generic WebSocket message wrapper
 */
export interface WebSocketMessage<T = any> {
  type: string;
  chat_id?: string;
  content?: string;
  userToken?: string;
  pageContext?: PageContext;
  data?: T;
}

/**
 * ============================================================================
 * SOCKET.IO SPECIFIC TYPES
 * ============================================================================
 */

/**
 * Socket.IO chat join response
 */
export interface SocketIOChatJoinResponse {
  success: boolean;
  messages?: BufferedMessage[];
  status: ChatStatus; // Required - backend always checks runtime state (running, completed, error, idle)
  title?: string;
  hasMore?: boolean;
  totalCount?: number;
  lastReadMessageId?: number; // ID of the last message marked as read
  permissions?: string | null; // Permission mode for this chat (default, plan, accept_edits, bypass_permissions)
  error?: string;
}

/**
 * Socket.IO message response
 */
export interface SocketIOMessageResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Socket.IO load more response
 */
export interface SocketIOLoadMoreResponse {
  success: boolean;
  messages?: BufferedMessage[];
  hasMore?: boolean;
  error?: string;
}

/**
 * User joined room event (broadcast to all user's devices)
 */
export interface UserJoinedRoomEvent {
  chatId: string;
  socketId: string;
  timestamp: number;
}

/**
 * User left room event
 */
export interface UserLeftRoomEvent {
  chatId: string;
  socketId: string;
  timestamp: number;
}
