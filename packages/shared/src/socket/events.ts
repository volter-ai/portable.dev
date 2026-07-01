/**
 * Transport-agnostic Socket.IO event catalog (single source of truth).
 *
 * The React Native (`packages/mobile`) client consumes these constants and
 * payload interfaces so the wire protocol stays consistent. Event-name string
 * literals are defined ONLY here — never inline at a call site — so client and
 * server can never drift.
 *
 * Authoritative server handlers: `packages/api/src/services/SocketIOService.ts`.
 */

import type { AskUserQuestion, CustomDisplay } from '../types/chat.js';
import type { PageContext } from '../types/common.js';
import type { ProcessData, RuntimeClaudeSessionPayload, TunnelData } from '../types/runtime.js';

/**
 * Client → Server event names. The only place these literals are defined.
 */
export const CLIENT_EVENTS = {
  PING: 'ping',
  CHAT_CREATE: 'chat:create',
  CHAT_JOIN: 'chat:join',
  CHAT_MESSAGE: 'chat:message',
  CHAT_LOAD_MORE: 'chat:load_more',
  CHAT_MARK_READ: 'chat:mark_read',
  CHAT_UPDATE_SETTINGS: 'chat:update_settings',
  CHAT_KILL_SESSION: 'chat:kill-session',
  CLAUDE_INTERRUPT: 'claude:interrupt',
  PERMISSION_RESPOND: 'permission:respond',
  ANSWER_USER_QUESTION: 'answer_user_question',
  SECRETS_SUBMIT: 'secrets:submit',
  SECRETS_CANCEL: 'secrets:cancel',
} as const;

/**
 * Server → Client event names the clients subscribe to.
 */
export const SERVER_EVENTS = {
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  CONNECT_ERROR: 'connect_error',
  SESSION_EXPIRED: 'session:expired',
  SYSTEM_SHUTDOWN_WARNING: 'system:shutdown_warning',
  SYSTEM_IDLE_WARNING: 'system:idle_warning',
  SYSTEM_IDLE_WARNING_CLEARED: 'system:idle_warning_cleared',
  SYSTEM_IDLE_SHUTDOWN: 'system:idle_shutdown',
  CHAT_CREATED: 'chat:created',
  /** Fork-on-first-write: a CC chat was forked into a new Portable chat; client navigates. */
  CHAT_FORKED: 'chat:forked',
  CHAT_NEW_MESSAGE: 'chat:new_message',
  CHAT_SUMMARY_UPDATED: 'chat:summary_updated',
  CHAT_READ_UPDATED: 'chat:read_updated',
  CHAT_LINKED_ISSUE_UPDATED: 'chat:linkedIssueUpdated',
  CHAT_SETTINGS_UPDATED: 'chat:settings_updated',
  CLAUDE_PROCESSING: 'claude:processing',
  CLAUDE_STATUS: 'claude:status',
  CLAUDE_STREAM: 'claude:stream',
  CLAUDE_INTERRUPTED: 'claude:interrupted',
  CLAUDE_ERROR: 'claude:error',
  CONTAINER_STATUS: 'container:status',
  TOOL_PERMISSION_REQUIRED: 'tool_permission_required',
  ASK_USER_QUESTION: 'ask_user_question',
  USER_MESSAGE: 'user_message',
  SECRETS_SUBMITTED: 'secrets:submitted',
  USER_RUNTIME_STATE: 'user:runtime_state',
  SANDBOX_METRICS: 'sandbox:metrics',
  SESSION_REAPED: 'session:reaped',
} as const;

export type ClientEventName = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];
export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

/**
 * ============================================================================
 * Client → Server payload shapes (exactly what the clients emit on the wire)
 * ============================================================================
 */

/** `chat:create` */
export interface ChatCreatePayload {
  chatId: string;
  type: 'claude_code';
  title: string;
  owner: string;
  repo: string;
  model?: string;
  permissions?: string;
  agentSetupId?: string;
}

/** `chat:join` — `count` (recent N) and `limit`/`offset` (paged) are alternatives. */
export interface ChatJoinPayload {
  chatId: string;
  count?: number;
  limit?: number;
  offset?: number;
}

/** `chat:message` */
export interface ChatMessagePayload {
  chatId: string;
  messageId?: string;
  content: string;
  files?: unknown[];
  context?: PageContext;
  model?: string;
  permissions?: string;
  agentSetupId?: string;
  effort?: string;
  aiStyle?: string;
  customAiStylePrompt?: string;
  customDisplay?: CustomDisplay;
}

/** `chat:load_more` */
export interface ChatLoadMorePayload {
  chatId: string;
  afterId: number;
  limit?: number;
}

