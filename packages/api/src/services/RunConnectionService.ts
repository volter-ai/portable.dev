import { WebClient } from '@slack/web-api';
import { MissingConnectionsError, type CodeExecutorResult } from '@vgit2/shared/types';
import { google } from 'googleapis';

import { CodeExecutorService } from './CodeExecutorService.js';

import type { ConnectionsService } from './ConnectionsService.js';

/**
 * Run Connection execution context.
 * Services are added dynamically based on the 'connections' parameter.
 */
export interface RunConnectionContext {
  /**
   * Additional context for user code.
   */
  context: {
    userId: string;
    chatId: string;
    emitEvent: (event: string, data: any) => void;
  };

  /**
   * Node.js require function.
   */
  require: NodeRequire;

  /**
   * Console for debugging.
   */
  console: Console;

  // Dynamic service clients added based on connections:
  // slack?: WebClient;
  // linear?: LinearClient;
  // notion?: Client;
  // drive?: any; docs?: any; sheets?: any;  // Google services
  [key: string]: any;
}

/**
 * Run Connection Service
 *
 * Executes TypeScript code with authenticated API clients for connected services.
 * Uses NAMED CONNECTIONS to support multiple instances of the same service.
 *
 * Key innovation: Optimistic execution
 * - Claude declares which connection NAMES it needs in the tool call
 * - If connection is missing → throw MissingConnectionsError
 * - The client shows "Connect [Service]" button
 * - No system prompt bloat, no pre-checks
 *
 * Environment variables:
 * - ALL connections (SDK + CLI) expose credentials as env vars
 * - SDK services ALSO provide authenticated client objects
 * - Pattern: {CONNECTION_NAME_UPPERCASE}_{CREDENTIAL_FIELD_UPPERCASE}
 *
 * Example usage:
 * ```typescript
 * const executor = new RunConnectionService(connectionsService);
 * const result = await executor.execute({
 *   connections: ['company_slack', 'personal_slack'],  // Connection NAMES
 *   code: `
 *     // SDK services: Option 1 - authenticated client (recommended)
 *     await company_slack.chat.postMessage({ channel: '#general', text: 'Done!' });
 *     await personal_slack.chat.postMessage({ channel: '#random', text: 'Also done!' });
 *
 *     // SDK services: Option 2 - environment variables
 *     const token = process.env.COMPANY_SLACK_TOKEN;
 *
 *     return { success: true };
 *   `,
 *   userId: 'user-123',
 *   chatId: 'chat-abc',
 *   emitEvent: (event, data) => console.log(event, data)
 * });
 * ```
 */
export class RunConnectionService extends CodeExecutorService<
  RunConnectionContext,
  CodeExecutorResult
