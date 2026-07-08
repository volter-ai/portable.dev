// NOTE: .env is loaded by @vgit2/shared/constants before any imports
import './utils/logger'; // Must be first to override console methods
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import * as Sentry from '@sentry/node';
import {
  ALLOWED_EMAILS,
  WORKSPACE_DIR,
  getUserMediaDir,
  getUserWorkspaceDir,
  MEDIA_DIR,
  ANTHROPIC_API_KEY,
  SESSION_SECRET,
  NODE_ENV,
  VGIT_PORT,
  DEV_BACKEND_PORT,
  debugLog,
} from '@vgit2/shared/constants';
import { LocalSecretStore } from '@vgit2/shared/secrets';
import { buildSentryConfig } from '@vgit2/shared/sentry';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';

import { FEATURE_FLAGS } from './config/featureFlags.js';
import { resolveConfigDir } from './db/ClaudeProjects/projectsPaths.js';
import { LocalSecretsAdapter } from './db/LocalSecretsAdapter.js';
import { LocalSecretsVaultAdapter } from './db/LocalSecretsVaultAdapter.js';
import { SecretsVaultAdapter } from './db/SecretsVaultAdapter.js';
import { SqliteDbAdapter } from './db/SqliteDbAdapter/index.js';
import { createE2eEnforcementMiddleware } from './middleware/e2eEnforcement.js';
import { createJwtAuthMiddleware } from './middleware/jwtAuth.js';
import { createApiRoutes } from './routes/api.routes.js';
import { createAuthRoutes } from './routes/auth.routes.js';
import { createE2eRoutes, createLoopbackDispatch } from './routes/subroutes/e2e.routes.js';
import { createInternalRoutes } from './routes/subroutes/internal.routes.js';
import { createStopOnPcRoutes } from './routes/subroutes/stop-on-pc.routes.js';
import { createTunnelApiRoutes } from './routes/subroutes/tunnel-api.routes.js';
import { createTunnelRoutes } from './routes/tunnel.routes.js';

// Services
import { LocalAiHelper } from './services/ai/LocalAiHelper.js';
import { AuthService } from './services/AuthService.js';
import { ChatExecutionService } from './services/ChatExecutionService.js';
import { ChatService } from './services/ChatService.js';
import { ClaudeOAuthService } from './services/ClaudeOAuthService.js';
import { ClaudeService } from './services/ClaudeService.js';
import { ConnectionsService } from './services/ConnectionsService.js';
import { DeviceTokenService } from './services/DeviceTokenService.js';
import { E2eSessionService } from './services/E2eSessionService.js';
import { ExternalTranscriptFollowerService } from './services/ExternalTranscriptFollowerService.js';
import { GitHubApiService } from './services/GitHubApiService.js';
import { GitLocalService } from './services/GitLocalService.js';
import { HandshakeVerificationGate } from './services/HandshakeVerificationGate.js';
import { LocalAiCredentialsService } from './services/LocalAiCredentialsService.js';
import { LocalGitHubAuthService } from './services/LocalGitHubAuthService.js';
import { NpxCommandDetector } from './services/mcp/config/NpxCommandDetector.js';
import { PlaywrightMcpConfig } from './services/mcp/config/PlaywrightMcpConfig.js';
import { McpService } from './services/mcp/McpService.js';
import { RunConnectionMcpServer } from './services/mcp/servers/RunConnectionMcpServer.js';
import { StandardMcpServer } from './services/mcp/servers/StandardMcpServer.js';
import { McpValidator } from './services/mcp/utils/McpValidator.js';
import { ReposCacheService } from './services/ReposCacheService.js';
import { RepoViewTrackerService } from './services/RepoViewTrackerService.js';
import { SecretsService } from './services/SecretsService.js';
import { SocketIOService } from './services/SocketIOService.js';
import { SOPService } from './services/SOPService.js';
import { UploadService } from './services/UploadService.js';

// Routes
import { createVibewaitingRoutes } from './vibewaiting/routes/vibewaiting.routes.js';
import { LeaderboardService } from './vibewaiting/services/LeaderboardService.js';

import type { DbAdapter } from './db/DbAdapter.js';
import type { SecretsAdapter } from './db/SecretsAdapter.js';

// Middleware

// Token Adapter (imported at top with other shared imports)

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// All environment variables are now imported from @vgit2/shared/constants
// This ensures single source of truth and prevents cascading issues

// Initialize Sentry (after env vars loaded, before server starts)
const sentryConfig = buildSentryConfig({
  service: 'api',
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
});
if (sentryConfig) {
  Sentry.init(sentryConfig);
  console.log('[Sentry] Initialized for API service');
}

debugLog('Starting server initialization...');
debugLog(`Environment: ${NODE_ENV}`);

// NOTE: Global error handlers are installed in ClaudeService.ts as a side-effect of import
// This ensures they're active in both main process AND any child processes
// See ClaudeService.ts top-level code for handler implementation

// Validate required environment variables
debugLog('Checking required environment variables...');

// NOTE: AI tokens are not validated at startup (lazy validation). In a normal
// local-first run the per-request Bearer JWT is validated locally and AI
// credentials come from LocalAiCredentialsService (the user's own Anthropic
// credential — Claude OAuth / ANTHROPIC_API_KEY).

debugLog('Environment variables check complete (lazy token validation)');
debugLog('Workspace directory:', WORKSPACE_DIR);

// Warn if the session secret is missing (sessions won't work without it).
// OAuth credentials are handled by the OAuth service (github-app package)
if (!SESSION_SECRET) {
  console.error('Warning: SESSION_SECRET not configured. Sessions will not work.');
  console.error('Set SESSION_SECRET in .env');
}

/**
 * Main Server class
 */
class Server {
  private app: express.Application;
  private server: http.Server;

  // Services (initialized in constructor)
  private authService!: AuthService;
  private chatService!: ChatService;
  private uploadService!: UploadService;
  private gitLocalService!: GitLocalService;
  private githubApiService!: GitHubApiService;
  private userSecretsService!: SecretsService;
  private leaderboardService!: LeaderboardService;
  private processTrackerService!: any; // ProcessTrackerService
  private claudeService!: ClaudeService;
  private socketIOService!: SocketIOService;
  private chatExecutionService!: ChatExecutionService;
  private handshakeVerificationGate!: HandshakeVerificationGate; // block kill switch (gateway VERIFY_HANDSHAKE)
  private pushNotificationService!: any; // PushNotificationService
  private tunnelService?: any; // TunnelService — always constructed in local mode (Cloudflare Quick Tunnels)
  private connectionsService!: ConnectionsService; // Connection management service
  private autoConnectorService!: any; // AutoConnectorService - auto-creates GitHub connectors on login
  private sopService!: any; // SOPService - Standard Operating Procedure worksheet management
  private storageService!: any; // StorageService - Workspace file browsing and cleanup