/** `chat:mark_read` */
export interface ChatMarkReadPayload {
  chatId: string;
  messageId: number;
}

/** `chat:update_settings` */
export interface ChatUpdateSettingsPayload {
  chatId: string;
  settings: { model?: string; permissions?: string; effort?: string };
}

/** `claude:interrupt` */
export interface ClaudeInterruptPayload {
  chatId: string;
}

/**
 * `chat:kill-session` — user-initiated termination of a chat's Claude session.
 * Gracefully aborts the in-flight SDK stream and frees the
 * subprocess; the `session_id` is preserved so the next message resumes
 * transparently. The server validates the chat belongs to the requesting user.
 */
export interface ChatKillSessionPayload {
  chatId: string;
}

/** `permission:respond` */
export interface PermissionRespondPayload {
  requestId: string;
  chatId: string;
  approved: boolean;
}

/** `answer_user_question` (snake_case on the wire, matching the server handler) */
export interface AnswerUserQuestionPayload {
  type?: 'answer_user_question';
  request_id: string;
  chat_id: string;
  /** Question index (as string) → selected option labels (or `["Other: ..."]`). */
  answers: Record<string, string[]>;
}

/** `secrets:submit` */
export interface SecretsSubmitPayload {
  chatId: string;
  secrets: Record<string, string>;
}

/** `secrets:cancel` */
export interface SecretsCancelPayload {
  chatId: string;
}

/**
 * ============================================================================
 * Server → Client `system:*` payload shapes (lifecycle warnings)
 * ============================================================================
 *
 * Emitted by the server before the sandbox is torn down. Both the web
 * (`SocketIOContext`) and React Native clients render these as warnings; the RN
 * client renders them as native modals/banners (never `window.location.href`).
 */

/** `system:shutdown_warning` — pending shutdown; user must act to restart. */
export interface SystemShutdownWarningPayload {
  message: string;
  /** Gateway URL the web client redirects to after restart (RN does NOT redirect). */
  redirect_url: string;
}

/** `system:idle_warning` — idle timer entered the warning window. */
export interface SystemIdleWarningPayload {
  message: string;
  /** Seconds remaining before idle shutdown. */
  timeRemaining: number;
}

/** `system:idle_shutdown` — final notice; shutdown is imminent. */
export interface SystemIdleShutdownPayload {
  message: string;
}

/**
 * `session:expired` — the server disconnected this socket for inactivity (the
 * sandbox session is gone). Clients route to a re-provision / loading state.
 */
export interface SessionExpiredPayload {
  reason?: string;
}

/**
 * ============================================================================
 * Server → Client interaction payload shapes (permission / ask-user / secrets)
 * ============================================================================
 *
 * The three interactive prompts that pause a Claude run for user input. Both the
 * web (`SocketIOContext`) and React Native (`useNativeSocket`) clients fold these
 * into their per-chat state and respond via `permission:respond` /
 * `answer_user_question` / `secrets:submit`. Defined here so the wire shapes the
 * two clients read can never drift (snake_case fields mirror the server handlers).
 */

/**
 * `tool_permission_required` — retroactively flags the most recent matching
 * `tool_use` block as awaiting an approve/deny decision.
 */
export interface ToolPermissionRequiredPayload {
  chat_id: string;
  request_id: string;
  tool_name: string;
  tool_input?: unknown;
}

/**
 * `ask_user_question` — the MCP `ask_user` tool needs the user to answer one or
 * more multiple-choice questions before the run can continue.
 */
export interface AskUserQuestionEventPayload {
  chat_id: string;
  request_id: string;
  /** Block id of the streamed `ask_user` tool_use (when the questions update one). */
  tool_use_id?: string;
  questions: AskUserQuestion[];
}

/** `secrets:submitted` — confirms the submitted secrets were stored server-side. */
export interface SecretsSubmittedPayload {
  chatId: string;
}

/**
 * ============================================================================
 * Server → Client `claude:*` streaming payload shapes
 * ============================================================================
 *
 * The live Claude run streams its output to the chat room as a sequence of
 * blocks (`claude:stream`), bracketed by processing/status signals and ended by
 * an interrupt or error event. Both the web (`SocketIOContext`) and React Native
 * (`useNativeSocket` → `chatMessagesStore`) clients fold these into the per-chat
 * message list. Defined here so the two clients can never drift.
 */

/**
 * A single streamed content block (the `block` field of `claude:stream`). A
 * superset of `ContentBlock` carrying the wire-only `parent_tool_use_id` used to
 * group sub-agent (Task) output under its spawning tool.
 */
