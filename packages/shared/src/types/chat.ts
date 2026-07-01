/**
 * Chat-related types shared across the client and backend
 * These types define the structure of chats, messages, and related entities
 */

/**
 * Chat status enum
 */
export type ChatStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'idle'
  | 'interrupting'
  | 'compressing';

/**
 * Chat type enum
 */
export type ChatType = 'claude_code';

/**
 * Chat category — the mutually-exclusive bucket a chat lives in.
 * - `active`: the default working list (not saved, not archived)
 * - `saved`: kept for later ("I'll come back to this") — hidden from active, but
 *   distinct from archive (not done/throwaway)
 * - `archived`: done/parked
 * Pin (see `Chat.pinned`) is ORTHOGONAL to this — a chat in any category can be pinned.
 */
export type ChatCategory = 'active' | 'saved' | 'archived';

/**
 * Message role enum
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Requested secret structure for environment variable requests
 */
export interface RequestedSecret {
  key: string;
  description?: string;
}

/**
 * Regeneration request metadata (user-created request for AI to regenerate with specific params)
 * Client: Renders as collapsed params block
 * Claude sees: Text message requesting tool call with exact parameters
 */
export interface RegenerationRequest {
  type: 'image' | 'video';
  toolName: string;
  model: string;
  input: Record<string, any>;
}

/**
 * Content block type for structured messages
 */
export type ContentBlockType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'image'
  | 'video'
  | 'actions'
  | 'ask_user_question'
  | 'error';

/**
 * Content block structure
 * Used for Claude API responses with tools, images, videos
 */
export interface ContentBlock {
  type: ContentBlockType;
  blockId?: string; // Unique block identifier for deduplication and references
  text?: string;
  content?: string;
  toolName?: string;
  name?: string;
  toolInput?: any;
  input?: any;
  id?: string;
  source?:
    | {
        type?: string;
        media_type?: string;
        data?: string;
      }
    | string;
  // Permission fields (for tool_use blocks that need approval)
  needsPermission?: boolean;
  permissionRequestId?: string;
  permissionApproved?: boolean; // Set after user responds
  // Actions field (for actions block)
  actions?: MessageAction[];
  sourceBlockId?: string; // For actions blocks: the text block these actions were extracted from
  // Sub-agent fields (for messages from specialized agents)
  agentName?: string; // Display name like "GitHub Specialist"
  agentType?: string; // Type identifier like "github-specialist"
  isSubAgent?: boolean; // true if from sub-agent
  // AskUserQuestion field (for ask_user_question blocks)
  askUserQuestionData?: AskUserQuestionData;
  // Error field (for tool_result blocks)
  is_error?: boolean;
  // Error block fields (for error blocks - prettier error display)
  title?: string;
  message?: string;
  action?: string;
  details?: string;
  code?: string;
  timestamp?: number;
}

/**
 * Uploaded file structure
 * Used for file attachments in messages
 */
export interface UploadedFile {
  fileName: string;
  originalName: string;
  path: string; // HTTP path for serving the file (e.g., /api/uploads/filename.jpg)
  absolutePath: string; // Absolute file system path with file:// protocol for AI access
  mimeType: string;
  size: number;
}

/**
 * Base custom display configuration
 * Allows messages to have alternate UI representations
 */
type CustomDisplayBase = {
  /** Category identifier for discriminated union */
  category: string;
};

/**
 * Quick Action Display - Shows as a pill/chip instead of message text
 * User sees: Pill UI with action label
 * AI sees: Full message content in history
 */
export interface QuickActionDisplay extends CustomDisplayBase {
  category: 'quickAction';
  /** Action that was executed (for pill rendering) */
  action: {
    id: string;
    label: string;
    labelBold?: string;
    icon?: string;
    type: 'message' | 'runtime';
  };
  /** Optional: What was sent to AI (if different from display) */
  actualPrompt?: string;
}

/**
 * Custom Message Display - Shows simplified text to user
 * User sees: displayText
 * AI sees: content field (full message with context)
 */
export interface CustomMessageDisplay extends CustomDisplayBase {
  category: 'message';
  /** Simplified text shown to user */
  displayText: string;
  /** Optional: Icon to show with message */
  icon?: string;
  /** Optional: Color/style hint */
  variant?: 'info' | 'success' | 'warning' | 'error';
}