  // Shared state
  private claudeCodeSessions: Map<string, any>;

  // Local-first device-token mint/validate gate — the per-request gate.
  private deviceTokenService?: DeviceTokenService;
  // E2E encryption sessions (portable.dev#13): PSK-authenticated X25519
  // handshakes + per-session directional keys (PORTABLE_E2E_PSK from the launcher).
  private e2eSessionService = new E2eSessionService();
  // Per-boot secret the E2E loopback dispatch stamps so the enforcement
  // middleware trusts the decrypted-tunnel replay (never leaves the process).
  private e2eInnerSecret = crypto.randomBytes(32).toString('hex');
  // Local-first AI credentials: Claude subscription OAuth / ANTHROPIC_API_KEY,
  // resolved locally.
  private localAiCredentialsService?: LocalAiCredentialsService;
  // Claude-account OAuth: phone-driven login + access-token auto-refresh.
  private claudeOAuthService?: ClaudeOAuthService;
  // Local-first one-shot AI helper — direct-to-Anthropic replacement for the
  // auxiliary AI helper calls (intent/suggestions/summary/actions/project-name).
  private localAiHelper?: LocalAiHelper;
  // Local-first GitHub access: OAuth device-flow token held on-device.
  private localGitHubAuthService?: LocalGitHubAuthService;

  private sessionReaperService?: import('./services/SessionReaperService.js').SessionReaperService;
  private hostMetricsService?: import('./services/HostMetricsService.js').HostMetricsService;
  // rev12: presence registry for TERMINAL `claude` sessions (hook-relay ingest).
  private externalClaudeSessionService?: import('./services/ExternalClaudeSessionService.js').ExternalClaudeSessionService;
  // rev12: mcp-sidecar channel (register + long-poll; Stop-on-PC delivery).
  private sidecarChannelService?: import('./services/SidecarChannelService.js').SidecarChannelService;
  // rev12: Stop-on-PC orchestration (deliver + wait for evidence).
  private stopOnPcService?: import('./services/StopOnPcService.js').StopOnPcService;
  // rev12 D62: mid-turn live-follow of terminal transcripts (push rows to the room).
  private externalTranscriptFollower?: import('./services/ExternalTranscriptFollowerService.js').ExternalTranscriptFollowerService;

  constructor() {
    debugLog('Initializing Express...');
    this.app = express();
    debugLog('Express initialized');

    // Trust proxy for ngrok/reverse proxy deployments
    this.app.set('trust proxy', 1);

    this.claudeCodeSessions = new Map();

    debugLog('Creating HTTP server...');
    this.server = http.createServer(this.app);
    debugLog('HTTP server created');
  }

  async initialize(): Promise<void> {
    // IMPORTANT: Middleware must be set up BEFORE routes
    // This ensures req.session exists when routes are called
    await this.setupMiddleware();

    // Now initialize services and routes (which depend on session middleware)
    await this.initializeServices();
    this.setupRoutes();
    this.setupStaticFiles();
  }