export interface ClaudeStreamBlock {
  type: string;
  /** Unique block identifier for deduplication / tool_use ↔ tool_result matching. */
  id?: string;
  blockId?: string;
  toolName?: string;
  toolInput?: unknown;
  text?: string;
  content?: string;
  /**
   * Tool-use id of the `Task` tool that spawned this sub-agent block. Absent /
   * `null` for the main agent. Blocks sharing a non-null value render grouped.
   */
  parent_tool_use_id?: string | null;
  /** True for an errored `tool_result`. */
  is_error?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

/** `claude:stream` — one streamed block appended to the active assistant message. */
export interface ClaudeStreamPayload {
  chatId: string;
  block: ClaudeStreamBlock;
}

/** `claude:processing` — Claude began working on a chat (typing indicator on). */
export interface ClaudeProcessingPayload {
  chatId: string;
}

/** Unified `claude:status` lifecycle values (mirrors the web handler). */
export type ClaudeRunStatus = 'running' | 'completed' | 'idle' | 'error';

/** `claude:status` — unified status update (supersedes `claude:processing`). */
export interface ClaudeStatusPayload {
  chatId: string;
  status: ClaudeRunStatus | string;
  repoPath?: string;
  task?: string;
}

/** `claude:interrupted` — the user interrupted the run. */
export interface ClaudeInterruptedPayload {
  chatId: string;
}

/** `claude:error` — the run errored; `errorBlock` (when present) renders inline. */
export interface ClaudeErrorPayload {
  chatId: string;
  error: string;
  errorBlock?: ClaudeStreamBlock;
}

/**
 * `chat:forked` — fork-on-first-write. Portable claimed a Claude Code terminal
 * chat (`oldChatId`) into a brand-new Portable chat (`newChatId`) on the user's first
 * message, so the original CC transcript is never mutated. The client with `oldChatId`
 * open navigates to `newChatId`; the new chat is also announced via `chat:created`.
 */
export interface ChatForkedPayload {
  oldChatId: string;
  newChatId: string;
}

/**
 * `chat:summary_updated` — the AI-generated short summary of a chat changed.
 * Both clients fold it into the chat's summary panel.
 */
export interface ChatSummaryUpdatedPayload {
  chatId: string;
  summary: string;
}

/**
 * `container:status` — Docker workspace setup progress for a chat. `creating` /
 * `health_check` show an animated banner; `ready` is the terminal success.
 */
export interface ContainerStatusPayload {
  chatId: string;
  status: 'creating' | 'ready' | 'health_check' | string;
  message: string;
}

/**
 * `chat:linkedIssueUpdated` — the GitHub issue linked to a chat changed (the
 * backend `link_issue_to_chat` tool established or cleared the link). Both
 * clients fold it into the chat's linked-issue badge; `linkedIssue: null` is an
 * explicit unlink.
 */
export interface ChatLinkedIssueUpdatedPayload {
  chatId: string;
  linkedIssue: {
    owner: string;
    repo: string;
    number: number;
  } | null;
}

/**
 * ============================================================================
 * Server → Client runtime payload shapes (RuntimeBox)
 * ============================================================================
 *
 * The PC runtime stream: a full snapshot of the user's active resources
 * (`user:runtime_state`, sent on connect + on every change) and the
 * high-frequency host metric channel (`sandbox:metrics` carries `SandboxMetrics`
 * — from `types/runtime`). The React Native client
 * (`useNativeSocket` → `runtimeStore`) folds these into its runtime state.
 */

/**
 * `user:runtime_state` — full snapshot of the user's active runtime resources.
 * The server sends ALL active resources every time (no deltas), so each array
 * REPLACES the prior one.
 */
export interface UserRuntimeStatePayload {
  tunnels?: TunnelData[];
  backgroundProcesses?: ProcessData[];
  /** Live Claude sessions holding a subprocess. */
  claudeSessions?: RuntimeClaudeSessionPayload[];
  /** Idle TTL after which a session is auto-reaped (ms) — shown in the panel. */
  claudeSessionIdleTtlMs?: number;
}

/**
 * `session:reaped` — the idle reaper (or memory watchdog) terminated a chat's
 * Claude session. The subprocess is freed but `session_id` is
 * preserved, so a future message resumes transparently. Clients update the
 * runtime panel; a fresh `user:runtime_state` snapshot follows.
 */
export interface SessionReapedPayload {
  chatId: string;
  reason: 'idle' | 'manual' | 'memory';
  /** Idle duration that triggered the reap (ms), when reason is `idle`. */
  idleMs?: number;
  timestamp: number;
}

/**
 * ============================================================================
 * Ack (callback) response shapes
 * ============================================================================
 */

/** Generic ack shared by most emit helpers. */
export interface SocketAck {
  success: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
}