/**
 * Plain Message Display - Shows plain text without styling
 * User sees: displayText rendered as regular markdown
 * AI sees: content field (full message with context)
 * Used for project creation messages where user description is shown instead of full prompt
 */
export interface PlainMessageDisplay extends CustomDisplayBase {
  category: 'plainMessage';
  /** Text shown to user (supports markdown) */
  displayText: string;
}

/**
 * Union type for all custom display categories
 * Extensible - add new categories by adding union members
 */
export type CustomDisplay = QuickActionDisplay | CustomMessageDisplay | PlainMessageDisplay;

/**
 * Type guards for custom display categories
 */
export function isQuickActionDisplay(display: CustomDisplay): display is QuickActionDisplay {
  return display.category === 'quickAction';
}

export function isCustomMessageDisplay(display: CustomDisplay): display is CustomMessageDisplay {
  return display.category === 'message';
}

export function isPlainMessageDisplay(display: CustomDisplay): display is PlainMessageDisplay {
  return display.category === 'plainMessage';
}

/**
 * Helper to check if message has custom display
 */
export function hasCustomDisplay(
  message: ChatMessage
): message is ChatMessage & { customDisplay: CustomDisplay } {
  return message.customDisplay !== undefined;
}

/**
 * Chat message structure
 * Used in the client and for message sync responses
 */
export interface ChatMessage {
  id?: string; // Unique ID for deduplication (generated client-side or from backend)
  role: MessageRole;
  content: string | ContentBlock[];
  timestamp?: number;
  uploadedFiles?: UploadedFile[];
  autofill?: boolean; // True if message was auto-generated (e.g., secrets submission)
  audioUrl?: string;
  claudeCodeSession?: any;
  linkedChatId?: string;
  blocks?: ContentBlock[];
  // Regeneration request (user asks Claude to regenerate with specific params)
  regenerationRequest?: RegenerationRequest;
  isPostCompression?: boolean; // True if this message comes after context compression
  // Sub-agent fields (for messages from specialized agents)
  agentName?: string; // Display name like "GitHub Specialist"
  agentType?: string; // Type identifier like "github-specialist"
  isSubAgent?: boolean; // true if from sub-agent
  parentMessageId?: string; // ID of parent message that invoked this agent
  parent_tool_use_id?: string | null; // Tool use ID that invoked the sub-agent
  // Agent setup tracking (which agent orchestration style was active)
  agentSetupId?: string; // Agent setup ID active when message was created (e.g., 'best-practice', 'freestyle')
  /**
   * Custom display configuration
   * When present, overrides default message rendering
   * - User sees the custom display
   * - AI sees the actual message content
   */
  customDisplay?: CustomDisplay;
}

/**
 * Main chat interface
 * Used in the client for active chats and in API responses
 */
export interface Chat {
  id: string;
  type: ChatType;
  title: string;
  summary?: string; // AI-generated summary of the chat's purpose (5-10 words)
  messages: ChatMessage[];
  status?: ChatStatus;
  hidden?: boolean;
  archived?: boolean;
  saved?: boolean; // "Saved" category — kept for later, hidden from the active list (mutually exclusive with archived)
  pinned?: boolean; // Pinned — highlighted + floated to the top of lists (orthogonal to the category)
  lastUpdated?: number; // Timestamp in milliseconds
  repo_path?: string; // Repository path for claude_code chats
  hasMore?: boolean; // Whether there are more messages to load
  totalCount?: number; // Total message count in backend
  isJoined?: boolean; // Whether the client is currently in this chat's Socket.IO room
  playwrightDevice?: 'mobile' | 'desktop'; // Device mode for Playwright browser automation
  model?: string; // Model used for this chat (sonnet, haiku)
  permissions?: string; // Permission mode for this chat (default, plan, accept_edits, bypass_permissions)
  lastReadMessageId?: number; // ID of the last message marked as read by the user
  containerStatus?: {
    status: 'creating' | 'ready' | 'health_check'; // Container setup status
    message: string; // Human-readable status message
  };
  // NOTE: runtimeState removed - now managed at user level in SocketIOContext
  // See UserRuntimeState in SocketIOContext.tsx for tunnels
  linkedIssue?: {
    owner: string; // Repository owner
    repo: string; // Repository name
    number: number; // Issue number
  }; // GitHub issue identifier linked to this chat (fetch fresh details when needed)
  parentChatId?: string; // ID of parent chat (if this chat was derived from another)
  agentSetupId?: string; // Agent setup ID ('best-practice', 'freestyle', etc.)
  routineId?: string; // Routine ID if this chat was created by an automated routine
  // Message previews (computed on backend, updated via Socket.IO)
  firstMessagePreview?: string; // Preview of the first user message (for directory display)
  lastMessagePreview?: string; // Preview of the last message (for directory display)
  // UI-only state (not persisted to database)
  draft?: string; // Unsent text in the chat input field
}

