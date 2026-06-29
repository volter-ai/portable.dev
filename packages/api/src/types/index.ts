/**
 * Backend-specific type definitions
 * Re-exports shared types and adds backend-only extensions
 */

import Anthropic from '@anthropic-ai/sdk';
import { Request } from 'express';
import { WebSocket } from 'ws';

// Re-export all shared types for convenience
export type {
  // Common types
  PageContext,
  SessionData,
  UserInfo,
  ClaudeSession,
  BufferedMessage,
  RepositoryInfo,
  CloneOptions,
  ApiError,
  ApiResponse,

  // Chat types
  ChatStatus,
  ChatType,
  MessageRole,
  ContentBlockType,
  ContentBlock,
  UploadedFile,
  ChatMessage,
  Chat,
  StoredChat,
  ChatListItem,
  ClaudeCodeBlock,

  // WebSocket types
  UserMessage,
  SyncChatMessage,
  ClaudeCodeInterruptMessage,
  SubmitSecretsMessage,
  SecretsCancelledMessage,
  OutgoingMessage,
  StreamChunkMessage,
  StreamDoneMessage,
  ToolUseMessage,
  NavigateMessage,
  ClaudeCodeStartMessage,
  ClaudeCodeStreamMessage,
  ChatStatusUpdateMessage,
  ClaudeCodeInterruptedMessage,
  ClaudeCodeErrorMessage,
  ResumeClaudeCodeMessage,
  ErrorMessage,
  AckMessage,
  ChatSyncResponseMessage,
  SecretsSubmittedMessage,
  SecretsCancelledAckMessage,
  RequestUserSecretsMessage,
  IncomingMessage,
  WebSocketMessage,

  // GitHub types
  GitHubUser,
  Repository,
  LocalRepository,
  RepositoryWithLocal,
  Branch,
  BranchWithDate,
  Issue,
  Label,
  Milestone,
  PullRequest,
  Commit,
  WorkflowRun,
  FileContent,
  TreeEntry,
  Tree,

  // API types
  GetUserResponse,
  GetChatsResponse,
  UploadFileRequest,
  UploadFileResponse,
  TranscribeAudioRequest,
  TranscribeAudioResponse,
  GetReposResponse,
  GetRepoResponse,
  GetTreeResponse,
  GetContentsResponse,
  GetBranchesResponse,
  GetIssuesRequest,
  GetIssuesResponse,
  GetIssueResponse,
  GetPullsRequest,
  GetPullsResponse,
  GetPullResponse,
  GetCommitsRequest,
  GetCommitsResponse,
  GetActionsRunsRequest,
  GetActionsRunsResponse,
  GetRecentBranchesResponse,
  CloneRepoRequest,
  CloneRepoResponse,
  ErrorResponse,
  UnauthorizedResponse,
  ForbiddenResponse,
  NotFoundResponse,
  InternalServerErrorResponse,
} from '@vgit2/shared/types';

// Extend Express Session with custom properties
// NOTE: All service tokens managed via ConnectionsService (database). Session only stores user identity + JWT.
declare module 'express-session' {
  interface SessionData {
    // User identity
    userEmail?: string;
    userId?: string;
    username?: string;
    onWaitlist?: boolean;

    // Backend-specific session data
    authToken?: string; // JWT auth token (decode to get tokens/user data)

    // Google OAuth tokens (kept in session for JWT generation)
    googleDriveToken?: string;
    googleRefreshToken?: string;

    // Temporary OAuth state (deleted immediately after OAuth callback completes)
    oauthState?: string;
    slackOauthState?: string;
    slackConnectionName?: string; // Temporary: Connection ID during Slack OAuth flow
    googleOauthState?: string;
    googleConnectionName?: string; // Temporary: Connection ID during Google OAuth flow
    googleService?: string; // Temporary: Service type during Google OAuth flow ('gmail' or 'google-drive')
    githubConnectionId?: string; // Temporary: Connection ID during GitHub OAuth flow (for named connections)
    returnTo?: string;
    upgradeScopes?: boolean;
    internal?: boolean;

    // Pending CLI authentication flows (SSO-style)
    pendingFlyioConnection?: {
      connectionId: string;
      timestamp: number;
    };

    // Pending OAuth credentials (stored temporarily until the client completes with displayName)
    pendingGoogleOAuth?: {
      credentials: {
        accessToken: string;
        refreshToken: string;
        email: string;
        name: string;
      };
      serviceType: string;
      timestamp: number;
    };
    pendingSlackOAuth?: {
      credentials: {
        token: string;
        teamId?: string;
        teamName?: string;
        userId?: string;
      };
      timestamp: number;
    };
    pendingGitHubOAuth?: {
      credentials: {
        token: string;
        username: string;
        email?: string;
        userId: number;
        avatarUrl?: string;
      };
      timestamp: number;
    };
  }
}

/**
 * Backend-specific types (not shared with the client)
 */

export interface AuthenticatedRequest extends Request {
  session: Request['session'];
}

export interface WebSocketConnection {
  ws: WebSocket;
  userId?: string;
  userEmail?: string;
  conversationHistories: Map<string, Anthropic.MessageParam[]>;
}
