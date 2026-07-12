/**
 * Test Server Factory
 *
 * Creates Express app without .listen() for supertest integration.
 * Allows testing HTTP endpoints in-memory without port binding.
 *
 * Philosophy: Use REAL services where possible, mock only external APIs
 */

import express, { Application } from 'express';
import session from 'express-session';
import cors from 'cors';
import { createAuthRoutes } from '../../../src/routes/auth.routes.js';
import { createApiRoutes } from '../../../src/routes/api.routes.js';
import { createSourceControlRoutes } from '../../../src/routes/subroutes/source-control.routes.js';
import { createTunnelRoutes } from '../../../src/routes/tunnel.routes.js';
import { createJwtAuthMiddleware } from '../../../src/middleware/jwtAuth.js';
import { AuthService } from '../../../src/services/AuthService.js';
import { ChatService } from '../../../src/services/ChatService.js';
import { GitLocalService } from '../../../src/services/GitLocalService.js';
import { GitHubApiService } from '../../../src/services/GitHubApiService.js';
import { UploadService } from '../../../src/services/UploadService.js';
import { SecretsService } from '../../../src/services/SecretsService.js';
import { ConnectionsService } from '../../../src/services/ConnectionsService.js';
import { MockTunnelService } from '../mocks/MockTunnelService.js';
import { MockProcessTrackerService } from '../mocks/MockProcessTrackerService.js';
import { MockReposCacheService } from '../mocks/MockReposCacheService.js';
import { WORKSPACE_DIR } from '@vgit2/shared/constants';
import { ClaudeService } from '../../../src/services/ClaudeService.js';
import { SlackClient } from '../../../src/services/SlackClient.js';
import { SocketIOService } from '../../../src/services/SocketIOService.js';
import { SourceControlService } from '../../../src/services/SourceControlService.js';
import { LocalSecretsVaultAdapter } from '../../../src/db/LocalSecretsVaultAdapter.js';

import type { ClaudeOAuthService } from '../../../src/services/ClaudeOAuthService.js';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { StorageService } from '../../../src/services/StorageService.js';

export interface TestServerOptions {
  /**
   * Database adapter (a real DbAdapter — SqliteDbAdapter — for testing)
   */
  dbAdapter: DbAdapter;

  /**
   * Optional auth token for session initialization
   */
  authToken?: string;

  /**
   * Optional user email for session
   */
  userEmail?: string;

  /**
   * Optional services to override (for specialized tests)
   */
  services?: {
    authService?: AuthService;
    chatService?: ChatService;
    gitLocalService?: GitLocalService;
    githubApiService?: GitHubApiService;
    uploadService?: UploadService;
    secretsService?: SecretsService;
    connectionsService?: ConnectionsService;
    claudeService?: ClaudeService;
    socketIOService?: SocketIOService;
  };

  /**
   * Optional StorageService instance (with custom basePath for testing)
   */
  storageService?: StorageService;

  /**
   * Optional SourceControlService instance (mobile Source Control tabs,
   * portable.dev#17) — defaults to a real service over the test services above.
   */
  sourceControlService?: SourceControlService;

  /**
   * Optional ClaudeOAuthService (mounts /api/ai-credentials when provided)
   */
  claudeOAuthService?: ClaudeOAuthService;

  /**
   * Enable JWT authentication middleware (default: false for simpler testing)
   */
  enableJwtAuth?: boolean;

  /**
   * Require Authorization header for session injection (default: false for backwards compatibility)
   * When true, session data (authToken, userEmail) is only injected when Authorization header is present
   * When false, session data is injected for ALL requests (old behavior)
   */
  requireAuthHeaderForSession?: boolean;
}

/**
 * Creates Express app configured for testing with supertest
 *
 * @param options - Configuration options for test server
 * @returns Express app ready for supertest
 */