> {
  constructor(private connectionsService: ConnectionsService) {
    super();
  }

  /**
   * Setup execution context with requested service clients.
   *
   * This method:
   * 1. Fetches full connection objects for each requested connection NAME
   * 2. Exposes ALL credentials as environment variables
   * 3. For SDK services, also creates authenticated API clients
   * 4. Throws MissingConnectionsError if any connection is missing
   *
   * @param params - Execution parameters
   * @param params.connections - Connection NAMES to use (e.g., ['company_slack', 'aws_prod'])
   * @param params.userId - Portable user ID
   * @param params.chatId - Chat session ID
   * @param params.emitEvent - Event emitter for client communication
   * @returns Run Connection context with requested service clients and env vars
   * @throws MissingConnectionsError if any requested connection is missing
   */
  protected async setupContext(params: {
    connections: string[];
    userId: string;
    chatId: string;
    emitEvent: (event: string, data: any) => void;
    authToken?: string;
  }): Promise<RunConnectionContext> {
    const context: RunConnectionContext = {
      context: {
        userId: params.userId,
        chatId: params.chatId,
        emitEvent: params.emitEvent,
      },
      require,
      console,
    };

    const missing: string[] = [];

    // Setup requested connections by NAME
    for (const connectionName of params.connections) {
      // Get full connection object to determine service type
      const connection = await this.connectionsService.getConnection({
        userId: params.userId,
        connectionId: connectionName,
        authToken: params.authToken,
      });

      if (!connection) {
        missing.push(connectionName);
        continue;
      }

      // Fetch credentials from Clerk (single source of truth)
      const credentials = await this.connectionsService.getConnectionCredentials({
        userId: params.userId,
        connectionId: connectionName,
        authToken: params.authToken,
      });

      if (!credentials) {
        console.error(`[RunConnection] Credentials not found for connection ${connectionName}`);
        missing.push(connectionName);
        continue;
      }

      // DEBUG: Log credentials structure (without exposing sensitive values)
      console.log(`[RunConnection] Connection ${connectionName} credentials:`, {
        service: connection.service,
        serviceType: connection.serviceType,
        credentialKeys: Object.keys(credentials || {}),
        hasToken: !!credentials?.token,
        hasAccessToken: !!credentials?.accessToken,
      });

      // ALL services: expose credentials as environment variables
      const envPrefix = connectionName.toUpperCase();
      Object.entries(credentials).forEach(([key, value]) => {
        const envKey = `${envPrefix}_${key.toUpperCase()}`;
        process.env[envKey] = String(value);
      });

      // SDK services: ALSO setup authenticated client under connection name
      if (connection.serviceType === 'sdk') {
        try {
          const client = await this.setupServiceClient(connection.service, credentials);

          // All services: assign client to connection name for consistency
          // Google Drive returns { drive, docs, sheets }, accessible as google_drive_1.drive, etc.
          context[connectionName] = client;
        } catch (error: any) {
          console.error(`[RunConnection] Error setting up ${connectionName}:`, error.message);

          // Distinguish between "service not implemented" and other setup errors
          if (error.message?.includes('Service not implemented')) {
            // Service SDK not supported - this is a development/configuration error
            throw new Error(
              `Service '${connection.service}' is not supported for SDK connections. ` +
                `Available services: slack, google-drive, gmail, apify. ` +
                `The connection exists but the SDK integration is not implemented yet.`
            );
          } else {
            // Other setup errors (invalid credentials, network issues, etc.)
            throw new Error(
              `Failed to initialize ${connection.service} client for connection '${connectionName}': ${error.message}`
            );
          }
        }
      }

      console.log(
        `[RunConnection] Setup connection: ${connectionName} (${connection.service}, ${connection.serviceType})`
      );
    }

    // If any connections are missing, throw error
    if (missing.length > 0) {
      throw new MissingConnectionsError(`Missing connections: ${missing.join(', ')}`, missing);
    }

    return context;
  }

  /**
   * Setup service client based on service type.
   * Each service has different SDK and authentication pattern.
   *
   * @param service - Service identifier (slack, linear, notion, etc.)
   * @param credentials - Service-specific credentials
   * @returns Authenticated service client
   */
  private async setupServiceClient(service: string, credentials: any): Promise<any> {
    switch (service) {
      // ========================================================================
      // SDK-BASED SERVICES
      // ========================================================================

      case 'slack': {
        // Slack Web API client
        console.log(
          `[RunConnection] Initializing Slack client with token: ${credentials.token ? credentials.token.substring(0, 20) + '...' : 'MISSING!'}`
        );
        if (!credentials.token) {
          throw new Error(
            `Slack credentials missing 'token' field. Available fields: ${Object.keys(credentials).join(', ')}`
          );
        }
        return new WebClient(credentials.token);
      }

      case 'google-drive': {
        // Google APIs (Drive, Docs, Sheets)
        // NOTE: OAuth2Client without client credentials cannot auto-refresh tokens.
        // Token refresh should be handled by the OAuth service (/oauth/google/refresh-token)
        // TODO: Implement token refresh via OAuth service when tokens expire
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
        });

        // Return object with all Google services
        return {
          drive: google.drive({ version: 'v3', auth: oauth2Client }),
          docs: google.docs({ version: 'v1', auth: oauth2Client }),
          sheets: google.sheets({ version: 'v4', auth: oauth2Client }),
        };
      }

      case 'gmail': {
        // Gmail API
        // NOTE: OAuth2Client without client credentials cannot auto-refresh tokens.
        // Token refresh should be handled by the OAuth service (/oauth/google/refresh-token)
        // TODO: Implement token refresh via OAuth service when tokens expire
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({
          access_token: credentials.accessToken,
          refresh_token: credentials.refreshToken,
        });

        return google.gmail({ version: 'v1', auth: oauth2Client });
      }

      case 'apify': {
        // Apify client for web scraping and automation
        const { ApifyClient } = await import('apify-client');
        console.log(
          `[RunConnection] Initializing Apify client with token: ${credentials.apiToken ? credentials.apiToken.substring(0, 20) + '...' : 'MISSING!'}`
        );
        if (!credentials.apiToken) {
          throw new Error(
            `Apify credentials missing 'apiToken' field. Available fields: ${Object.keys(credentials).join(', ')}`
          );
        }
        return new ApifyClient({ token: credentials.apiToken });
      }

      // ========================================================================
      // CLI-BASED TOOLS
      // ========================================================================
      // CLI tools (aws, kubectl, docker) don't need code executor setup
      // Credentials are written to config files by ConnectionsService
      // Claude uses Bash tool directly

      default:
        throw new Error(`Service not implemented: ${service}`);
    }
  }

  /**
   * Wrap user code before execution.
   * Currently a pass-through - code is used as-is.
   *
   * @param code - User-provided TypeScript code
   * @param context - Run Connection context (unused)
   * @returns Wrapped code (currently unchanged)
   */
  protected wrapCode(code: string, context: RunConnectionContext): string {
    // Code is already TypeScript - use as-is
    // Could add wrapping logic here if needed:
    // - Ensure return statement
    // - Add try/catch
    // - Add logging
    return code;
  }

  /**
   * Validate execution result.
   * Currently a pass-through - no validation performed.
   *
   * @param result - Execution result
   */
  protected validateResult(result: any): void {
    // Optional: Add service-specific validation
    // Currently no validation - accept any result
  }
}
