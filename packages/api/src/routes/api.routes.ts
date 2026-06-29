import { Router } from 'express';

import { AuthService } from '../services/AuthService.js';
import { ChatService } from '../services/ChatService.js';
import { ConnectionsService } from '../services/ConnectionsService.js';
import { GitHubApiService } from '../services/GitHubApiService.js';
import { GitLocalService } from '../services/GitLocalService.js';
import { IntentAnalysisService } from '../services/IntentAnalysisService.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { SecretsService } from '../services/SecretsService.js';
import { SuggestionsService } from '../services/SuggestionsService.js';
import { ThemeService } from '../services/ThemeService.js';
import { TunnelService } from '../services/TunnelService.js';
import { UploadService } from '../services/UploadService.js';
import { VoicePhrasesService } from '../services/VoicePhrasesService.js';

// Import modular subroutes
import { createChatRoutes } from './subroutes/chat.routes.js';
import { createConnectionsRoutes } from './subroutes/connections.routes.js';
import { createDevRoutes } from './subroutes/dev.routes.js';
import { createHealthRoutes } from './subroutes/health.routes.js';
import { createMiscRoutes } from './subroutes/misc.routes.js';
import { createRepositoryRoutes } from './subroutes/repository.routes.js';
import { createSecretsRoutes } from './subroutes/secrets.routes.js';
import { createStorageRoutes } from './subroutes/storage.routes.js';
import { createUserRoutes } from './subroutes/user.routes.js';

import type { LocalAiHelper } from '../services/ai/LocalAiHelper.js';
import type { ClaudeService } from '../services/ClaudeService.js';
import type { SocketIOService } from '../services/SocketIOService.js';
import type { SOPService } from '../services/SOPService.js';
import type { StorageService } from '../services/StorageService.js';

/**
 * Type assertion patterns used in this file:
 *
 * 1. req.session.userEmail! - Safe after requireAuth middleware
 *    The requireAuth middleware guarantees userEmail exists by checking
 *    if (!req.session?.userEmail) and returning 401. After that check,
 *    we can safely assert non-null.
 *
 * 2. req.params.x as string - Path params are always single strings
 *    Express route parameters (e.g., :chatId) are always single strings.
 *    The string | string[] type is conservative; arrays only occur with
 *    query parameters when the same key appears multiple times.
 */

export function createApiRoutes(
  authService: AuthService,
  githubApiService: GitHubApiService,
  uploadService: UploadService,
  gitLocalService: GitLocalService,
  chatService: ChatService,
  userSecretsService: SecretsService,
  tunnelService: TunnelService | undefined,
  claudeCodeSessions: Map<string, any>,
  connectionsService: ConnectionsService, // CRITICAL: Must be same instance used by GitHubApiService for events
  claudeService?: ClaudeService,
  socketIOService?: SocketIOService,
  pushNotificationService?: PushNotificationService, // Optional: Push notification service
  sopService?: any, // Optional: SOPService for SOP progress in chat summarization
  storageService?: StorageService, // Optional: Storage management service
  localAiHelper?: LocalAiHelper // Optional: local-first one-shot AI helper (intent/suggestions/voice)
): Router {
  const router = Router();

  // Create service singletons
  const themeService = new ThemeService(chatService.dbAdapter);
  const intentAnalysisService = new IntentAnalysisService(githubApiService, localAiHelper);
  const suggestionsService = new SuggestionsService(githubApiService, localAiHelper);
  // Voice dictation phrases (on-device biasing vocabulary) — JSON-backed under DATA_DIR.
  const voicePhrasesService = new VoicePhrasesService();

  // Attach services to request for use in handlers
  router.use((req, res, next) => {
    (req as any).gitLocalService = gitLocalService;
    next();
  });

  // ============================================================================
  // MODULAR SUBROUTES - Mounted here for better organization
  // ============================================================================

  // Health check routes (no auth required)
  router.use('/', createHealthRoutes());

  // User routes (profile, theme)
  router.use('/user', createUserRoutes(authService, githubApiService, themeService));

  // Secrets routes (user secrets and vault management)
  router.use('/', createSecretsRoutes(userSecretsService, connectionsService, gitLocalService));

  // Dev/debug routes (config, dev-info, debug endpoints)
  router.use('/', createDevRoutes());

  // Connection routes (OAuth, service integrations)
  router.use(
    '/',
    createConnectionsRoutes(connectionsService, chatService, githubApiService, gitLocalService)
  );

  // Chat routes (chat management, messages, intent analysis)
  router.use(
    '/',
    createChatRoutes(
      chatService,
      intentAnalysisService,
      suggestionsService,
      githubApiService,
      claudeCodeSessions,
      sopService,
      claudeService,
      localAiHelper
    )
  );

  // Repository routes (projects, repos, GitHub integration)
  router.use(
    '/',
    createRepositoryRoutes(
      githubApiService,
      gitLocalService,
      chatService,
      uploadService,
      connectionsService,
      tunnelService,
      authService,
      socketIOService,
      voicePhrasesService
    )
  );

  // Miscellaneous routes (user settings, MCP, agent setup, push notifications)
  router.use(
    '/',
    createMiscRoutes(themeService, chatService, authService, pushNotificationService)
  );

  // Storage management routes (workspace file browsing and cleanup)
  if (storageService) {
    router.use('/storage', createStorageRoutes(storageService));
  }

  // ============================================================================
  // ALL ROUTES MIGRATED TO MODULAR SUBROUTES ✓
  // ============================================================================

  // All routes have been successfully migrated to modular subroutes:
  // ✓ Health routes (health, heartbeat, version, verify-ownership) → health.routes.ts
  // ✓ User routes (user, user/profile, user/organizations, user/theme) → user.routes.ts
  // ✓ Secrets routes (user/secrets, secrets/vault/*) → secrets.routes.ts
  // ✓ Dev routes (config, dev-info, debug/*) → dev.routes.ts
  // ✓ Connections routes (connections/*, update-git-credentials) → connections.routes.ts
  // ✓ Chat routes (chats/*, messages/*) → chat.routes.ts
  // ✓ Repository routes (repos/*, projects/*, upload-file, generations) → repository.routes.ts
  // ✓ Miscellaneous routes (user-settings, MCP, agent-setups, routines, push-notifications, webhooks) → misc.routes.ts

  return router;
}