  private async setupMiddleware(): Promise<void> {
    // CORS configuration for the mobile and local clients.
    // Allow requests from the mobile app origins, localhost dev ports, and production domains.
    const corsOptions: cors.CorsOptions = {
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) {
          return callback(null, true);
        }

        // Production domains and development origins
        const allowedOrigins = [
          // Production domains
          'https://portable.dev',
          'https://portable-dev.com',
          'https://app.portable.dev',
          'https://app.portable-dev.com',
          'https://modal.portable.dev',
          'https://modal.portable-dev.com',
          // Development localhost ports
          'http://localhost:3000',
          'http://localhost:7878',
          'http://localhost:65534',
          'http://localhost:65535',
          // Mobile app origins
          'capacitor://localhost',
          'http://localhost',
          'ionic://localhost',
          /^capacitor:\/\//,
          /^ionic:\/\//,
        ];

        // Check if origin matches any allowed pattern
        const isAllowed = allowedOrigins.some((allowed) => {
          if (typeof allowed === 'string') {
            return origin === allowed;
          }
          // RegExp pattern
          return allowed.test(origin);
        });

        if (isAllowed) {
          callback(null, true);
        } else {
          // Log but allow (for development)
          callback(null, true); // Allow all origins for now (can be restricted in production)
        }
      },
      credentials: true, // Allow cookies and credentials
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    };

    this.app.use(cors(corsOptions));
    console.log('[Server] CORS enabled for web and mobile apps (Capacitor origins)');

    this.app.use(express.json({ limit: '50mb' })); // Increase limit for file uploads
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Session management (in-memory only - Redis used only for chat buffering)
    // Note: a shared session store isn't needed — the api is a single-user local
    // runtime, and JWT authentication injects user data directly into requests.
    // Setting up in-memory session middleware

    const sessionConfig: session.SessionOptions = {
      secret: SESSION_SECRET || 'fallback-secret-for-dev',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Caddy handles HTTPS, backend is HTTP internally
        httpOnly: true,
        sameSite: 'lax', // Allow cookies from OAuth redirects
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        domain: undefined, // Let Express use request hostname (preserves proxy hostname)
        path: '/', // Cookie valid for entire site
      },
      // No store = in-memory sessions (default MemoryStore)
      // This is fine for the single-user local runtime.
    };

    this.app.use(session(sessionConfig));
    // In-memory session middleware enabled
  }

  private async initializeServices(): Promise<void> {
    debugLog('Initializing services...');

    // Initialize database adapter. The local-first PC runtime is fully on local
    // SQLite (chats + connections + themes + push + service accounts),
    // so it boots with NO external database env.
    // The SDK's shared `~/.claude/projects`
    // transcripts are the chat source of truth — message stream (D29a) AND list
    // (D29b) — so terminal `claude` ⇄ portable share the same chats. This is the
    // DEFAULT; the legacy SQLite message store is reachable only via the explicit
    // escape hatch `CHAT_MESSAGE_SOURCE=sqlite`. (It first shipped opt-in/default-OFF,
    // which contradicted "source of truth" and showed zero chats on a fresh
    // `<WORKSPACE_DIR>/.chat-data/chats.sqlite`.) The reposProvider is LAZY —
    // `this.gitLocalService` is constructed below and discovery only runs later, on a
    // chat-list read.
    const chatMessageSource =
      process.env.CHAT_MESSAGE_SOURCE === 'sqlite'
        ? undefined
        : {
            configDir: resolveConfigDir(),
            reposProvider: () => this.gitLocalService.getLocalRepositories('local'),
          };
    const dbAdapter: DbAdapter = new SqliteDbAdapter(undefined, undefined, chatMessageSource);
    const dbInitialized = await dbAdapter.initialize();
    if (!dbInitialized) {
      throw new Error('Local SQLite database initialization failed.');
    }
    debugLog('✓ Database adapter initialized (all domains on local SQLite)');

    // Token validation is local-first: device tokens are validated on the PC
    // and JWTs locally via @vgit2/shared/jwt; the remote
    // TokenValidationService + GitHubAppClient (remote services) were retired.
    // GitHub access is the local OAuth device flow (LocalGitHubAuthService).

    // Initialize services in dependency order
    // Initialize ConnectionsService first (needed by AuthService for OAuth flow).
    // Connection credentials are encrypted at rest in a LocalSecretStore
    // (AES-256-GCM, per-install key under DATA_DIR).
    // Single shared LocalSecretStore for connection credentials and the
    // device-token signing secret — namespaced keys, no collision.
    const localSecretStore = new LocalSecretStore();
    const secretsAdapter: SecretsAdapter = new LocalSecretsAdapter(dbAdapter, localSecretStore);
    // DeviceTokenService is the local per-request auth gate.
    this.deviceTokenService = new DeviceTokenService(localSecretStore);
    debugLog('[Server] DeviceTokenService initialized (local-first per-request gate)');
    // LocalAiCredentialsService resolves the user's OWN Anthropic credential —
    // Claude subscription OAuth or ANTHROPIC_API_KEY — from the SAME shared store
    // (namespaced key), never from a JWT claim.
    this.localAiCredentialsService = new LocalAiCredentialsService(localSecretStore);
    debugLog('[Server] LocalAiCredentialsService initialized (local-first AI credentials)');
    // Claude-account OAuth (portable.dev#18): phone-driven login + the auto-refresh
    // seam ensureFresh() delegates to at session start / one-shots.
    this.claudeOAuthService = new ClaudeOAuthService(this.localAiCredentialsService);
    this.localAiCredentialsService.setOAuthRefresher(this.claudeOAuthService);
    debugLog('[Server] ClaudeOAuthService initialized (login-from-phone + auto-refresh)');
    // One-shot AI helper for auxiliary AI calls — routes them direct to the
    // user's OWN Anthropic credential (Haiku).
    this.localAiHelper = new LocalAiHelper(this.localAiCredentialsService);
    debugLog('[Server] LocalAiHelper initialized (direct-Anthropic one-shot helper)');
    // LocalGitHubAuthService holds the user's OWN GitHub token (OAuth device flow)
    // in the SAME shared store (namespaced key), never a JWT claim.
    this.localGitHubAuthService = new LocalGitHubAuthService(localSecretStore);
    debugLog('[Server] LocalGitHubAuthService initialized (local-first GitHub device flow)');
    debugLog('[Server] SecretsAdapter: Local');

    // GitHubAppClient (remote github-app service) was retired;
    // GitHub access is the local OAuth device flow (LocalGitHubAuthService).
    this.connectionsService = new ConnectionsService(secretsAdapter, WORKSPACE_DIR, undefined);
    // Local-first: resolve the active GitHub connection from the
    // on-device device-flow token instead of the gateway/Clerk chain.
    if (this.localGitHubAuthService) {
      this.connectionsService.setLocalGitHubAuthService(this.localGitHubAuthService);
    }
    debugLog(
      '[Server] ConnectionsService initialized (EventEmitter for reactive token management)'
    );

    // Initialize AutoConnectorService (auto-creates GitHub connectors on login)
    const { AutoConnectorService } = await import('./services/AutoConnectorService');
    this.autoConnectorService = new AutoConnectorService(this.connectionsService);
    debugLog('[Server] AutoConnectorService initialized');

    // NOTE: SlackClient removed - Slack OAuth is now handled by the OAuth service
    this.authService = new AuthService(
      this.connectionsService,
      this.autoConnectorService,
      undefined // githubApiService - set later via setGitHubApiService
    );
    // Local-first: let the Socket.IO handshake accept a device token.
    if (this.deviceTokenService) {
      this.authService.setDeviceTokenService(this.deviceTokenService);
    }
    debugLog('[Server] AuthService initialized');

    // Initialize SOPService (Standard Operating Procedure worksheet management)
    this.sopService = new SOPService();
    console.log('[Server] SOPService initialized');

    this.chatService = new ChatService(dbAdapter, this.sopService);

    // Transcription post-processing degrades via the local AI helper.
    this.uploadService = new UploadService(this.localAiHelper);

    // Initialize ReposCacheService (5 minute TTL) - must be before GitLocalService and GitHubApiService
    const reposCacheService = new ReposCacheService(5);

    // Initialize RepoViewTrackerService (tracks which repos user has viewed)
    const repoViewTrackerService = new RepoViewTrackerService();
    await repoViewTrackerService.initialize();

    this.gitLocalService = new GitLocalService(
      undefined,
      reposCacheService,
      this.authService,
      this.connectionsService
    );

    this.githubApiService = new GitHubApiService(
      reposCacheService,
      this.connectionsService,
      repoViewTrackerService,
      this.chatService
    );
    debugLog('[Server] GitHubApiService initialized with on-demand token loading');

    // Inject GitHubApiService into AuthService (for scope checking)
    this.authService.setGitHubApiService(this.githubApiService);

    // Initialize secrets vault adapter (saved-secrets "save and reuse" store).
    // The saved-secrets vault persists to local SQLite under DATA_DIR (values
    // arrive already encrypted from SecretsService).
    const secretsVaultAdapter: SecretsVaultAdapter = new LocalSecretsVaultAdapter();
    debugLog('[Server] ✓ Local SQLite secrets vault initialized');

    this.userSecretsService = new SecretsService(undefined, secretsVaultAdapter);

    // Initialize Push Notification Service (local-first).
    // The remote PushNotificationClient (VAPID service) was retired;
    // the PC sends push directly from local config (mobile Expo/FCM push kept).
    this.pushNotificationService = new (
      await import('./services/PushNotificationService.js')
    ).PushNotificationService(dbAdapter);
    debugLog('[Server] ✓ Local PushNotificationService initialized');

    // Initialize LeaderboardService (for vibewaiting game system)
    this.leaderboardService = new LeaderboardService();

    // Initialize ProcessTrackerService (global background process tracking)
    const { ProcessTrackerService } = await import('./services/ProcessTrackerService.js');
    this.processTrackerService = new ProcessTrackerService();

    // Add endpoint to get background processes
    this.app.get('/api/processes', (req, res) => {
      if (!req.session?.userEmail) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Return 10 most recent processes in reverse chronological order
      const processes = this.processTrackerService.getRecentProcesses(10);
      res.json({ processes });
    });

    // Add endpoint to check process output using Claude SDK BashOutput
    // Supports optional ?refresh=true to force re-query
    this.app.get('/api/processes/:processId/output', async (req, res) => {
      if (!req.session?.userEmail) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { processId } = req.params;
      const forceRefresh = req.query.refresh === 'true';
      console.log(`[Server] Checking output for process ${processId} (refresh: ${forceRefresh})`);

      try {
        // Check cache first unless refresh is requested
        if (!forceRefresh && this.processTrackerService) {
          const cached = this.processTrackerService.getCachedOutput(processId);
          if (cached) {
            // Returning cached output
            return res.json(cached);
          }
        }

        // Set refreshing state and broadcast
        if (forceRefresh && this.processTrackerService) {
          this.processTrackerService.setRefreshing(processId, true);
          const process = this.processTrackerService
            .getAllProcesses()
            .find((p: any) => p.id === processId);
          if (process && this.socketIOService) {
            this.socketIOService.broadcastRuntimeStateToUser(process.userId);
          }
        }

        // Query Claude SDK (injects BashOutput request into session)
        // Querying Claude SDK for process output
        const result = await this.claudeService.checkBashOutput(processId);

        // Clear refreshing state
        if (this.processTrackerService) {
          this.processTrackerService.setRefreshing(processId, false);
        }

        // Update process status if completed or failed
        if (
          (result.status === 'completed' || result.status === 'failed') &&
          this.processTrackerService
        ) {
          const status = result.status as 'completed' | 'failed';
          this.processTrackerService.updateProcessStatus(processId, status);
        }

        // Broadcast FULL runtime state to all connected clients via Socket.IO
        const process = this.processTrackerService
          .getAllProcesses()
          .find((p: any) => p.id === processId);
        if (process && this.socketIOService) {
          this.socketIOService.broadcastRuntimeStateToUser(process.userId);
        }

        res.json(result);
      } catch (error: any) {
        console.error(`[Server] Error checking process output:`, error);
        res.status(500).json({ error: error.message || 'Failed to check process output' });
      }
    });

    // Initialize TunnelService (Cloudflare Quick Tunnels, created on-demand) — ALWAYS
    // available in the local-first runtime. The dev-server preview tunnels feed the mobile
    // in-chat runtime bubble, and `GET /api/repos/:owner/:repo/quick-actions` dereferences
    // `tunnelService.getUserTunnels()`. The single provider is cloudflared (the old
    // pre-configured path was removed); construction is cheap and spawns no
    // cloudflared child until a tunnel is actually requested on demand.
    const { TunnelService } = await import('./services/TunnelService.js');
    this.tunnelService = new TunnelService();
    debugLog('[Server] ✓ TunnelService initialized (Cloudflare Quick Tunnels on-demand)');

    // MCP Server control flags configured

    // Initialize McpService (MCP server configuration)
    debugLog('[Server] Initializing McpService...');

    // Create MCP config objects
    const npxDetector = new NpxCommandDetector();
    const playwrightConfig = new PlaywrightMcpConfig(
      npxDetector,
      FEATURE_FLAGS.ENABLE_PLAYWRIGHT_MCP
    );
    const standardServer = new StandardMcpServer();
    const runConnectionServer = new RunConnectionMcpServer(this.connectionsService);

    // No MCP is token-gated; availability is validated against local env.
    const mcpValidator = new McpValidator();

    const mcpService = new McpService(
      playwrightConfig,
      standardServer,
      runConnectionServer,
      mcpValidator,
      this.gitLocalService,
      this.tunnelService,
      this.chatService, // For chat management tools
      this.connectionsService // For unified code executor
    );
    // Validate MCP servers at startup (fail fast if broken)
    mcpService.validateMcpServers();
    // Validate MCP registry sync (ensure all created MCPs are registered)
    mcpService.validateMcpRegistrySync();

    this.claudeService = new ClaudeService(
      this.chatService,
      mcpService, // Pass MCP service
      this.claudeCodeSessions,
      undefined, // containerService (removed)
      this.gitLocalService, // Pass git local service
      this.tunnelService, // Pass tunnel service (undefined if disabled)
      this.processTrackerService, // Pass process tracker service
      this.userSecretsService, // Pass secrets service for portable_execute SDK
      this.connectionsService, // Pass connections service for portable_execute SDK
      this.localAiHelper // Local-first one-shot AI helper (action extraction)
    );

    // Local-first AI credentials: in local mode the PC's own Claude
    // subscription OAuth / ANTHROPIC_API_KEY drives AI calls (never a JWT claim).
    if (this.localAiCredentialsService) {
      this.claudeService.setLocalAiCredentialsService(this.localAiCredentialsService);
    }

    // Initialize MessageDeduplicationService
    const { MessageDeduplicationService } =
      await import('./services/MessageDeduplicationService.js');
    const messageDeduplicationService = new MessageDeduplicationService();

    // Initialize StorageService (workspace file browsing and cleanup)
    const { StorageService } = await import('./services/StorageService.js');
    this.storageService = new StorageService();

    // rev12: presence registry for TERMINAL `claude` sessions. Fed by the
    // launcher-installed global lifecycle hooks via /api/internal/claude-hook;
    // consumed by the runtime-state fold (presence badge) and the
    // adopt-vs-fork gate. Best-effort: a failed init only disables presence.
    try {
      const { ExternalClaudeSessionService } =
        await import('./services/ExternalClaudeSessionService.js');
      this.externalClaudeSessionService = new ExternalClaudeSessionService();
      this.externalClaudeSessionService.initialize();
      const { SidecarChannelService } = await import('./services/SidecarChannelService.js');
      this.sidecarChannelService = new SidecarChannelService(this.externalClaudeSessionService);
      const { StopOnPcService } = await import('./services/StopOnPcService.js');
      this.stopOnPcService = new StopOnPcService(
        this.externalClaudeSessionService,
        this.sidecarChannelService
      );
    } catch (error) {
      console.error('[Server] ExternalClaudeSessionService init failed (presence off):', error);
      this.externalClaudeSessionService = undefined;
      this.sidecarChannelService = undefined;
      this.stopOnPcService = undefined;
    }

    // Initialize RuntimeStateService (runtime state collection and broadcasting)
    const { RuntimeStateService } = await import('./services/RuntimeStateService.js');
    const runtimeStateService = new RuntimeStateService(
      this.tunnelService,
      this.processTrackerService,
      undefined, // runtimeStateFormatter
      this.claudeService, // live Claude sessions in the runtime panel
      this.externalClaudeSessionService // rev12: terminal-session presence
    );

    // outdated-build block kill switch: fetches the gateway's
    // VERIFY_HANDSHAKE flag (cached, fail-open). Primed now so the first
    // outdated-client check after boot rarely waits on the network.
    this.handshakeVerificationGate = new HandshakeVerificationGate();
    this.handshakeVerificationGate.prime();

    // Initialize ChatExecutionService (core execution logic, decoupled from Socket.IO)
    this.chatExecutionService = new ChatExecutionService(
      this.chatService,
      this.claudeService,
      this.gitLocalService,
      messageDeduplicationService, // Message deduplication
      this.tunnelService,
      this.processTrackerService,
      dbAdapter,
      this.pushNotificationService,
      this.sopService,
      this.claudeCodeSessions, // Session map
      reposCacheService, // ReposCacheService for cache invalidation
      this.handshakeVerificationGate, // outdated-build block kill switch
      this.externalClaudeSessionService, // rev12: adopt-vs-fork gate
      this.stopOnPcService // rev12 D63: stop-on-send (interactive send ends the terminal session)
    );

    // Wire up circular dependency: ClaudeService needs ChatExecutionService for create_chat tool
    this.claudeService.setChatExecutionService(this.chatExecutionService);

    // Initialize Socket.IO service
    this.socketIOService = new SocketIOService(
      this.server,
      this.authService,
      this.chatService,
      this.claudeService,
      this.gitLocalService,
      this.claudeCodeSessions,
      this.chatExecutionService, // Pass ChatExecutionService for unified execution
      runtimeStateService, // RuntimeStateService for runtime state collection
      this.tunnelService,
      this.processTrackerService,
      dbAdapter, // Pass dbAdapter for realtime support
      this.sopService, // SOPService for Standard Operating Procedure worksheets
      this.pushNotificationService // Pass push notification service for offline notifications
    );

    // Inject SocketIOService into ClaudeService (after both are created to avoid circular dependency)
    this.claudeService.setSocketIOService(this.socketIOService);

    // E2E encryption (portable.dev#13): share the SAME session service the HTTP
    // tunnel uses, so a session the phone established over `POST /api/e2e/handshake`
    // is resolvable by its Socket.IO handshake (`e2eSid`) for per-frame encryption.
    this.socketIOService.setE2eSessionService(this.e2eSessionService);

    // Initialize the idle session reaper: proactively frees the
    // subprocess of a multi-turn session left idle past CLAUDE_SESSION_IDLE_TTL_MS
    // (default 10 min). session_id is preserved so the next message resumes
    // transparently. On reap, notify the owner + refresh their runtime panel.
    const { SessionReaperService } = await import('./services/SessionReaperService.js');
    this.sessionReaperService = new SessionReaperService({
      claudeService: this.claudeService,
      onReap: (userId, chatId, idleMs) => {
        this.socketIOService.emitToUser(userId, 'session:reaped', {
          chatId,
          reason: 'idle',
          idleMs,
          timestamp: Date.now(),
        });
        this.socketIOService.broadcastRuntimeStateToUser(userId);
      },
    });
    this.sessionReaperService.start();

    // Host CPU/RAM metrics collector: revives the Runtime panel Metrics
    // card with the PC's REAL host metrics (`sandbox:metrics`, ~2s). Node built-ins
    // only — this is the informational gauge, NOT the removed sandbox memory-watchdog.
    const { HostMetricsService } = await import('./services/HostMetricsService.js');
    this.hostMetricsService = new HostMetricsService({
      emit: (metrics) => this.socketIOService.broadcastSandboxMetrics(metrics),
      workspaceDir: WORKSPACE_DIR,
    });
    this.hostMetricsService.start();

    // Register callback for process status changes
    if (this.processTrackerService) {
      this.processTrackerService.setStatusChangeCallback((process: any) => {
        console.log(
          `[Server] Process ${process.id} status changed to ${process.status}, broadcasting full state to user ${process.userId}`
        );
        this.socketIOService.broadcastRuntimeStateToUser(process.userId);
      });
    }

    // Register callback for tunnel state changes
    if (this.tunnelService) {
      this.tunnelService.setStateChangeCallback((userId: string) => {
        console.log(
          `[Server] Tunnel state changed for user ${userId}, broadcasting full runtime state`
        );
        this.socketIOService.broadcastRuntimeStateToUser(userId);
      });
    }

    // Initialize GitHub token cache for GitHubApiService
    // Tokens will be loaded eagerly for existing users, then updated reactively via ConnectionsService events
    try {
      // TODO: Get all user IDs from database (e.g., from connections table or users table)
      // For now, start with empty cache - tokens will load on-demand when users connect
      const userIds: string[] = [];

      // If we have a database adapter with user query support, populate userIds here
      // For example: const userIds = await dbAdapter.getAllUserIds();

      await this.githubApiService.initialize(userIds);
      debugLog(`[Server] GitHubApiService token cache initialized (${userIds.length} users)`);
    } catch (error) {
      console.error('[Server] Failed to initialize GitHubApiService token cache:', error);
      // Non-critical - tokens will load on-demand
    }

    debugLog('All services initialized successfully');
  }

  /**
   * Initialize all services based on JWT token
   * Called when JWT is validated at startup, login, or token refresh
   *
   * @param authToken - JWT token string
   */
  private async setGlobalAuthToken(authToken: string): Promise<void> {
    try {
      const { decodeAuthToken } = await import('@vgit2/shared/jwt');
      const payload = decodeAuthToken(authToken);

      if (!payload?.email) {
        console.warn('[Server] setGlobalAuthToken: No email in JWT payload');
        return;
      }

      // Initialize GitHubApiService token cache
      if (this.githubApiService) {
        await this.githubApiService.loadTokenForUser(payload.email, authToken);
      }
    } catch (error) {
      console.error('[Server] setGlobalAuthToken failed:', error);
    }
  }

  private setupRoutes(): void {
    debugLog('Setting up routes...');

    // Root health check endpoint (for Docker healthcheck and monitoring)
    // This must be at the root level, not under /api, for Docker healthcheck to work
    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: NODE_ENV,
      });
    });

    // Media files - serve from media directory (per-user in MEDIA_DIR)
    this.app.get('/data/media/:sanitizedUserId/:filename', (req, res) => {
      const { sanitizedUserId, filename } = req.params;
      const filePath = path.join(MEDIA_DIR, sanitizedUserId, filename);
      res.sendFile(filePath, (err) => {
        if (err) {
          console.error(`[Server] Failed to serve media file: ${filePath}`, err);
          res.status(404).send('Media file not found');
        }
      });
    });
    debugLog(`[Server] Media files will be served per-user from: ${MEDIA_DIR}`);

    // rev12 internal loopback surface (hook-relay / mcp-sidecar ingest). MUST be
    // mounted BEFORE the JWT middleware: the claude-spawned relays carry no JWT —
    // they are gated by the per-boot internal secret instead (fail closed when
    // PORTABLE_HOOK_SECRET is unset). Registered first so Express matches it
    // before the '/api' JWT gate below.
    if (this.externalClaudeSessionService) {
      // rev12 D62: mid-turn live-follow — while a terminal turn runs AND the
      // chat room has members, tail the transcript and push new rows to the
      // room so the phone sees the work as it happens (PRD §10).
      const externalSessions = this.externalClaudeSessionService;
      const follower = new ExternalTranscriptFollowerService({
        getSession: (sessionId) => {
          const session = externalSessions.getSession(sessionId);
          return session ? { state: session.state, transcriptPath: session.transcriptPath } : null;
        },
        getMessages: (chatId) => this.chatService.getMessages(chatId),
        broadcastToRoom: (room, event, payload) =>
          this.socketIOService?.broadcastToRoom(room, event, payload),
        roomHasMembers: (room) => this.socketIOService?.roomHasMembers(room) ?? false,
      });
      this.externalTranscriptFollower = follower;
      if (this.socketIOService) {
        this.socketIOService.onChatJoined = (chatId) => void follower.onChatJoined(chatId);
      }

      this.app.use(
        '/api/internal',
        createInternalRoutes(this.externalClaudeSessionService, {
          onSessionsChanged: () => this.socketIOService?.broadcastRuntimeStateToAllUsers(),
          // A completed TERMINAL turn (the Stop hook) means the transcript JSONL
          // just gained a whole turn — tell clients so an open discovered chat
          // refreshes its messages (rev12 D55).
          onHookEvent: (event) => {
            // D62: UserPromptSubmit starts the live-follow; the end hooks stop it.
            void follower.onHookEvent(event);
            const name = typeof event.hook_event_name === 'string' ? event.hook_event_name : '';
            const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
            if ((name === 'Stop' || name === 'StopFailure') && sessionId) {
              this.socketIOService?.emitToAllUsers('chat:external_turn_completed', {
                chatId: sessionId,
              });
            }
          },
          sidecarChannel: this.sidecarChannelService,
        })
      );
    }

    // JWT authentication middleware for API and Auth routes
    // Validates Authorization: Bearer <token> header and implements sliding expiration
    // Local-first: pass the DeviceTokenService so the device token —
    // not a Clerk JWT — is the per-request gate (the remote TokenValidationService
    // was retired; validation is local).
    // E2E enforcement (portable.dev#13, hard cutover): once PORTABLE_E2E_PSK is
    // set, reject any plaintext `/api/*` request (except health/e2e/internal/
    // media) — even one with a valid Bearer — so a malicious relay can't replay
    // the visible token in the clear. Mounted BEFORE the JWT gate; the decrypted
    // tunnel replay carries the per-boot inner secret and passes.
    this.app.use(
      '/api',
      createE2eEnforcementMiddleware(this.e2eSessionService, this.e2eInnerSecret)
    );

    const jwtMiddleware = createJwtAuthMiddleware(this.deviceTokenService);
    this.app.use('/api', jwtMiddleware);
    this.app.use('/auth', jwtMiddleware);

    // E2E encryption (portable.dev#13): the PSK-authenticated handshake
    // (`/api/e2e/handshake`, public via PUBLIC_ROUTES — the MAC is the auth)
    // and the HTTP full tunnel (`/api/e2e`, behind the JWT gate). The tunnel
    // decrypts the phone's envelope and replays the REAL request against this
    // api over loopback, so every middleware applies to the inner request.
    this.app.use(
      '/api',
      createE2eRoutes(
        this.e2eSessionService,
        createLoopbackDispatch(
          () => `http://127.0.0.1:${DEV_BACKEND_PORT || VGIT_PORT}`,
          this.e2eInnerSecret
        )
      )
    );

    // Auth routes
    this.app.use(
      '/auth',
      createAuthRoutes(
        this.authService,
        this.connectionsService,
        (token) => this.setGlobalAuthToken(token),
        this.gitLocalService
      )
    );

    // rev12 Stop-on-PC (authed — the mobile app is the caller). Mounted before
    // the broad API router so its specific `/chat/:sessionId/stop-on-pc` path
    // resolves cleanly.
    if (this.stopOnPcService) {
      this.app.use('/api', createStopOnPcRoutes(this.stopOnPcService));
    }

    // API routes (also has /api/health for compatibility)
    this.app.use(
      '/api',
      createApiRoutes(
        this.authService,
        this.githubApiService,
        this.uploadService,
        this.gitLocalService,
        this.chatService,
        this.userSecretsService,
        this.tunnelService,
        this.claudeCodeSessions,
        this.connectionsService, // CRITICAL: Pass same instance used by GitHubApiService for event propagation
        this.claudeService,
        this.socketIOService,
        this.pushNotificationService, // Pass PushNotificationService for push notification endpoints
        this.sopService, // Pass SOPService for SOP progress in chat summarization
        this.storageService, // Pass StorageService for workspace file management
        this.localAiHelper, // Local-first one-shot AI helper (intent/suggestions/summary/project-name/voice)
        this.claudeOAuthService // Claude-account OAuth (login-from-phone, portable.dev#18)
      )
    );

    // Tunnel routes (internal API for user containers)
    // Only register if TunnelService is available
    if (this.tunnelService) {
      this.app.use(createTunnelRoutes(this.tunnelService));
      // Authed, user-facing tunnel API (mobile lazy dead-tunnel repair).
      this.app.use('/api', createTunnelApiRoutes(this.tunnelService, this.socketIOService));
      debugLog('Tunnel routes configured');
    }

    // Vibewaiting routes (game system - isolated under /vibewaiting)
    // This is kept separate for future extraction into separate backend
    // No authentication required - it's just a game!
    this.app.use('/vibewaiting', createVibewaitingRoutes(this.leaderboardService));
  }

  private setupStaticFiles(): void {
    // Local-first: the api is API + Socket.IO only and serves NO web bundle.
    // There is no static-file/SPA serving and no SPA index.html catch-all. The
    // mobile app (packages/mobile, Expo RN) is the only client.

    // JSON 404 for any unmatched route (no HTML fallback).
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Global error handler — must be the LAST middleware registered. Express 4
    // routes errors here when a handler throws synchronously or calls
    // next(err), so a single route failure returns a clean JSON 500 instead of
    // Express's default HTML stack page (and never leaks stacks in production).
    // Async handler rejections still surface via the process-level
    // unhandledRejection handler above.
    this.app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      console.error(`[Server] Unhandled route error on ${req.method} ${req.path}:`, err);
      // Report uncaught route errors to Sentry. Without this, a synchronous throw or
      // next(err) in any route returned a 500 but never reached Sentry.
      // No-op when Sentry is not initialized (SENTRY_DSN unset).
      if (Sentry.getClient()) {
        Sentry.captureException(err);
      }
      if (res.headersSent) {
        return;
      }
      res.status(err?.status || err?.statusCode || 500).json({
        error:
          NODE_ENV === 'production'
            ? 'Internal server error'
            : err?.message || 'Internal server error',
      });
    });
  }

  public async start(port: number = 65535): Promise<void> {
    // Optional bind host. The local-first launcher sets
    // API_BIND_HOST=127.0.0.1 so the api is reachable ONLY from loopback (the
    // PC's cloudflared tunnel is the single public ingress — threat model
    // "api binds localhost"). When unset (e.g. a bare `bun run dev`) we keep
    // Node's default of binding all interfaces.
    const bindHost = process.env.API_BIND_HOST?.trim();
    const onListening = () => {
      // Write backend start metadata on every server start (including hot reloads)
      this.writeBackendMetadata();

      // Calculate and log startup time (for monitoring and optimization)
      // Server started successfully
      console.log(
        `[Server] ✓ HTTP server listening on ${bindHost ? `${bindHost}:` : 'port '}${port}`
      );
      console.log(`[Server] ✓ Socket.IO ready for connections`);
    };

    // Start HTTP server
    if (bindHost) {
      this.server.listen(port, bindHost, onListening);
    } else {
      this.server.listen(port, onListening);
    }

    // Handle server errors (e.g., port already in use)
    this.server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`[Server] ✗ Port ${port} is already in use`);
        console.error(`[Server] Free the port and try again`);
      } else {
        console.error(`[Server] ✗ Server error:`, error);
      }
      process.exit(1);
    });

    // Global error handlers to prevent process crashes from Claude SDK errors
    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
      // Benign, expected filesystem errors leak here when a control-flow probe
      // (e.g. `fs.access(.../.git)` to test "is this repo cloned?") misses a
      // catch. They are never fatal — collapse them to a single warning instead
      // of the full crash banner, which previously made a transient ENOENT
      // before an auto-clone look like a server crash in the logs.
      const benignFsCodes = ['ENOENT', 'ENOTDIR', 'EEXIST', 'EACCES', 'EISDIR'];
      if (reason && typeof reason === 'object' && benignFsCodes.includes(reason.code)) {
        console.warn(
          `[Server] Ignored benign unhandled rejection (${reason.code} on ${reason.path ?? 'unknown path'}): ${reason.message ?? reason}`
        );
        return;
      }

      console.error('[Server] ========================================');
      console.error('[Server] ⚠️⚠️⚠️  UNHANDLED PROMISE REJECTION ⚠️⚠️⚠️');
      console.error('[Server] ========================================');
      console.error('[Server] Time:', new Date().toISOString());
      console.error('[Server] Reason:', reason);
      console.error('[Server] Promise:', promise);

      // Check if this is a ProcessTransport error from Claude SDK
      if (
        reason &&
        typeof reason.message === 'string' &&
        reason.message.includes('ProcessTransport')
      ) {
        console.error('[Server] ========================================');
        console.error('[Server] 🔥 This is a Claude SDK ProcessTransport error (subprocess died)');
        console.error('[Server] ========================================');
        console.error(
          '[Server] CRITICAL: Error escaped try-catch blocks - cleaning up ALL active sessions'
        );
        console.error('[Server] ========================================');

        // Layer 3: Targeted session cleanup — only clean sessions likely affected
        // Instead of nuking ALL sessions, identify which ones are stale/dead
        const activeSessions = this.claudeService.getAllActiveSessions();
        console.error(
          `[Server] Found ${activeSessions.length} active session(s), checking for affected ones`
        );

        let cleanedCount = 0;
        for (const sessionInfo of activeSessions) {
          const { chatId, userId } = sessionInfo;

          try {
            const session = this.claudeService.getSession(chatId);
            if (!session) {
              console.error(`[Server] Session ${chatId} not found in map`);
              continue;
            }

            // Only clean up sessions that are likely affected:
            // 1. isProcessing=true but lastActivityAt is stale (>30s no output)
            // 2. inputQueue has blocked waiters AND queue is closed (dead subprocess)
            // 3. signal already stopped (zombie session)
            const isStaleProcessing =
              session.isProcessing &&
              session.lastActivityAt &&
              Date.now() - session.lastActivityAt > 30_000;

            const hasBlockedWaitersOnClosedQueue =
              session.inputQueue?.waitersCount() > 0 && session.inputQueue?.isClosed();

            const isZombie = session.signal.stopped && session.isProcessing;

            const isLikelyAffected =
              isStaleProcessing || hasBlockedWaitersOnClosedQueue || isZombie;

            if (!isLikelyAffected) {
              console.error(`[Server] Session ${chatId} appears healthy - skipping cleanup`);
              continue;
            }

            console.error(`[Server] Cleaning up affected session: ${chatId} (user: ${userId})`);
            console.error(
              `[Server]   staleProcessing=${isStaleProcessing}, blockedWaiters=${hasBlockedWaitersOnClosedQueue}, zombie=${isZombie}`
            );
            cleanedCount++;

            // Abort input queue (rejects blocked waiters immediately)
            if (session.inputQueue) {
              session.inputQueue.abort();
              console.error(`[Server] ✓ Aborted inputQueue for ${chatId}`);
            }

            // Mark session as stopped
            session.signal.stopped = true;
            session.query = null;
            session.isProcessing = false;

            // Send error notification to the client via Socket.IO
            this.socketIOService.broadcastToRoom(chatId, 'agent_error', {
              chat_id: chatId,
              error: {
                title: 'Session Disconnected',
                message:
                  'The AI session timed out after being idle. Your conversation will continue when you send a new message.',
                action: 'Please send your message again to resume.',
                canRetry: true,
              },
            });

            // Update chat status to error
            this.socketIOService.broadcastToRoom(chatId, 'chat_status_update', {
              chat_id: chatId,
              status: 'error',
            });

            // Persist error to database using stored authToken
            const authToken = session.authToken;
            if (authToken) {
              this.chatService.updateChatStatus(chatId, userId, 'error', authToken);
              this.chatService.bufferMessage(
                userId,
                chatId,
                'error_message',
                {
                  content:
                    '⚠️ Session disconnected due to inactivity. Send a new message to continue.',
                  timestamp: Date.now(),
                },
                authToken
              );
              console.error(`[Server] ✓ Persisted error to database for ${chatId}`);
            } else {
              console.error(
                `[Server] ⚠️ No authToken in session ${chatId} - error not persisted to database`
              );
            }

            console.error(`[Server] ✓ Notified frontend and persisted error for ${chatId}`);
          } catch (cleanupError) {
            console.error(`[Server] Error during cleanup of ${chatId}:`, cleanupError);
          }
        }

        console.error(`[Server] Cleaned up ${cleanedCount} of ${activeSessions.length} sessions`);

        console.error('[Server] ========================================');
        console.error('[Server] Session cleanup complete - NOT CRASHING');
        console.error('[Server] User can retry by sending a new message');
        console.error('[Server] ========================================');
        // Don't crash - error is now handled
      } else {
        // Log other unhandled rejections but don't crash
        console.error('[Server] Unhandled rejection details:', {
          name: reason?.name,
          message: reason?.message,
          stack: reason?.stack,
        });
        console.error('[Server] ========================================');
      }
    });

    // Circuit-breaker state for uncaught exceptions (see handler below).
    let recentUncaughtCount = 0;
    let uncaughtWindowStart = 0;

    process.on('uncaughtException', (error: Error) => {
      console.error('[Server] ========================================');
      console.error('[Server] 💥💥💥  UNCAUGHT EXCEPTION 💥💥💥');
      console.error('[Server] ========================================');
      console.error('[Server] Time:', new Date().toISOString());
      console.error('[Server] Error:', error);
      console.error('[Server] Exception details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      // Check if this is a ProcessTransport error
      if (error.message && error.message.includes('ProcessTransport')) {
        console.error('[Server] ========================================');
        console.error('[Server] 🔥 This is a Claude SDK ProcessTransport error (subprocess died)');
        console.error('[Server] ========================================');
        console.error('[Server] The session will be cleaned up automatically');
        console.error('[Server] User can retry by sending a new message');
        console.error('[Server] NOT CRASHING - continuing operation');
        console.error('[Server] ========================================');
        // Don't crash - continue running
      } else {
        // A single stray throw used to kill the sandbox in production
        // (process.exit(1) → supervisor restart → the user's in-memory Claude
        // session is lost, which reads as a "crash"). That is too fragile for
        // one isolated error, so we now log and keep running — matching how the
        // ProcessTransport branch and development mode already behave.
        //
        // Circuit breaker: if exceptions storm (≥10 within 60s) the process is
        // likely in a corrupt state, so exit and let the supervisor restart it
        // cleanly rather than serve from a wedged process.
        const now = Date.now();
        if (now - uncaughtWindowStart > 60_000) {
          uncaughtWindowStart = now;
          recentUncaughtCount = 0;
        }
        recentUncaughtCount++;

        console.error('[Server] ========================================');
        console.error(
          `[Server] Non-fatal uncaught exception (${recentUncaughtCount} in last 60s) - continuing`
        );
        if (recentUncaughtCount >= 10) {
          console.error(
            '[Server] Too many uncaught exceptions in a short window - exiting for a clean restart'
          );
          console.error('[Server] ========================================');
          process.exit(1);
        }
        console.error('[Server] ========================================');
      }
    });

    // Graceful shutdown handlers
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);

      // Stop the idle session reaper
      if (this.sessionReaperService) {
        try {
          this.sessionReaperService.stop();
          console.log('[Server] Session reaper stopped');
        } catch (error) {
          console.error('[Server] Error stopping session reaper:', error);
        }
      }

      // Stop the host metrics collector
      if (this.hostMetricsService) {
        try {
          this.hostMetricsService.stop();
        } catch (error) {
          console.error('[Server] Error stopping host metrics service:', error);
        }
      }

      // Stop the transcript follower (clears its watchers + poll intervals)
      try {
        this.externalTranscriptFollower?.unfollowAll();
      } catch (error) {
        console.error('[Server] Error stopping transcript follower:', error);
      }

      // Close Socket.IO connections
      if (this.socketIOService) {
        try {
          await this.socketIOService.shutdown();
        } catch (error) {
          console.error('[Server] Error shutting down Socket.IO:', error);
        }
      }

      // Close HTTP server (stop accepting new connections)
      this.server.close(() => {});

      // Shutdown Tunnel service
      if (this.tunnelService) {
        try {
          await this.tunnelService.shutdown();
        } catch (error) {
          console.error('[Server] Error shutting down Tunnel service:', error);
        }
      }

      console.log('[Server] Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  private writeBackendMetadata(): void {
    try {
      // Get git info
      let gitCommit = 'unknown';
      let gitCommitShort = 'unknown';
      let gitBranch = 'unknown';
      let gitMessage = 'unknown';
      let gitAuthor = 'unknown';
      let gitDate = 'unknown';

      try {
        gitCommit = execSync('git rev-parse HEAD', {
          encoding: 'utf-8',
        }).trim();
        gitCommitShort = execSync('git rev-parse --short HEAD', {
          encoding: 'utf-8',
        }).trim();
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: 'utf-8',
        }).trim();
        gitMessage = execSync('git log -1 --pretty=%B', {
          encoding: 'utf-8',
        }).trim();
        gitAuthor = execSync('git log -1 --pretty=%an', {
          encoding: 'utf-8',
        }).trim();
        gitDate = execSync('git log -1 --pretty=%ci', {
          encoding: 'utf-8',
        }).trim();
      } catch (error) {
        // Ignore git errors
      }

      // Get file diff count
      let totalDiffs = 0;
      let unstagedFiles = 0;
      let stagedFiles = 0;

      try {
        const unstagedOutput = execSync('git diff --name-only', {
          encoding: 'utf-8',
        }).trim();
        const stagedOutput = execSync('git diff --cached --name-only', {
          encoding: 'utf-8',
        }).trim();

        unstagedFiles = unstagedOutput ? unstagedOutput.split('\n').length : 0;
        stagedFiles = stagedOutput ? stagedOutput.split('\n').length : 0;
        totalDiffs = unstagedFiles + stagedFiles;
      } catch (error) {
        // Ignore git errors
      }

      // Create metadata object
      const metadata = {
        package: 'backend',
        startTime: new Date().toISOString(),
        startTimestamp: Date.now(),
        git: {
          commit: gitCommit,
          commitShort: gitCommitShort,
          branch: gitBranch,
          message: gitMessage,
          author: gitAuthor,
          date: gitDate,
        },
        diffs: {
          total: totalDiffs,
          unstaged: unstagedFiles,
          staged: stagedFiles,
        },
      };

      // Write to repository root .build-metadata directory
      const repoRoot = path.join(__dirname, '../../..');
      const metadataDir = path.join(repoRoot, '.build-metadata');
      fs.mkdirSync(metadataDir, { recursive: true });

      const metadataPath = path.join(metadataDir, 'backend.json');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      console.log(`[Backend Metadata] ✓ Updated backend metadata`);
    } catch (error) {
      console.error('[Backend Metadata] Failed to write metadata:', error);
    }
  }

  public getApp(): express.Application {
    return this.app;
  }

  public getServer(): http.Server {
    return this.server;
  }
}

// Create and start server
const server = new Server();

// Initialize async components (database adapter, Redis session store) then start server
(async () => {
  try {
    await server.initialize();
    // In development: use DEV_BACKEND_PORT if set (calculated as VGIT_PORT + 1)
    // In production: DEV_BACKEND_PORT not set, use VGIT_PORT directly (65535)
    const serverPort = DEV_BACKEND_PORT || VGIT_PORT;
    await server.start(serverPort);
  } catch (error) {
    console.error('[Server] Failed to initialize:', error);
    process.exit(1);
  }
})();