/**
 * Stored chat structure (database format)
 * Uses snake_case for consistency with database columns
 */
export interface StoredChat {
  id: string;
  user_id: string;
  type: ChatType;
  title: string;
  summary?: string | null; // AI-generated summary of the chat's purpose (5-10 words)
  status?: ChatStatus | null;
  hidden: number; // SQLite boolean (0 or 1)
  archived: number; // SQLite boolean (0 or 1)
  saved: number; // SQLite boolean (0 or 1) — "Saved" category (mutually exclusive with archived)
  pinned: number; // SQLite boolean (0 or 1) — pinned to the top of lists
  last_updated: number;
  repo_path?: string | null;
  session_id?: string | null;
  /**
   * Original Claude Code session id this chat was forked from (fork-on-first-write).
   * Set when Portable claims a discovered terminal transcript; null for every normal chat.
   * Internal/backend use — drives the fork-vs-resume decision in `startNewSession`.
   */
  fork_source_session_id?: string | null;
  system_prompt?: string | null;
  playwright_device?: string | null; // 'mobile' | 'desktop' - Playwright browser device mode
  model?: string | null; // Model used for this chat (sonnet, haiku)
  permissions?: string | null; // Permission mode for this chat (default, plan, accept_edits, bypass_permissions)
  effort?: string | null; // Reasoning effort level for this chat (low, medium, high, xhigh, max)
  last_read_message_id: number | null; // ID of the last message marked as read
  linked_issue?: string | null; // JSON string of {owner, repo, number} for linked GitHub issue
  parent_chat_id?: string | null; // ID of parent chat (snake_case for DB)
  agent_setup_id?: string | null; // Agent setup ID ('best-practice', 'freestyle', etc.)
  routine_id: string | null; // Routine ID if this chat was created by an automated routine
  created_at: number;
}

/**
 * Chat list item (minimal info for chat directory)
 * Used in GET /api/chats response
 */
export interface ChatListItem {
  id: string;
  type: ChatType;
  title: string;
  summary?: string; // AI-generated summary of the chat's purpose (5-10 words)
  status?: ChatStatus;
  hidden?: boolean;
  archived?: boolean;
  saved?: boolean; // "Saved" category — hidden from the active list (mutually exclusive with archived)
  pinned?: boolean; // Pinned — highlighted + floated to the top of lists
  lastUpdated?: number;
  repo_path?: string;
  repoFullName?: string; // GitHub full_name (owner/repo) for the chat's repo, when known. Lets the client show the repo name without parsing the raw disk repo_path.
  lastReadMessageId?: number; // ID of the last message marked as read
  linkedIssue?: {
    owner: string; // Repository owner
    repo: string; // Repository name
    number: number; // Issue number
  }; // GitHub issue identifier linked to this chat
  parentChatId?: string; // ID of parent chat (if this chat was derived from another)
  routineId?: string; // Routine ID if this chat was created by an automated routine
  firstMessagePreview?: string; // Preview of the first user message (for directory display)
  lastMessagePreview?: string; // Preview of the last message (for directory display)
}

/**
 * Action button structure
 * Represents a suggested action extracted from assistant's last message
 */
export interface MessageAction {
  id: string; // Unique ID for the action
  label: string; // Display text for the button (e.g., "Continue refactoring")
  prompt: string; // Full prompt to send when clicked, or brief starter text for prefill_input
  icon?: string; // Optional icon name (e.g., "archive" for Font Awesome icons)
  type?: 'normal' | 'archive'; // Type of action (archive is special)
  actionType?: 'send_message' | 'prefill_input'; // How to handle the action: send immediately or prefill input for user to complete
}

/**
 * AskUserQuestion option structure
 * Represents a single choice in a question
 */
