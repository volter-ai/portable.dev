/**
 * @vgit2/shared/types - Shared TypeScript types
 *
 * This package provides all shared types used across the Portable monorepo.
 * All types are defined once here to ensure consistency between the client and backend.
 *
 * Usage:
 *   import { Chat, ChatMessage, UserMessage } from '@vgit2/shared/types'
 */

// ============================================================================
// COMMON TYPES
// ============================================================================
export type {
  PageContext,
  SessionData,
  UserInfo,
  ClaudeSession,
  BufferedMessage,
  RepositoryInfo,
  CloneOptions,
  ApiError,
  ApiResponse,
  Secret,
  UserSecret, // @deprecated - use Secret instead
  AllowedUser,
} from './common.js';

// ============================================================================
// CHAT TYPES
// ============================================================================
export type {
  ChatStatus,
  ChatType,
  ChatCategory,
  MessageRole,
  RegenerationRequest,
  ContentBlockType,
  ContentBlock,
  UploadedFile,
  ChatMessage,
  Chat,
  StoredChat,
  ChatListItem,
  ClaudeCodeBlock,
  MessageAction,
  BackgroundImageConfig,
  BackgroundImageMapping,
  BackgroundTag,
  AskUserQuestionOption,
  AskUserQuestion,
  AskUserQuestionData,
  QuickActionDisplay,
  CustomMessageDisplay,
  PlainMessageDisplay,
  CustomDisplay,
} from './chat.js';

// Export type guards as functions
export {
  isQuickActionDisplay,
  isCustomMessageDisplay,
  isPlainMessageDisplay,
  hasCustomDisplay,
} from './chat.js';

// ============================================================================
// AGENT SETUP TYPES
// ============================================================================
export type { SubAgentDefinition, AgentSetup } from './agentSetup.js';

// ============================================================================
// EMAIL TYPES
// ============================================================================
export type {
  WelcomeEmailData,
  RejectionEmailData,
  EmailData,
  EmailType,
  EmailSendResponse,
} from './email.js';

// ============================================================================
// WEBSOCKET TYPES
// ============================================================================
export type {
  // Outgoing messages
  UserMessage,
  SyncChatMessage,
  ClaudeCodeInterruptMessage,
  SubmitSecretsMessage,
  SecretsCancelledMessage,
  OutgoingMessage,

  // Incoming messages
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

  // Generic
  WebSocketMessage,

  // Socket.IO specific
  SocketIOChatJoinResponse,
  SocketIOMessageResponse,
  SocketIOLoadMoreResponse,
  UserJoinedRoomEvent,
  UserLeftRoomEvent,
} from './websocket.js';

// ============================================================================
// AUTH TYPES
// ============================================================================
export type {
  GitHubScope,
  ScopeCheckResult,
  CheckScopesRequest,
  CheckScopesResponse,
  TokenUpdateMessage,
} from './auth.js';
export { REQUIRED_SCOPES } from './auth.js';

