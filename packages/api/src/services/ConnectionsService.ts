import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { debugLog } from '@vgit2/shared/constants';
import * as constants from '@vgit2/shared/constants';
import { validateConnectionName, deriveConnectionId } from '@vgit2/shared/types';

import { ActiveGitHubConnectionCache } from './ActiveGitHubConnectionCache.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

import type { LocalGitHubAuthService } from './LocalGitHubAuthService.js';
import type { SecretsAdapter } from '../db/SecretsAdapter.js';
import type {
  ServiceConnection,
  ServiceConfig,
  AwsCredentials,
  FlyioCredentials,
  ModalCredentials,
  ApifyCredentials,
  SlackCredentials,
  GoogleDriveCredentials,
  GmailCredentials,
  GitHubAppCredentials,
  ConnectionAccountInfo,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
} from '@vgit2/shared/types';

/**
 * Result of checking for active GitHub connection
 */
export interface ActiveGitHubConnection {
  type: 'none' | 'oauth' | 'app';
  connection?: ServiceConnection;
  token?: string;
  /** ISO 8601 expiry of the token (GitHub App installation tokens only) */
  expiresAt?: string;
}

/**
 * ConnectionsService manages external service connections
 *
 * Responsibilities:
 * - Store/retrieve user connections via SecretsAdapter (abstracts storage backend)
 * - Provide service configurations (OAuth URLs, form fields, etc.)
 * - Setup CLI tool credentials (write config files)
 * - Validate and encrypt credentials
 * - Emit events when connections change (for reactive token management)
 *
 * Supports two types of integrations:
 * - SDK services: Slack, Linear, Notion, Google Drive (for code executors)
 * - CLI tools: AWS CLI, kubectl, Docker (write config files, use Bash)
 *
 * Uses SecretsAdapter pattern for pluggable storage:
 * - LocalSecretsAdapter: encrypts credentials at rest in the local store (local-first)
 *
 * Events:
 * - 'connection:updated' - Emitted when a connection is created or updated
 * - 'connection:deleted' - Emitted when a connection is deleted
 */
export class ConnectionsService extends EventEmitter {
  // Memoizes getActiveGitHubConnection so hot paths don't re-run the
  // sandbox → gateway → Clerk chain on every request.
  private githubConnCache = new ActiveGitHubConnectionCache();

  /**
   * Local-first GitHub access. When set AND in local mode, the active
   * GitHub connection is resolved from this on-device device-flow token instead of
   * the gateway/Clerk chain (no JWT claim, no github-app service).
   */
  private localGitHubAuthService?: LocalGitHubAuthService;

  constructor(
    private secretsAdapter: SecretsAdapter,
    private workspaceDir?: string,
    private githubAppClient?: any // GitHubAppClient for remote GitHub App service
  ) {
    super();
    debugLog('[ConnectionsService] Initialized with SecretsAdapter and EventEmitter');
    if (githubAppClient) {
      debugLog('[ConnectionsService] ✓ GitHubAppClient available for installation tokens');
    }
  }

  /**
   * Inject the local GitHub device-flow auth service. Set in local mode
   * by server.ts so `getActiveGitHubConnection` reads the on-device token. Mutates
   * the field (not a positional ctor arg) so existing callers are unaffected.
   */
  setLocalGitHubAuthService(service: LocalGitHubAuthService): void {
    this.localGitHubAuthService = service;
    debugLog('[ConnectionsService] ✓ LocalGitHubAuthService wired (local-first GitHub token)');
  }