export interface AskUserQuestionOption {
  label: string; // Display text for the option (1-5 words)
  description: string; // Explanation of what this option means
}

/**
 * AskUserQuestion question structure
 * Represents a single question with options
 */
export interface AskUserQuestion {
  question: string; // The complete question text
  header: string; // Short label (max 12 chars) displayed as chip/tag
  options: AskUserQuestionOption[]; // 2-4 options
  multiSelect: boolean; // Allow multiple selections
}

/**
 * AskUserQuestion data structure
 * Used in ContentBlock for ask_user_question type
 */
export interface AskUserQuestionData {
  questions: AskUserQuestion[]; // 1-4 questions
  answers?: Record<string, string[]>; // Question index -> selected option labels (or "Other: custom text")
  requestId?: string; // Unique ID for tracking this question set
  answered?: boolean; // Whether user has answered
}

/**
 * Claude Code block structure
 * Used for streaming Claude Code responses
 */
export interface ClaudeCodeBlock {
  type: ContentBlockType;
  blockId?: string; // Unique block identifier for deduplication and references
  text?: string;
  content?: string;
  toolName?: string;
  name?: string;
  toolInput?: any;
  input?: any;
  id?: string;
  source?:
    | {
        type?: string;
        media_type?: string;
        data?: string;
      }
    | string;
  // Permission fields (for tool_use blocks that need approval)
  needsPermission?: boolean;
  permissionRequestId?: string;
  permissionApproved?: boolean;
  // Actions field (for actions block)
  actions?: MessageAction[];
  sourceBlockId?: string; // For actions blocks: the text block these actions were extracted from
  // Error field (for tool_result blocks)
  is_error?: boolean;
}

/**
 * Background tag type
 * Predefined section tags that map 1:1 to page sections
 * Tags are directly assigned to images (no separate mapping object)
 *
 * Priority rules:
 * 1. Most recently uploaded image with matching tag wins
 * 2. If no exact match, fall back to 'global' tag
 * 3. If no images have the tag, return undefined (no background)
 */
export type BackgroundTag =
  | 'global' // Global fallback
  | 'home' // HomePage
  | 'repos' // ReposPage
  | 'repo' // RepoPage + tabs
  | 'profile' // ProfilePage
  | 'chat' // Chat pages
  | 'runtime' // Runtime pages
  | 'bottomNav'; // Mobile bottom nav

/**
 * Background image configuration
 * Used for theme background customization (localStorage-based)
 *
 * Tag-based system: Each image has an array of tags (e.g., ['home', 'repos'])
 * When multiple images share the same tag, the most recent upload takes priority
 */
export interface BackgroundImageConfig {
  id: string; // Unique identifier for this background
  originalName: string; // User's original filename
  dataUrl: string; // Base64 data URL (data:image/png;base64,...) OR URL for system wallpapers
  uploadedAt: number; // Timestamp (used for priority resolution)
  opacity: number; // 0-1, default 0.1
  attachment: 'fixed' | 'scroll'; // CSS background-attachment
  size: 'cover' | 'contain' | 'auto'; // CSS background-size
  position: string; // CSS background-position (e.g., 'center', 'top left')
  tags: BackgroundTag[]; // Array of section tags this image applies to
  isSystem?: boolean; // True for system wallpapers (cannot be deleted)
}

/**
 * @deprecated Legacy background image mapping
 * Replaced by tag-based system (BackgroundImageConfig.tags)
 * Kept for migration purposes only
 *
 * Migration handled in ThemeContext on first load
 */
export interface BackgroundImageMapping {
  global?: string; // Global fallback background ID
  home?: string; // HomePage
  repos?: string; // ReposPage
  repo?: string; // RepoPage + all tabs
  profile?: string; // ProfilePage
  chat?: string; // Chat pages
  runtime?: string; // Runtime pages
  bottomNav?: string; // Mobile bottom navigation
}

/**
 * Recent project item for project dropdown
 * Used in GET /api/projects/recent response
 */
export interface RecentProject {
  name: string; // Project folder name (e.g., "my-blog")
  path: string; // Full repo path (e.g., "~/workspace/user/owner/repo")
  owner: string | null; // GitHub owner (e.g., "octocat")
  lastUpdated: number; // Timestamp in milliseconds
}