// ============================================================================
// CONNECTION TYPES
// ============================================================================
export type {
  ServiceConnection,
  StoredServiceConnection,
  FormField,
  OAuthConfig,
  ServiceConfig,
  ServiceCategory,
  ConnectServiceRequest,
  ConnectServiceResponse,
  DisconnectServiceRequest,
  DisconnectServiceResponse,
  ListConnectionsResponse,
  ConnectionStatusResponse,
  CodeExecutorInput,
  CodeExecutorResult,
  SlackCredentials,
  LinearCredentials,
  NotionCredentials,
  GoogleDriveCredentials,
  GmailCredentials,
  AwsCredentials,
  KubectlCredentials,
  DockerCredentials,
  GcloudCredentials,
  FlyioCredentials,
  ModalCredentials,
  ApifyCredentials,
  GitHubAppCredentials,
  ConnectionAccountInfo,
  CredentialsWithAccountInfo,
  ConnectionNameValidation,
  RenameConnectionRequest,
  RenameConnectionResponse,
  // Database adapter options types
  ConnectionBaseOptions,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from './connections.js';
export {
  MissingConnectionsError,
  validateConnectionName,
  deriveConnectionId,
  getDefaultConnectionName,
  getNumberedConnectionName,
  suggestConnectionNames,
  SERVICE_CATEGORIES,
  getServiceFavicon,
} from './connections.js';

// ============================================================================
// GITHUB TYPES
// ============================================================================
export type {
  GitHubUser,
  GitHubUserProfile,
  Organization,
  Repository,
  LocalRepository,
  RepositoryWithLocal,
  GitStatus,
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
} from './github.js';

// ============================================================================
// API TYPES
// ============================================================================
export type {
  // Authentication
  User,
  GetUserResponse,
  GetUserProfileResponse,
  GetUserOrganizationsResponse,

  // Chats
  GetChatsResponse,
  CreateChatResponse,
  GetChatMessagesResponse,
  SendChatMessageResponse,
  GetChatStatusResponse,
  SlashCommandInfo,
  GetChatCommandsResponse,
  SummarizeChatResponse,
  GenerateProjectNameResponse,
  AnalyzeIntentResponse,

  // Projects
  GetRecentProjectsResponse,
  CreateProjectResponse,
  CreateLocalFolderResponse,
  GetTaskOutputResponse,

  // File uploads
  UploadFileRequest,
  UploadFileResponse,
  TranscribeAudioRequest,
  TranscribeAudioResponse,
  GetFileHistoryResponse,
  GetGenerationsResponse,
  TrackRepoViewResponse,
  RescanReposResponse,

  // GitHub API
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
  QuickAction,
  GetQuickActionsResponse,

  // Git local operations
  CloneRepoRequest,
  CloneRepoResponse,

  // Internal API (container communication)
  InternalClaudeStartRequest,

  // Secrets
  GetUserSecretsResponse,
  CreateUserSecretRequest,
  CreateUserSecretResponse,
  CreateSecretFromEnvRequest,
  CreateSecretFromEnvResponse,
  UpdateUserSecretRequest,
  UpdateUserSecretResponse,
  DeleteUserSecretResponse,

  // Secrets Vault
  GetSavedSecretsResponse,
  GetSavedSecretResponse,
  SaveSecretResponse,
  DeleteSavedSecretResponse,
  SearchVaultResponse,

  // Suggestions
  SuggestionRepo,
  Suggestion,
  GetSuggestionsRequest,
  GetSuggestionsResponse,

  // Agent Setups
  GetAgentSetupsResponse,

  // MCPs
  GetMcpsAvailableResponse,

  // Config
  GetConfigResponse,
  GetDevInfoResponse,

  // Inject Secrets
  InjectSecretsResponse,

  // Git Credentials
  UpdateGitCredentialsResponse,

  // Theme
  GetUserThemeResponse,
  SaveUserThemeResponse,

  // Connections
  GetConnectionsResponse,
  GetServicesResponse,
  GetConnectionResponse,
  CompleteOAuthResponse,
  CreateConnectionResponse,
  RenameConnectionApiResponse,
  GetConnectionAccountInfoResponse,
  GetGitHubAppInstallationsResponse,
  DeleteConnectionResponse,
  ToggleConnectionActiveResponse,
  GetFlyioAuthUrlResponse,
  CompleteFlyioAuthResponse,

  // Version endpoints
  MinVersionResponse,

  // Error responses
  ErrorResponse,
  UnauthorizedResponse,
  ForbiddenResponse,
  NotFoundResponse,
  InternalServerErrorResponse,

  // Audio transcription
  TranscribeResponse,

  // Voice dictation phrases (on-device biasing vocabulary)
  VoicePhrasesResponse,

  // Chat settings
  GetChatSettingsResponse,
} from './api.js';

// ============================================================================
// VIBEWAITING (GAME SYSTEM) TYPES
// ============================================================================
export type {
  LeaderboardEntry,
  LeaderboardResponse,
  SubmitScoreRequest,
  SubmitScoreResponse,
  GetLeaderboardRequest,
  GetLeaderboardResponse,
  GetUserScoreRequest,
  GetUserScoreResponse,
  TrackPlayRequest,
  TrackPlayResponse,
  RateGameRequest,
  RateGameResponse,
  GetGameStatsRequest,
  GameStats,
  GetGameStatsResponse,
} from './vibewaiting.js';

// Re-export game registry types for convenience
export type { LeaderboardGameId } from '../gameRegistry';

// ============================================================================
// SERVICE ACCOUNT TYPES
// ============================================================================
export type {
  ExpirationPreset,
  AuditAction,
  ServiceAccount,
  ServiceAccountWithToken,
  AuditLogEntry,
  CreateServiceAccountRequest,
  UpdateServiceAccountRequest,
  GetAuditLogsRequest,
  CreateServiceAccountResponse,
  ListServiceAccountsResponse,
  GetServiceAccountResponse,
  UpdateServiceAccountResponse,
  RotateTokenResponse,
  GetAuditLogsResponse,
  RateLimitInfo,
  RateLimitError,
  ServiceAccountError,
  UsageStatistics,
} from './serviceAccounts.js';

// ============================================================================
// USER SETTINGS TYPES
// ============================================================================
export type {
  OnboardingSettings,
  UserSettings,
  UserThemeRow,
  SaveUserSettingsRequest,
  SaveUserSettingsResponse,
  GetUserSettingsResponse,
} from './userSettings.js';

// ============================================================================
// THEME TYPES
// ============================================================================
export type {
  Brightness,
  Accent,
  BackgroundImageConfig as ThemeBackgroundImageConfig,
  ThemeOptions,
} from './theme.js';
export { DEFAULT_THEME_OPTIONS } from './theme.js';

// ============================================================================
// AI MEDIA TYPES
// ============================================================================
export type {
  GenerationType,
  Generation,
  VersionInfo,
  GenerationFilters,
  GenerationsDatabase,
} from './generations.js';

// ============================================================================
// RUNTIME TYPES
// ============================================================================
export type {
  TunnelData,
  TunnelRepairResult,
  ProcessData,
  RuntimeResource,
  RuntimeView,
  RuntimeMode,
  SandboxMetrics,
  ClaudeSessionStatus,
  RuntimeClaudeSessionPayload,
} from './runtime.js';

// ============================================================================
// ERROR TYPES
// ============================================================================
export type {
  ErrorContext,
  StructuredErrorResponse,
  FormattedError,
  GitHubTokenExpiredError,
} from './errors.js';

// ============================================================================
// STORAGE TYPES
// ============================================================================
export type {
  StorageEntry,
  StorageListResponse,
  StorageUsageResponse,
  StorageDeleteResponse,
  StorageBulkDeleteResponse,
} from './storage.js';

// ============================================================================
// CLERK SECRETS TYPES
// ============================================================================
export type {
  EncryptedCredential,
  ClerkConnectionSecret,
  ClerkSecretsMetadata,
  StoreConnectionSecretRequest,
  StoreConnectionSecretResponse,
  GetConnectionSecretRequest,
  GetConnectionSecretResponse,
  DeleteConnectionSecretRequest,
  DeleteConnectionSecretResponse,
  ListConnectionSecretsResponse,
  ClerkSecretsErrorResponse,
} from './clerkSecrets.js';
export { CLERK_SECRETS_SCHEMA_VERSION } from './clerkSecrets.js';

// ============================================================================
// DEVICE-TOKEN + QR-LINK HANDSHAKE TYPES (local-first per-request auth)
// ============================================================================
export type {
  DeviceTokenClaims,
  DeviceTokenRecord,
  MintedDeviceToken,
  QrLinkPayload,
} from './deviceToken.js';

// ============================================================================
// MOBILE REACT NATIVE GATEWAY ROUTE TYPES (/auth/mobile/react-native/*)
// ============================================================================
export type {
  MobileRnErrorResponse,
  MobileRnClerkExchangeRequest,
  MobileRnClerkExchangeResponse,
  MobileRnRefreshResponse,
  MobileRnScopeUpgradeUrlRequest,
  MobileRnScopeUpgradeUrlResponse,
  MobileRnSandboxStatusResponse,
  MobileRnSandboxTerminateResponse,
  MobileRnConfigResponse,
  MobileRnMeResponse,
  MobileRnDeleteAccountResponse,
  MobileRnUtmRequest,
  MobileRnUtmResponse,
  MobileRnFirstPcConnectionRequest,
  MobileRnFirstPcConnectionResponse,
  MobileRnAppleReviewerCredentialsResponse,
} from './mobileReactNative.js';

// ============================================================================
// PUSH NOTIFY WIRE TYPES (PC -> gateway notify relay)
// ============================================================================
export type { NotifyPayload, NotifyRequest, NotifyResult, NotifyResponse } from './push.js';