  /**
   * Get all connections for a user
   */
  async getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]> {
    return this.secretsAdapter.getUserConnections(options);
  }

  /**
   * Get credentials for a specific connection by name
   * Returns null if not connected
   *
   * Delegates to SecretsAdapter which handles storage backend:
   * - LocalSecretsAdapter: reads from the local encrypted store
   */
  async getConnectionCredentials(options: GetConnectionOptions): Promise<any | null> {
    return this.secretsAdapter.getConnectionCredentials(options);
  }

  /**
   * Get full connection object by name
   */
  async getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null> {
    return this.secretsAdapter.getConnection(options);
  }

  /**
   * Get all connections for a specific service type
   * Example: Get all Slack connections (slack_default, company_slack, etc.)
   */
  async getConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.secretsAdapter.getConnectionsByService(options);
  }

  /**
   * Store a new connection (or update existing)
   */
  async storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
    // Validate connection ID
    const validation = validateConnectionName(options.connectionId);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Fetch account info if not already present
    let enhancedCredentials = options.credentials;
    if (enhancedCredentials && !enhancedCredentials.accountInfo) {
      try {
        // Create temporary connection for getConnectionAccountInfo
        const tempConnection: ServiceConnection = {
          id: '',
          userId: options.userId,
          connectionId: options.connectionId,
          displayName: options.displayName,
          service: options.service,
          serviceType: options.serviceType,
          credentials: options.credentials,
          connectedAt: new Date(),
          isActive: false,
        };

        const accountInfo = await this.getConnectionAccountInfo(tempConnection, {
          authToken: options.authToken,
        });
        if (accountInfo) {
          enhancedCredentials = {
            ...options.credentials,
            accountInfo,
            lastAccountInfoFetch: new Date().toISOString(),
          };
          debugLog(
            `[ConnectionsService] Fetched account info: ${accountInfo.username || accountInfo.email || accountInfo.displayName}`
          );
        }
      } catch (error: any) {
        console.warn(`[ConnectionsService] Failed to fetch account info:`, error.message);
        // Continue without account info - non-critical
      }
    }

    // Store connection via SecretsAdapter (handles storage backend)
    const connection = await this.secretsAdapter.storeConnection({
      ...options,
      credentials: enhancedCredentials,
    });

    if (options.service === 'github' || options.service === 'github-app') {
      this.invalidateActiveGitHubConnection(options.userId);
    }

    // Emit event for reactive token management
    const eventData = {
      userId: options.userId,
      service: options.service,
      connectionId: options.connectionId,
    };
    console.log(`[ConnectionsService] Emitting 'connection:updated' event:`, eventData);
    this.emit('connection:updated', eventData);

    return connection;
  }

  /**
   * Rename a connection - updates display name and derives new unique connection ID
   */
  async renameConnection(options: {
    userId: string;
    oldConnectionId: string;
    newDisplayName: string;
    authToken?: string;
  }): Promise<ServiceConnection> {
    const { userId, oldConnectionId, newDisplayName, authToken } = options;

    // Get the current connection to find its service
    const currentConnection = await this.secretsAdapter.getConnection({
      userId,
      connectionId: oldConnectionId,
      authToken,
    });

    if (!currentConnection) {
      throw new Error(`Connection ${oldConnectionId} not found`);
    }

    // Get all existing connection IDs for this user
    const allConnections = await this.secretsAdapter.getUserConnections({ userId, authToken });
    const existingIds = allConnections
      .filter((c: ServiceConnection) => c.connectionId !== oldConnectionId) // Exclude current connection
      .map((c: ServiceConnection) => c.connectionId);

    // Get all service names to avoid collisions
    const serviceNames = Object.keys(this.getAllServiceConfigs());

    // Combine existing IDs and service names to avoid all collisions
    const reservedNames = [...existingIds, ...serviceNames];

    // Derive unique connection ID from new display name
    const newConnectionId = deriveConnectionId(
      newDisplayName,
      currentConnection.service,
      reservedNames
    );

    // Validate new connection ID
    const validation = validateConnectionName(newConnectionId);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Update in database
    return this.secretsAdapter.renameConnection({
      userId,
      oldConnectionId,
      newConnectionId,
      newDisplayName,
      authToken,
    });
  }

  /**
   * Delete a connection by name
   */
  async deleteConnection(options: GetConnectionOptions): Promise<void> {
    // Look up the service BEFORE deleting — listeners (e.g. GitHubApiService)
    // filter on `service`, and the old payload omitted it, so the
    // 'connection:deleted' handler never matched.
    let service: string | undefined;
    try {
      const connection = await this.secretsAdapter.getConnection(options);
      service = connection?.service;
    } catch (error) {
      console.warn('[ConnectionsService] Failed to resolve service before delete:', error);
    }

    // Delete via SecretsAdapter
    await this.secretsAdapter.deleteConnection(options);

    // Invalidate when the deleted connection is GitHub-related — or when the
    // pre-delete lookup failed and we can't tell (safe: just drops a memo).
    if (!service || service === 'github' || service === 'github-app') {
      this.invalidateActiveGitHubConnection(options.userId);
    }

    // Emit event for reactive token management
    this.emit('connection:deleted', {
      userId: options.userId,
      service,
      connectionId: options.connectionId,
    });
  }

  /**
   * Check if user has a specific connection by name
   */
  async hasConnection(options: GetConnectionOptions): Promise<boolean> {
    return this.secretsAdapter.hasConnection(options);
  }

  /**
   * Get service configuration for UI rendering
   * Defines how to connect to each service (OAuth, API key, etc.)
   */
  getServiceConfig(service: string): ServiceConfig | null {
    const configs: Record<string, ServiceConfig> = {
      // ========================================================================
      // AUTO-CONNECTED SERVICES (Automatically created on login from JWT tokens)
      // ========================================================================

      github: {
        name: 'GitHub (OAuth)',
        service: 'github',
        type: 'cli',
        authType: 'oauth',
        icon: '/icons/github.svg',
        description: 'Version control and collaboration (OAuth)',
        longDescription:
          'GitHub integration via OAuth for repository management, issues, and pull requests. Grants broad access to all repositories you have permissions for.',
        docs: 'https://docs.github.com',
        domain: 'github.com',
        category: 'development',
        popular: true,
        enabled: true,
        isExclusive: false,
        secretMapping: {
          token: 'GITHUB_TOKEN',
        },
      },

      'github-app': {
        name: 'GitHub App',
        service: 'github-app',
        type: 'cli', // CLI type - uses GitHub API via Octokit (not SDK executor)
        authType: 'oauth', // OAuth-like flow - direct redirect to GitHub App installation
        icon: '/icons/github.svg',
        description: 'Fine-grained GitHub permissions',
        longDescription:
          'GitHub App integration with fine-grained, per-repository permissions. More secure than OAuth - you control exactly which repositories the app can access.',
        docs: 'https://docs.github.com/en/apps',
        domain: 'github.com',
        category: 'development',
        popular: true,
        enabled: true,
        isExclusive: false,
        customAuthUrl: `https://github.com/apps/${constants.GITHUB_APP_NAME || 'portable-dev'}/installations/new`,
        secretMapping: {
          // No direct secret mapping - token is generated dynamically
        },
      },

      // ========================================================================
      // SDK-BASED SERVICES (TypeScript/JavaScript npm packages for code execution)
      // ========================================================================

      slack: {
        name: 'Slack',
        service: 'slack',
        type: 'sdk',
        authType: 'oauth',
        icon: '/icons/slack.svg',
        description: 'Team messaging and collaboration',
        longDescription:
          'Connect Slack workspaces to enable AI-powered messaging, channel management, file sharing, and automated notifications across your teams.',
        docs: 'https://api.slack.com/',
        domain: 'slack.com',
        category: 'communication',
        popular: true,
        enabled: true,
        oauthConfig: {
          clientId: constants.SLACK_CLIENT_ID || '',
          // NOTE: clientSecret removed - OAuth handled by OAuth service, not exposed to sandbox
          scopes: ['chat:write', 'channels:read', 'files:write', 'users:read'],
          authorizeUrl: 'https://slack.com/oauth/v2/authorize',
          tokenUrl: 'https://slack.com/api/oauth.v2.access',
        },
        secretMapping: {
          token: 'SLACK_USER_TOKEN',
          teamId: 'SLACK_TEAM_ID',
        },
      },

      'google-drive': {
        name: 'Google Drive',
        service: 'google-drive',
        type: 'sdk',
        authType: 'oauth',
        icon: '/icons/google-drive.svg',
        description: 'Cloud file storage and sharing',
        longDescription:
          'Connect Google Drive to access, create, and edit files in Drive, Docs, Sheets, and Slides. Manage folders, share files, and collaborate on documents with AI assistance.',
        docs: 'https://developers.google.com/drive',
        domain: 'drive.google.com',
        category: 'storage',
        popular: true,
        enabled: true,
        secretMapping: {
          accessToken: 'GOOGLE_DRIVE_ACCESS_TOKEN',
          refreshToken: 'GOOGLE_DRIVE_REFRESH_TOKEN',
        },
      },

      gmail: {
        name: 'Gmail',
        service: 'gmail',
        type: 'sdk',
        authType: 'oauth',
        icon: '/icons/gmail.svg',
        description: 'Email and communication platform',
        longDescription:
          'Connect Gmail to send emails, read messages, manage labels, search conversations, and automate email workflows with AI assistance.',
        docs: 'https://developers.google.com/gmail/api',
        domain: 'https://cdn.simpleicons.org/gmail/EA4335',
        category: 'communication',
        popular: true,
        enabled: true,
        oauthConfig: {
          clientId: constants.GOOGLE_CLIENT_ID || '',
          // NOTE: clientSecret removed - OAuth handled by OAuth service, not exposed to sandbox
          scopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.labels',
          ],
          authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
        },
        secretMapping: {
          accessToken: 'GMAIL_ACCESS_TOKEN',
          refreshToken: 'GMAIL_REFRESH_TOKEN',
        },
      },

      apify: {
        name: 'Apify',
        service: 'apify',
        type: 'sdk',
        authType: 'api-key',
        icon: '/icons/apify.svg',
        description: 'Web scraping and automation platform',
        longDescription:
          'Connect Apify to run actors, scrape websites, automate web workflows, and extract structured data from any website. Access thousands of pre-built scrapers or build your own.',
        docs: 'https://docs.apify.com/api/v2',
        domain: 'apify.com',
        category: 'ai',
        popular: true,
        enabled: true,
        fields: [
          {
            name: 'apiToken',
            type: 'password',
            label: 'API Token',
            placeholder: 'apify_api_xxxxxxxxxxxxxxxx',
            required: true,
            helpText: 'Get your API token from https://console.apify.com/account/integrations',
          },
        ],
        secretMapping: {
          apiToken: 'APIFY_API_TOKEN',
        },
      },

      // ========================================================================
      // CLI-BASED TOOLS (Bash command-line tools, write config files)
      // ========================================================================

      'aws-cli': {
        name: 'AWS',
        service: 'aws-cli',
        type: 'cli',
        authType: 'api-key',
        icon: '/icons/aws.svg',
        description: 'Amazon Web Services cloud platform',
        longDescription:
          'Configure AWS CLI credentials to manage cloud infrastructure, deploy applications, and interact with AWS services like S3, EC2, Lambda, and more through the command line.',
        docs: 'https://console.aws.amazon.com/iam/home#/security_credentials',
        domain: 'aws.amazon.com',
        category: 'infrastructure',
        popular: true,
        enabled: true,
        isExclusive: true, // Only one AWS connection can be active at a time (writes to ~/.aws/credentials)
        fields: [
          {
            name: 'accessKeyId',
            type: 'text',
            label: 'Access Key ID',
            placeholder: 'AKIAIOSFODNN7EXAMPLE',
            required: true,
            helpText:
              'Get your credentials from https://console.aws.amazon.com/iam/home#/security_credentials or create a new access key in IAM',
          },
          {
            name: 'secretAccessKey',
            type: 'password',
            label: 'Secret Access Key',
            placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            required: true,
            helpText: 'Never share this key. It will be stored encrypted.',
          },
          {
            name: 'region',
            type: 'select',
            label: 'Default Region',
            required: true,
            default: 'us-east-1',
            options: [
              'us-east-1',
              'us-east-2',
              'us-west-1',
              'us-west-2',
              'eu-west-1',
              'eu-central-1',
              'ap-southeast-1',
              'ap-northeast-1',
            ],
            helpText: 'AWS region where your resources are located',
          },
        ],
        secretMapping: {
          accessKeyId: 'AWS_ACCESS_KEY_ID',
          secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
          region: 'AWS_REGION',
        },
      },

      'flyio-cli': {
        name: 'Fly.io',
        service: 'flyio-cli',
        type: 'cli',
        authType: 'oauth', // SSO-style authentication via flyctl
        icon: '/icons/flyio.svg',
        description: 'Serverless application platform',
        longDescription:
          "Connect Fly.io CLI to deploy and manage applications globally. Authenticate through Fly.io's web interface - no manual token copying required. Scale apps instantly, manage databases, and deploy to the edge with minimal configuration.",
        docs: 'https://fly.io/docs/flyctl/',
        domain: 'fly.io',
        category: 'infrastructure',
        popular: true,
        enabled: true,
        isExclusive: true, // Only one Fly.io connection can be active at a time (writes to ~/.fly/config.yml)
        // No fields - uses SSO-style authentication flow
        secretMapping: {
          apiToken: 'FLY_API_TOKEN',
        },
      },

      'modal-cli': {
        name: 'Modal',
        service: 'modal-cli',
        type: 'cli',
        authType: 'api-key',
        icon: '/icons/modal.svg',
        description: 'Serverless compute platform',
        longDescription:
          'Configure Modal CLI to run serverless Python functions, schedule jobs, and deploy web endpoints. Scale from zero to thousands of GPUs instantly.',
        docs: 'https://modal.com/settings/tokens',
        domain: 'modal.com',
        category: 'infrastructure',
        popular: true,
        enabled: true,
        fields: [
          {
            name: 'tokenId',
            type: 'text',
            label: 'Token ID',
            placeholder: 'ak-xxxxxxxxxxxxxxxx',
            required: true,
            helpText:
              'Get your credentials from https://modal.com/settings/tokens or run: modal token new',
          },
          {
            name: 'tokenSecret',
            type: 'password',
            label: 'Token Secret',
            placeholder: 'as-xxxxxxxxxxxxxxxx',
            required: true,
            helpText: 'Keep this secret safe. It will be stored encrypted.',
          },
          {
            name: 'profile',
            type: 'text',
            label: 'Profile Name (Optional)',
            placeholder: 'default',
            required: false,
            helpText:
              'Profile name helps distinguish between multiple Modal accounts (e.g., "personal", "work"). If not provided, "default" will be used.',
          },
        ],
        secretMapping: {
          tokenId: 'MODAL_TOKEN_ID',
          tokenSecret: 'MODAL_TOKEN_SECRET',
        },
      },
    };

    // Backward compatibility: redirect old service IDs to new CLI versions
    if (service === 'aws') return configs['aws-cli'];
    if (service === 'flyio') return configs['flyio-cli'];
    if (service === 'modal') return configs['modal-cli'];

    return configs[service] || null;
  }

  /**
   * Get all available service configurations
   * Includes disabled services (shown as "Coming Soon" in UI)
   */
  getAllServiceConfigs(): ServiceConfig[] {
    const services = [
      // Auto-connected services (created on login)
      'github',
      // SDK services (OAuth)
      'slack',
      'google-drive',
      'gmail',
      // GitHub App (fine-grained permissions)
      'github-app',
      // SDK services (API key)
      'apify',
      // CLI services (manual credentials)
      'aws-cli',
      'flyio-cli',
      'modal-cli',
    ];
    return services
      .map((s) => this.getServiceConfig(s))
      .filter((config): config is ServiceConfig => config !== null);
  }

  /**
   * Setup CLI tool credentials
   * Writes configuration files to user's workspace
   */
  async setupCliCredentials(userId: string, service: string, credentials: any): Promise<void> {
    if (!this.workspaceDir) {
      throw new Error('Workspace directory not configured');
    }

    const userWorkspace = path.join(this.workspaceDir, userId);

    switch (service) {
      case 'aws-cli':
      case 'aws': // Backward compatibility
        await this.setupAwsCli(userWorkspace, credentials as AwsCredentials);
        break;
      case 'flyio-cli':
      case 'flyio': // Backward compatibility
        await this.setupFlyio(userWorkspace, credentials as FlyioCredentials);
        break;
      case 'modal-cli':
      case 'modal': // Backward compatibility
        await this.setupModal(userWorkspace, credentials as ModalCredentials);
        break;
      default:
        throw new Error(`CLI setup not implemented for service: ${service}`);
    }

    debugLog(`[ConnectionsService] Setup CLI credentials for ${service}`);
  }

  /**
   * Setup AWS CLI credentials
   * @param _userWorkspace - Unused (kept for interface consistency). AWS CLI writes to ~/.aws/
   * @param credentials - AWS API credentials
   */
  private async setupAwsCli(_userWorkspace: string, credentials: AwsCredentials): Promise<void> {
    // IMPORTANT: Install/verify CLI BEFORE writing credentials
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Check if aws is already installed
    let isInstalled = false;
    try {
      await execAsync('aws --version');
      debugLog('[ConnectionsService] AWS CLI already installed');
      isInstalled = true;
    } catch {
      // AWS CLI not installed, try to install it via pip3 or pip
      debugLog('[ConnectionsService] AWS CLI not found, installing...');
      try {
        // Try pip3 first, then pip as fallback
        try {
          await execAsync('pip3 install --upgrade awscli');
        } catch {
          await execAsync('pip install --upgrade awscli');
        }

        // Verify installation succeeded
        await execAsync('aws --version');
        debugLog('[ConnectionsService] AWS CLI installed successfully');
        isInstalled = true;
      } catch (installError: any) {
        debugLog(`[ConnectionsService] Failed to install AWS CLI: ${installError.message}`);
        throw new Error(
          'Failed to install AWS CLI. Please ensure pip3 or pip is available and try again, or install AWS CLI manually: pip3 install awscli'
        );
      }
    }

    if (!isInstalled) {
      throw new Error('AWS CLI is not available. Please install it manually: pip install awscli');
    }

    // CLI is installed, now write credentials to ~/.aws/ (standard location)
    const awsDir = path.join(os.homedir(), '.aws');
    await fs.mkdir(awsDir, { recursive: true });

    // Write credentials file
    const credentialsContent = `[default]
aws_access_key_id = ${credentials.accessKeyId}
aws_secret_access_key = ${credentials.secretAccessKey}
`;
    await fs.writeFile(
      path.join(awsDir, 'credentials'),
      credentialsContent,
      { mode: 0o600 } // Read/write for owner only
    );

    // Write config file
    const configContent = `[default]
region = ${credentials.region}
output = json
`;
    await fs.writeFile(path.join(awsDir, 'config'), configContent, { mode: 0o600 });

    debugLog('[ConnectionsService] AWS CLI credentials written to ~/.aws/');
  }

  /**
   * Setup Fly.io CLI credentials
   */
  private async setupFlyio(userWorkspace: string, credentials: FlyioCredentials): Promise<void> {
    // IMPORTANT: Install/verify CLI BEFORE writing credentials
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Check if flyctl is already installed
    let isInstalled = false;
    try {
      await execAsync('flyctl version');
      debugLog('[ConnectionsService] Fly.io CLI already installed');
      isInstalled = true;
    } catch {
      // Fly.io CLI not installed, try to install it
      debugLog('[ConnectionsService] Fly.io CLI not found, installing...');
      try {
        // Install flyctl based on platform
        const platform = os.platform();
        if (platform === 'darwin' || platform === 'linux') {
          // Use official install script for macOS/Linux
          await execAsync('curl -L https://fly.io/install.sh | sh');
        } else {
          // For Windows or other platforms, use PowerShell install (if available)
          await execAsync('iwr https://fly.io/install.ps1 -useb | iex');
        }

        // Verify installation succeeded
        await execAsync('flyctl version');
        debugLog('[ConnectionsService] Fly.io CLI installed successfully');
        isInstalled = true;
      } catch (installError: any) {
        debugLog(`[ConnectionsService] Failed to install Fly.io CLI: ${installError.message}`);
        throw new Error(
          'Failed to install Fly.io CLI. Please install it manually from: https://fly.io/docs/hands-on/install-flyctl/'
        );
      }
    }

    if (!isInstalled) {
      throw new Error(
        'Fly.io CLI is not available. Please install it manually from: https://fly.io/docs/hands-on/install-flyctl/'
      );
    }

    // CLI is installed, now write credentials
    // Fly.io uses SSO-style authentication - flyctl writes to ~/.fly/config.yml
    // We update the same file to ensure consistency
    const flyDir = path.join(os.homedir(), '.fly');
    await fs.mkdir(flyDir, { recursive: true });

    // Write Fly.io config.yml file (YAML format to match flyctl)
    const configContent = `access_token: ${credentials.apiToken}\n`;

    await fs.writeFile(
      path.join(flyDir, 'config.yml'),
      configContent,
      { mode: 0o600 } // Read/write for owner only
    );

    debugLog('[ConnectionsService] Fly.io CLI credentials written to ~/.fly/config.yml');
  }

  /**
   * Setup Modal CLI credentials
   * @param _userWorkspace - Unused (kept for interface consistency). Modal token set writes to ~/.modal/
   * @param credentials - Modal API credentials
   */
  private async setupModal(_userWorkspace: string, credentials: ModalCredentials): Promise<void> {
    // IMPORTANT: Install/verify CLI BEFORE writing credentials
    // If CLI installation fails, connection should fail
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Check if modal is already installed
    let isInstalled = false;
    try {
      await execAsync('modal --version');
      debugLog('[ConnectionsService] Modal CLI already installed');
      isInstalled = true;
    } catch {
      // Modal not installed, try to install it via pip3 or pip
      debugLog('[ConnectionsService] Modal CLI not found, installing...');
      try {
        // Try pip3 first, then pip as fallback
        try {
          await execAsync('pip3 install --upgrade modal');
        } catch {
          await execAsync('pip install --upgrade modal');
        }

        // Verify installation succeeded
        await execAsync('modal --version');
        debugLog('[ConnectionsService] Modal CLI installed successfully');
        isInstalled = true;
      } catch (installError: any) {
        debugLog(`[ConnectionsService] Failed to install Modal CLI: ${installError.message}`);
        throw new Error(
          'Failed to install Modal CLI. Please ensure pip3 or pip is available and try again, or install Modal manually with: pip3 install modal'
        );
      }
    }

    if (!isInstalled) {
      throw new Error(
        'Modal CLI is not available. Please install it manually with: pip install modal'
      );
    }

    // CLI is installed, now set credentials using modal token set command
    // Use profile name or default to 'default'
    const profile = credentials.profile || 'default';

    // Use the modal token set command to configure credentials
    // This is the proper way to authenticate with Modal
    const tokenSetCommand = `modal token set --token-id ${credentials.tokenId} --token-secret ${credentials.tokenSecret} --profile=${profile}`;

    try {
      await execAsync(tokenSetCommand);
      debugLog(
        `[ConnectionsService] Modal CLI credentials set successfully for profile: ${profile}`
      );
    } catch (error: any) {
      debugLog(`[ConnectionsService] Failed to set Modal token: ${error.message}`);
      throw new Error(
        `Failed to set Modal token. Error: ${error.message}. Please verify your token ID and secret are correct.`
      );
    }
  }

  /**
   * Extract secret keys from a connection's credentials
   * Returns array of environment variable names (not values!)
   *
   * This is used to display connection-sourced secrets in the secrets table
   * without exposing the actual credential values.
   *
   * Uses the declarative secretMapping from ServiceConfig to map
   * credential fields to environment variable names.
   *
   * @deprecated Use extractSecretKeysFromCredentials instead. This method always
   * returns empty array since credentials are now stored in Clerk, not in the connection object.
   * @param _connection - The service connection object (unused)
   * @returns Array of secret key names (always empty - credentials stored in Clerk)
   */
  extractSecretKeys(_connection: ServiceConnection): string[] {
    // Credentials are now stored in Clerk, not in the connection object
    // This method is kept for backward compatibility but returns empty array
    // Use getConnectionSecrets() which fetches credentials from Clerk
    return [];
  }

  /**
   * Get all connection-sourced secrets for a user
   * Returns secrets from all connections as Secret[] format
   * Used to display connection secrets in the secrets table
   *
   * @param userId - User identifier
   * @param authToken - Optional JWT auth token
   * @returns Array of Secret objects with source='connection'
   */
  async getConnectionSecrets(
    userId: string,
    authToken?: string
  ): Promise<
    Array<{
      key: string;
      source: 'connection';
      sourceConnectionId: string;
      displayName: string;
      service: string;
    }>
  > {
    const connections = await this.getUserConnections({ userId, authToken });
    const secrets: Array<{
      key: string;
      source: 'connection';
      sourceConnectionId: string;
      displayName: string;
      service: string;
    }> = [];

    for (const connection of connections) {
      // Fetch credentials from Clerk for each connection
      const credentials = await this.getConnectionCredentials({
        userId,
        connectionId: connection.connectionId,
        authToken,
      });
      const keys = this.extractSecretKeysFromCredentials(connection.service, credentials);
      for (const key of keys) {
        secrets.push({
          key,
          source: 'connection',
          sourceConnectionId: connection.connectionId,
          displayName: connection.displayName,
          service: connection.service,
        });
      }
    }

    return secrets;
  }

  /**
   * Extract secret keys from credentials object
   * Helper method that works with credentials fetched from Clerk
   */
  private extractSecretKeysFromCredentials(service: string, credentials: any): string[] {
    const config = this.getServiceConfig(service);

    if (!config?.secretMapping || !credentials) {
      return [];
    }

    // Extract env var names for credential fields that exist
    const keys: string[] = [];
    for (const [credentialField, envVarName] of Object.entries(config.secretMapping)) {
      if (credentials[credentialField] !== undefined && credentials[credentialField] !== null) {
        keys.push(envVarName);
      }
    }

    return keys;
  }

  /**
   * Get connection account information
   * Fetches account details from the service API to show which account this connection uses
   * Credentials are fetched from Clerk (single source of truth).
   */
  async getConnectionAccountInfo(
    connection: ServiceConnection,
    options?: { forceRefresh?: boolean; authToken?: string }
  ): Promise<ConnectionAccountInfo | null> {
    // Fetch credentials from Clerk (single source of truth)
    const credentials = await this.getConnectionCredentials({
      userId: connection.userId,
      connectionId: connection.connectionId,
      authToken: options?.authToken,
    });

    // Check cache (24 hour TTL)
    if (!options?.forceRefresh && credentials?.accountInfo && credentials?.lastAccountInfoFetch) {
      const lastFetch = new Date(credentials.lastAccountInfoFetch);
      const ageHours = (Date.now() - lastFetch.getTime()) / (1000 * 60 * 60);

      if (ageHours < 24) {
        debugLog(
          `[ConnectionsService] Using cached account info for ${connection.service} (age: ${ageHours.toFixed(1)}h)`
        );
        return credentials.accountInfo;
      }
    }

    debugLog(`[ConnectionsService] Fetching account info for ${connection.service}...`);

    if (!credentials) {
      debugLog(
        `[ConnectionsService] No credentials found for ${connection.connectionId}, cannot fetch account info`
      );
      return null;
    }

    try {
      switch (connection.service) {
        case 'slack':
          return this.getSlackAccountInfo(credentials as SlackCredentials);
        case 'google-drive':
        case 'gmail':
          return await this.getGoogleAccountInfo(credentials as GoogleDriveCredentials);
        case 'github':
          return await this.getGitHubAccountInfo(credentials.token);
        case 'github-app':
          // GitHub App already has account info
          return {
            service: 'github-app',
            username: credentials.accountLogin,
            displayName: credentials.accountLogin,
            metadata: {
              accountType: credentials.accountType,
              repositorySelection: credentials.repositorySelection,
            },
          };
        case 'aws-cli':
          return await this.getAwsAccountInfo(credentials as AwsCredentials);
        case 'flyio-cli':
          return await this.getFlyioAccountInfo(credentials as FlyioCredentials);
        case 'modal-cli':
          return this.getModalAccountInfo(credentials as ModalCredentials);
        case 'apify':
          return await this.getApifyAccountInfo(credentials as ApifyCredentials);
        default:
          debugLog(
            `[ConnectionsService] No account info implementation for service: ${connection.service}`
          );
          return null;
      }
    } catch (error: any) {
      console.error(
        `[ConnectionsService] Failed to fetch account info for ${connection.service}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * Get Slack account info (from stored credentials)
   */
  private getSlackAccountInfo(credentials: SlackCredentials): ConnectionAccountInfo {
    return {
      service: 'slack',
      displayName: credentials.teamName,
      accountId: credentials.userId,
      metadata: {
        teamId: credentials.teamId,
        teamName: credentials.teamName,
      },
    };
  }

  /**
   * Get Google account info (from Google OAuth2 API)
   */
  private async getGoogleAccountInfo(
    credentials: GoogleDriveCredentials | GmailCredentials
  ): Promise<ConnectionAccountInfo> {
    const response = await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = (await response.json()) as any;
    return {
      service: 'google',
      email: data.email,
      displayName: data.name,
      avatarUrl: data.picture,
      accountId: data.id,
    };
  }

  /**
   * Get GitHub account info (from GitHub API)
   */
  private async getGitHubAccountInfo(token: string): Promise<ConnectionAccountInfo> {
    // 30s timeout: this runs during connection creation/validation; native fetch
    // never times out, so an offline GitHub would hang the connection flow.
    const response = await fetchWithTimeout('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as any;
    return {
      service: 'github',
      username: data.login,
      email: data.email,
      displayName: data.name,
      avatarUrl: data.avatar_url,
      accountId: data.id.toString(),
    };
  }

  /**
   * Get AWS account info (region only - no easy account API without SDK)
   */
  private async getAwsAccountInfo(credentials: AwsCredentials): Promise<ConnectionAccountInfo> {
    // AWS doesn't provide easy user info without AWS SDK
    // Could use STS GetCallerIdentity, but requires full SDK setup
    return {
      service: 'aws-cli',
      metadata: { region: credentials.region },
    };
  }

  /**
   * Get Fly.io account info (from Fly.io GraphQL API)
   */
  private async getFlyioAccountInfo(credentials: FlyioCredentials): Promise<ConnectionAccountInfo> {
    const response = await fetchWithTimeout('https://api.fly.io/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '{ viewer { email name username } }',
      }),
    });

    if (!response.ok) {
      throw new Error(`Fly.io API error: ${response.status}`);
    }

    const data = (await response.json()) as any;
    const viewer = data.data?.viewer;

    return {
      service: 'flyio-cli',
      username: viewer?.username,
      email: viewer?.email,
      displayName: viewer?.name,
    };
  }

  /**
   * Get Modal account info (from profile name)
   */
  private getModalAccountInfo(credentials: ModalCredentials): ConnectionAccountInfo {
    return {
      service: 'modal-cli',
      displayName: credentials.profile || 'default',
      metadata: { profile: credentials.profile },
    };
  }

  /**
   * Get Apify account info (from Apify API)
   */
  private async getApifyAccountInfo(credentials: ApifyCredentials): Promise<ConnectionAccountInfo> {
    const response = await fetchWithTimeout('https://api.apify.com/v2/users/me', {
      headers: {
        Authorization: `Bearer ${credentials.apiToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Apify API error: ${response.status}`);
    }

    const result = (await response.json()) as any;
    const data = result.data;

    return {
      service: 'apify',
      username: data?.username,
      email: data?.email,
      accountId: data?.id,
    };
  }

  // ============================================================================
  // GITHUB APP METHODS
  // ============================================================================

  /**
   * Get an installation access token from GitHub
   * Uses the remote GitHub App service to request a token for a specific installation.
   *
   * SECURITY: Requires remote GitHub App service. Private key is never in user sandbox.
   *
   * @param installationId - The GitHub App installation ID
   * @returns Installation access token and expiration
   * @throws Error if GitHub App service is not configured
   */
  async getGitHubAppInstallationToken(installationId: number): Promise<{
    token: string;
    expiresAt: string;
    permissions: Record<string, string>;
    repositorySelection: string;
  }> {
    if (!this.githubAppClient) {
      throw new Error(
        'GitHub App service not configured. Set GITHUB_APP_SERVICE_URL to enable GitHub App features.'
      );
    }

    debugLog('[ConnectionsService] Using remote GitHub App service for token generation');
    const tokenData = await this.githubAppClient.createInstallationToken(installationId);

    // TODO: Remote service should return permissions and repositorySelection
    // For now, return with empty defaults (will be populated on first use)
    return {
      token: tokenData.token,
      expiresAt: tokenData.expiresAt,
      permissions: {},
      repositorySelection: 'all',
    };
  }

  /**
   * Get a valid GitHub App token for a connection
   * Uses cached token if still valid (5-min buffer), otherwise refreshes.
   *
   * @param connectionId - The connection ID
   * @param userId - The user ID
   * @param authToken - Optional JWT auth token
   * @returns Valid installation access token and its expiry (ISO 8601)
   */
  async getGitHubAppToken(
    connectionId: string,
    userId: string,
    authToken?: string
  ): Promise<{ token: string; expiresAt?: string }> {
    const connection = await this.getConnection({ userId, connectionId, authToken });

    if (!connection) {
      throw new Error(`GitHub App connection not found: ${connectionId}`);
    }

    if (connection.service !== 'github-app') {
      throw new Error(`Connection ${connectionId} is not a GitHub App connection`);
    }

    // Fetch credentials from Clerk (single source of truth)
    const credentials = (await this.getConnectionCredentials({
      userId,
      connectionId,
      authToken,
    })) as GitHubAppCredentials | null;

    if (!credentials) {
      throw new Error(`Credentials not found for GitHub App connection: ${connectionId}`);
    }

    // Check if cached token is still valid (with 5-min buffer)
    if (credentials.cachedToken && credentials.cachedTokenExpiresAt) {
      const expiresAt = new Date(credentials.cachedTokenExpiresAt);
      const now = new Date();
      const bufferMs = 5 * 60 * 1000; // 5 minutes

      if (expiresAt.getTime() - now.getTime() > bufferMs) {
        debugLog('[ConnectionsService] Using cached GitHub App token');
        return { token: credentials.cachedToken, expiresAt: credentials.cachedTokenExpiresAt };
      }
    }

    // Refresh the token
    debugLog('[ConnectionsService] Refreshing GitHub App token');
    const newToken = await this.getGitHubAppInstallationToken(credentials.installationId);

    // Update the connection with new cached token
    const updatedCredentials: GitHubAppCredentials = {
      ...credentials,
      cachedToken: newToken.token,
      cachedTokenExpiresAt: newToken.expiresAt,
    };

    // Persist via the adapter DIRECTLY, not this.storeConnection: a pure token
    // refresh must not run the account-info network fetch (GitHubAppCredentials
    // never carry accountInfo, so it fired on EVERY ~55-min refresh) nor emit
    // 'connection:updated' (which triggered GitHubApiService.loadTokenForUser →
    // another full gateway→Clerk round trip).
    await this.secretsAdapter.storeConnection({
      userId,
      connectionId,
      displayName: connection.displayName,
      service: 'github-app',
      serviceType: 'sdk',
      credentials: updatedCredentials,
      authToken,
    });

    return { token: newToken.token, expiresAt: newToken.expiresAt };
  }

  /**
   * Create a GitHub App connection from installation data
   *
   * SECURITY: Requires remote GitHub App service. Private key is never in user sandbox.
   *
   * @param userId - User ID
   * @param installationId - GitHub App installation ID
   * @param authToken - Optional JWT auth token
   * @returns Created connection
   * @throws Error if GitHub App service is not configured
   */
  async createGitHubAppConnection(
    userId: string,
    installationId: number,
    authToken?: string
  ): Promise<ServiceConnection> {
    if (!this.githubAppClient) {
      throw new Error(
        'GitHub App service not configured. Set GITHUB_APP_SERVICE_URL to enable GitHub App features.'
      );
    }

    debugLog('[ConnectionsService] Using remote GitHub App service for installation validation');
    const validation = await this.githubAppClient.validateInstallation(installationId);

    if (!validation.isValid || !validation.account) {
      throw new Error(`Invalid GitHub App installation: ${installationId}`);
    }

    // Build installation object from validation response
    const installation = {
      account: {
        login: validation.account.login,
        type: validation.account.type,
      },
      repository_selection: 'all' as const, // Default, actual value retrieved with first token
      permissions: {}, // Default, actual value retrieved with first token
    };

    // Get initial access token
    const tokenData = await this.getGitHubAppInstallationToken(installationId);

    // Create credentials
    const credentials: GitHubAppCredentials = {
      installationId,
      accountType: installation.account.type === 'Organization' ? 'Organization' : 'User',
      accountLogin: installation.account.login,
      repositorySelection: installation.repository_selection || 'all',
      permissions: installation.permissions || {},
      cachedToken: tokenData.token,
      cachedTokenExpiresAt: tokenData.expiresAt,
    };

    // Generate unique connection ID
    const existingConnections = await this.getUserConnections({ userId, authToken });
    const existingIds = existingConnections.map((c) => c.connectionId);
    const serviceNames = Object.keys(this.getAllServiceConfigs());
    const connectionId = deriveConnectionId(installation.account.login, 'github-app', [
      ...existingIds,
      ...serviceNames,
    ]);

    // Create display name
    const displayName = `GitHub App (${installation.account.login})`;

    // Store the connection
    const connection = await this.storeConnection({
      userId,
      connectionId,
      displayName,
      service: 'github-app',
      serviceType: 'sdk',
      credentials,
      authToken,
    });

    // Auto-activate this connection (mark as active for GitHub access)
    await this.setActiveGitHubConnection(userId, connectionId, authToken);

    debugLog(
      `[ConnectionsService] Created GitHub App connection: ${connectionId} for ${installation.account.login}`
    );

    return connection;
  }

  /**
   * Get the active GitHub connection for a user (memoized).
   * Checks for active GitHub App first, then falls back to OAuth.
   *
   * Results are cached per-user by ActiveGitHubConnectionCache (oauth: 12-min
   * soft TTL; app: token expiry minus 5-min buffer; none: 45s negative cache
   * when authToken present). Mutations invalidate inline via
   * invalidateActiveGitHubConnection().
   *
   * @param userId - User ID
   * @param authToken - Optional JWT auth token
   * @returns Active GitHub connection info
   */
  async getActiveGitHubConnection(
    userId: string,
    authToken?: string
  ): Promise<ActiveGitHubConnection> {
    return this.githubConnCache.get(
      userId,
      () => this.fetchActiveGitHubConnection(userId, authToken),
      { hasAuthToken: !!authToken }
    );
  }

  /**
   * Drop the memoized active GitHub connection for a user. Called inline by
   * storeConnection/deleteConnection/setActiveGitHubConnection and by
   * GitHubApiService.clearTokenCache after a hard 401.
   */
  invalidateActiveGitHubConnection(userId: string): void {
    this.githubConnCache.invalidate(userId);
  }

  /**
   * Uncached lookup of the active GitHub connection — the real
   * sandbox → gateway → Clerk chain. Only ActiveGitHubConnectionCache calls this.
   */
  private async fetchActiveGitHubConnection(
    userId: string,
    authToken?: string
  ): Promise<ActiveGitHubConnection> {
    // Local-first: in local mode the GitHub token is the user's OWN,
    // obtained on-device via the OAuth device flow and held in the local encrypted
    // store — never a JWT claim, never the github-app service. Short-circuit before
    // the gateway/Clerk chain so GitHubApiService (Octokit), the scope checks, and
    // the git commit-author setup all read this token. No token → 'none' surfaces the
    // "connect GitHub" state (AC3).
    if (this.localGitHubAuthService) {
      const token = this.localGitHubAuthService.getToken();
      if (!token) {
        return { type: 'none' };
      }
      const status = this.localGitHubAuthService.getConnectionStatus();
      const syntheticConnection: ServiceConnection = {
        id: 'local-github',
        userId,
        connectionId: 'github_1',
        displayName: status.login ? `GitHub (${status.login})` : 'GitHub',
        service: 'github',
        serviceType: 'cli',
        credentials: {}, // Token lives in the local encrypted store, not in the row.
        isActive: true,
        connectedAt: new Date(),
      };
      return { type: 'oauth', connection: syntheticConnection, token };
    }

    // console.log(`[ConnectionsService] getActiveGitHubConnection for ${userId}`);
    const connections = await this.getUserConnections({ userId, authToken });
    // console.log(
    //   `[ConnectionsService] Found ${connections.length} connections:`,
    //   connections.map((c) => ({
    //     service: c.service,
    //     connectionId: c.connectionId,
    //     isActive: c.isActive,
    //   }))
    // );

    // First, check for active GitHub App connection
    const activeGitHubApp = connections.find((c) => c.service === 'github-app' && c.isActive);

    if (activeGitHubApp) {
      try {
        const { token, expiresAt } = await this.getGitHubAppToken(
          activeGitHubApp.connectionId,
          userId,
          authToken
        );
        return {
          type: 'app',
          connection: activeGitHubApp,
          token,
          expiresAt,
        };
      } catch (error) {
        console.error('[ConnectionsService] Failed to get GitHub App token:', error);
        // Fall through to check OAuth
      }
    }

    // Check for OAuth connection (github service)
    const oauthConnection = connections.find((c) => c.service === 'github');
    // console.log(
    //   `[ConnectionsService] OAuth connection found:`,
    //   oauthConnection
    //     ? { connectionId: oauthConnection.connectionId, isActive: oauthConnection.isActive }
    //     : 'none'
    // );

    if (oauthConnection) {
      // Fetch credentials from Clerk (single source of truth)
      // console.log(
      //   `[ConnectionsService] Fetching credentials for connectionId: ${oauthConnection.connectionId}`
      // );
      const credentials = await this.getConnectionCredentials({
        userId,
        connectionId: oauthConnection.connectionId,
        authToken,
      });
      if (credentials?.token) {
        return {
          type: 'oauth',
          connection: oauthConnection,
          token: credentials.token,
        };
      }
    }

    // No active GitHub connection
    console.log(`[ConnectionsService] No active GitHub connection found for ${userId}`);
    return { type: 'none' };
  }

  /**
   * Setup GitHub CLI (gh) with the given token
   * Authenticates gh CLI so commands like 'gh pr create' work
   * Non-blocking - logs warnings if configuration fails
   *
   * @param token - GitHub OAuth or App token
   */
  private async setupGitHubCli(token: string): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check if gh CLI is installed
      try {
        await execAsync('gh --version');
      } catch {
        debugLog('[ConnectionsService] gh CLI not installed, skipping auto-configuration');
        return;
      }

      debugLog('[ConnectionsService] Configuring gh CLI with active GitHub token...');

      // Authenticate gh CLI with token
      const command = `echo '${token}' | gh auth login --with-token`;
      await execAsync(command);

      // Verify authentication
      const { stdout } = await execAsync('gh auth status');
      debugLog('[ConnectionsService] ✓ gh CLI configured successfully');
      debugLog(`[ConnectionsService] gh CLI status: ${stdout.trim().split('\n')[0]}`);
    } catch (error) {
      console.warn(
        '[ConnectionsService] ⚠️ WARNING: Failed to configure gh CLI (non-critical):',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Set a GitHub connection as the active one
   * Deactivates any other GitHub connections.
   *
   * @param userId - User ID
   * @param connectionId - Connection ID to activate
   * @param authToken - Optional JWT auth token
   */
  async setActiveGitHubConnection(
    userId: string,
    connectionId: string,
    authToken?: string
  ): Promise<void> {
    const connections = await this.getUserConnections({ userId, authToken });

    // Special case: github and github-app are mutually exclusive
    // toggleConnectionActive only handles same-service exclusivity, so we need to
    // manually deactivate the OTHER GitHub service type
    const targetConnection = connections.find((c) => c.connectionId === connectionId);
    if (!targetConnection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const otherGitHubService = targetConnection.service === 'github' ? 'github-app' : 'github';
    for (const conn of connections) {
      if (conn.service === otherGitHubService && conn.isActive) {
        await this.secretsAdapter.toggleConnectionActive({
          userId,
          connectionId: conn.connectionId,
          isActive: false,
          authToken,
        });
        debugLog(
          `[ConnectionsService] Deactivated ${otherGitHubService} connection: ${conn.connectionId}`
        );
      }
    }

    // Activate the target connection (this also deactivates other connections of the same service)
    await this.secretsAdapter.toggleConnectionActive({
      userId,
      connectionId,
      isActive: true,
      authToken,
    });
    debugLog(`[ConnectionsService] Activated GitHub connection: ${connectionId}`);

    // The active connection changed — drop the memoized lookup
    this.invalidateActiveGitHubConnection(userId);

    // Configure gh CLI with the active token (non-blocking)
    // This ensures 'gh' commands work with the correct account
    try {
      let token: string | undefined;

      if (targetConnection.service === 'github') {
        // OAuth connection - fetch token from Clerk (single source of truth)
        const credentials = await this.getConnectionCredentials({
          userId,
          connectionId,
          authToken,
        });
        token = credentials?.token;
      } else if (targetConnection.service === 'github-app') {
        // GitHub App connection - get token dynamically (may refresh)
        ({ token } = await this.getGitHubAppToken(connectionId, userId, authToken));
      }

      if (token) {
        // Run in background to avoid blocking
        this.setupGitHubCli(token).catch((err) => {
          console.warn('[ConnectionsService] gh CLI setup failed:', err);
        });
      }
    } catch (error) {
      // Non-critical - log and continue
      console.warn('[ConnectionsService] Failed to get token for gh CLI setup:', error);
    }

    // Emit event for reactive token management
    this.emit('connection:updated', {
      userId,
      service: targetConnection.service,
      connectionId,
    });
  }
}