export function createTestServer(options: TestServerOptions): Application {
  const app = express();

  // Trust proxy (matches production)
  app.set('trust proxy', 1);

  // CORS
  app.use(
    cors({
      origin: ['http://localhost:3000', 'http://localhost:4200', 'http://localhost:7878'],
      credentials: true,
    })
  );

  // Body parsing
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Session middleware (in-memory for tests)
  const sessionMiddleware = session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  });

  app.use(sessionMiddleware);

  // Mock GitHubAppClient for testing GitHub App installation flows
  // This mocks the HTTP client that calls the remote GitHub App service
  const mockGitHubAppClient = {
    validateInstallation: async (installationId: number) => ({
      isValid: true,
      account: {
        login: `test-account-${installationId}`,
        type: 'User',
        avatarUrl: 'https://example.com/avatar.jpg',
      },
    }),
    createInstallationToken: async (installationId: number) => ({
      token: `ghs_mock_token_${installationId}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    }),
    getInstallationRepos: async (installationId: number) => [
      {
        id: 123,
        name: 'test-repo',
        full_name: `test-account-${installationId}/test-repo`,
        private: false,
        owner: {
          login: `test-account-${installationId}`,
          type: 'User',
          avatar_url: 'https://example.com/avatar.jpg',
        },
        description: 'Test repository',
        html_url: `https://github.com/test-account-${installationId}/test-repo`,
        default_branch: 'main',
      },
    ],
    healthCheck: async () => ({
      status: 'ok',
      service: 'github-app-service',
      app: { appId: 'mock-app-id', appName: 'Mock GitHub App' },
    }),
  };

  // Initialize or use provided services
  // IMPORTANT: ConnectionsService must be initialized FIRST as it's a dependency for other services
  const connectionsService =
    options.services?.connectionsService ||
    new ConnectionsService(options.dbAdapter, WORKSPACE_DIR, mockGitHubAppClient);

  // Create a mock SlackClient with dummy credentials - fetch is mocked globally
  const slackClient = new SlackClient('mock-slack-client-id', 'mock-slack-client-secret');

  const authService =
    options.services?.authService ||
    new AuthService(
      connectionsService,
      undefined, // autoConnectorService
      undefined, // githubApiService
      slackClient
    );

  const chatService = options.services?.chatService || new ChatService(options.dbAdapter);

  const gitLocalService = options.services?.gitLocalService || new GitLocalService();

  // GitHubApiService needs ReposCacheService, ConnectionsService, and optional services
  // Note: GitHubApiService signature: (reposCache, connectionsService, repoViewTracker?, chatService?)
  const reposCache = new MockReposCacheService();
  const githubApiService =
    options.services?.githubApiService ||
    new GitHubApiService(
      reposCache, // reposCache - MockReposCacheService for testing
      connectionsService, // REQUIRED: EventEmitter for reactive token management
      undefined, // repoViewTracker - optional
      undefined // chatService - optional
    );

  const uploadService = options.services?.uploadService || new UploadService();

  // Local SQLite secrets vault adapter (the production local-first vault).
  const vaultAdapter = new LocalSecretsVaultAdapter();

  const secretsService =
    options.services?.secretsService || new SecretsService('test-encryption-key', vaultAdapter);

  const tunnelService = new MockTunnelService();

  // Mock claudeCodeSessions
  const claudeCodeSessions = new Map();

  // Set authService on app.locals for routes that need it (e.g., /auth/github-app/check-existing)
  app.locals.authService = authService;

  // Mock Clerk client for testing (e.g., /auth/clerk/exchange)
  app.locals.clerkClient = {
    sessions: {
      getSession: async (sessionId: string) => {
        if (sessionId === 'invalid-session' || !sessionId) {
          throw new Error('Session not found');
        }
        return {
          id: sessionId,
          userId: 'user_mock123',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    },
    users: {
      getUser: async (userId: string) => {
        return {
          id: userId,
          username: 'testuser',
          primaryEmailAddress: { emailAddress: 'test@example.com' },
          emailAddresses: [{ emailAddress: 'test@example.com', id: 'email123' }],
          primaryEmailAddressId: 'email123',
          imageUrl: 'https://example.com/avatar.jpg',
        };
      },
    },
  };

  // Health check endpoint (matches production)
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: 'test',
    });
  });

  // JWT middleware (optional)
  if (options.enableJwtAuth) {
    const jwtMiddleware = createJwtAuthMiddleware();
    app.use('/api', jwtMiddleware);
    app.use('/auth', jwtMiddleware);
  }

  // Setup test session data if provided
  // IMPORTANT: This middleware MUST come AFTER session middleware but BEFORE routes
  if (options.authToken || options.userEmail) {
    app.use((req, _res, next) => {
      // If requireAuthHeaderForSession is true, only inject session when Authorization header is present
      // This allows tests to check authentication by omitting the header
      // Default behavior (false) injects session for ALL requests (backwards compatible)
      if (options.requireAuthHeaderForSession) {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return next();
        }
      }

      // Ensure session exists
      if (!req.session) {
        console.error('[TestServer] Session object not found on request');
        return next();
      }

      if (options.authToken) {
        req.session.authToken = options.authToken;
      }
      if (options.userEmail) {
        req.session.userEmail = options.userEmail;
      }

      next();
    });
  }

  // Set OAuth service URL for Google/Slack OAuth delegation (mocked in globalFetchMock.ts)
  // IMPORTANT: This must match the mock URL pattern in globalFetchMock.ts
  if (!process.env.GITHUB_APP_SERVICE_URL) {
    process.env.GITHUB_APP_SERVICE_URL =
      'https://this-is-not-a-real-url.github-app-service-mock.modal.run';
  }

  // Register routes
  app.use('/auth', createAuthRoutes(authService, connectionsService));

  app.use(
    '/api',
    createApiRoutes(
      authService,
      githubApiService,
      uploadService,
      gitLocalService,
      chatService,
      secretsService,
      tunnelService as any,
      claudeCodeSessions,
      connectionsService,
      options.services?.claudeService || (null as any),
      options.services?.socketIOService || (null as any),
      null as any, // pushNotificationService
      null as any, // sopService
      options.storageService, // storageService
      undefined, // localAiHelper
      options.claudeOAuthService // claudeOAuthService (mounts /api/ai-credentials)
    )
  );

  // Mobile Source Control tabs (portable.dev#17) — same isolated mount as
  // server.ts (a sibling of the /api router, not wired into createApiRoutes).
  const sourceControlService =
    options.sourceControlService ||
    new SourceControlService(connectionsService, authService, gitLocalService);
  app.use(
    '/api/source-control',
    createSourceControlRoutes(sourceControlService, authService, gitLocalService)
  );

  app.use(createTunnelRoutes(tunnelService as any));

  return app;
}
