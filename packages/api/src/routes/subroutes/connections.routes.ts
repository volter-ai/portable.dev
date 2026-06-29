import { verifyAuthToken } from '@vgit2/shared/jwt';
import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { getAuthToken } from '../utils/route-helpers.js';

import type { ChatService } from '../../services/ChatService.js';
import type { ConnectionsService } from '../../services/ConnectionsService.js';
import type { GitHubApiService } from '../../services/GitHubApiService.js';
import type { GitLocalService } from '../../services/GitLocalService.js';
import type {
  GetConnectionsResponse,
  GetServicesResponse,
  GetConnectionResponse,
  CreateConnectionResponse,
  RenameConnectionApiResponse,
  GetConnectionAccountInfoResponse,
  DeleteConnectionResponse,
  ToggleConnectionActiveResponse,
  GetFlyioAuthUrlResponse,
  CompleteFlyioAuthResponse,
  UpdateGitCredentialsResponse,
} from '@vgit2/shared/types';

/**
 * OAuth connections and service integrations routes
 */
export function createConnectionsRoutes(
  connectionsService: ConnectionsService,
  chatService: ChatService,
  githubApiService: GitHubApiService,
  gitLocalService: GitLocalService
): Router {
  const router = Router();

  // Get all connections for user
  router.get('/connections', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const connections = await connectionsService.getUserConnections({
        userId: req.session.userEmail,
        authToken: req.session.authToken,
      });
      const response: GetConnectionsResponse = { connections };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/connections - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch connections' });
    }
  });

  // Get all available service configurations
  router.get('/connections/services', (req, res) => {
    try {
      const services = connectionsService.getAllServiceConfigs();
      const response: GetServicesResponse = { services };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/connections/services - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch service configs' });
    }
  });

  // Get specific service configuration
  router.get('/connections/services/:service', (req, res) => {
    try {
      const config = connectionsService.getServiceConfig(req.params.service);
      if (!config) {
        return res.status(404).json({ error: 'Service not found' });
      }
      const response: any = config;
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/connections/services/:service - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch service config' });
    }
  });

  // Get single connection by ID
  router.get('/connections/:connectionId', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const connection = await connectionsService.getConnection({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        authToken: req.session.authToken,
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const response: GetConnectionResponse = { connection };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/connections/:connectionId - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch connection' });
    }
  });

  // Complete OAuth connection with displayName (after OAuth popup closes)
  router.post('/connections/complete-oauth', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const { service, connectionId, displayName } = req.body;

      if (!service || !connectionId || !displayName) {
        return res.status(400).json({
          error: 'service, connectionId, and displayName are required',
        });
      }

      // Retrieve pending OAuth credentials from session
      let credentials: any;
      let serviceType: string;

      if (service === 'google-drive' || service === 'gmail') {
        if (!req.session.pendingGoogleOAuth) {
          return res
            .status(400)
            .json({ error: 'No pending Google OAuth found. Please reconnect.' });
        }
        if (req.session.googleConnectionName !== connectionId) {
          return res.status(400).json({ error: 'Connection ID mismatch' });
        }
        credentials = req.session.pendingGoogleOAuth.credentials;
        serviceType = req.session.pendingGoogleOAuth.serviceType;
      } else if (service === 'slack') {
        if (!req.session.pendingSlackOAuth) {
          return res.status(400).json({ error: 'No pending Slack OAuth found. Please reconnect.' });
        }
        if (req.session.slackConnectionName !== connectionId) {
          return res.status(400).json({ error: 'Connection ID mismatch' });
        }
        credentials = req.session.pendingSlackOAuth.credentials;
        serviceType = service;
      } else if (service === 'github') {
        if (!req.session.pendingGitHubOAuth) {
          return res
            .status(400)
            .json({ error: 'No pending GitHub OAuth found. Please reconnect.' });
        }
        if (req.session.githubConnectionId !== connectionId) {
          return res.status(400).json({ error: 'Connection ID mismatch' });
        }
        credentials = req.session.pendingGitHubOAuth.credentials;
        serviceType = service;
      } else {
        return res.status(400).json({ error: `Unknown OAuth service: ${service}` });
      }

      // Determine serviceType based on service config
      const serviceConfig = connectionsService.getServiceConfig(serviceType);
      const resolvedServiceType = serviceConfig?.type || 'sdk';

      // Store connection to database
      const connection = await connectionsService.storeConnection({
        userId: req.session.userEmail,
        connectionId,
        displayName,
        service: serviceType,
        serviceType: resolvedServiceType,
        credentials,
        authToken: req.session.authToken,
      });

      // For GitHub connections, set as active to configure gh CLI
      if (service === 'github') {
        try {
          await connectionsService.setActiveGitHubConnection(
            req.session.userEmail,
            connectionId,
            req.session.authToken
          );
          console.log(`[API] ✓ GitHub connection activated and gh CLI configured: ${connectionId}`);

          // CRITICAL: Explicitly refresh token cache in GitHubApiService
          // This ensures immediate availability without waiting for event emission
          console.log(
            `[API] Explicitly refreshing GitHub token cache for ${req.session.userEmail}...`
          );
          await githubApiService.loadTokenForUser(req.session.userEmail, req.session.authToken);
          console.log(`[API] ✓ GitHub token cache refreshed`);
        } catch (activationError) {
          console.warn(
            '[API] Failed to activate GitHub connection (non-critical):',
            activationError
          );
          // Continue - connection is still created, just gh CLI not configured
        }
      }

      // Clean up session
      if (service === 'google-drive' || service === 'gmail') {
        delete req.session.pendingGoogleOAuth;
        delete req.session.googleConnectionName;
      } else if (service === 'slack') {
        delete req.session.pendingSlackOAuth;
        delete req.session.slackConnectionName;
      } else if (service === 'github') {
        delete req.session.pendingGitHubOAuth;
        delete req.session.githubConnectionId;
      }

      console.log(
        `[API] ✓ ${serviceType} OAuth connection completed: ${displayName} (${connectionId})`
      );

      // For GitHub connections, refresh the JWT to include the new token
      let newToken: string | undefined;
      if (service === 'github' && credentials.token) {
        try {
          const { generateAuthToken, decodeAuthToken } = await import('@vgit2/shared/jwt');

          // Preserve avatarUrl from existing JWT
          let avatarUrl = '';
          if (req.session.authToken) {
            try {
              const decoded = decodeAuthToken(req.session.authToken);
              avatarUrl = decoded?.avatarUrl || '';
            } catch (err) {
              console.warn('[API] Failed to decode existing JWT for avatar preservation:', err);
            }
          }

          // SECURITY: GitHub tokens stored in database ONLY, accessed server-side via ConnectionsService
          // JWT only contains user identity
          newToken = generateAuthToken({
            userId: req.session.userEmail,
            username: req.session.username || req.session.userEmail,
            email: req.session.userEmail,
            avatarUrl,
          });

          // Update session with new JWT token
          req.session.authToken = newToken;

          console.log(`[API] ✓ JWT refreshed after GitHub connection for ${req.session.userEmail}`);
        } catch (jwtError) {
          console.warn('[API] Failed to refresh JWT with GitHub token:', jwtError);
        }
      }

      const response: { success: boolean; connection: any; token: string | undefined } = {
        success: true,
        connection,
        token: newToken,
      };
      res.json(response);
    } catch (error: any) {
      console.error('[API] POST /api/connections/complete-oauth - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to complete OAuth connection' });
    }
  });

  // Create/update a named connection
  router.post('/connections', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const { connectionId, displayName, service, credentials } = req.body;

      if (!connectionId || !displayName || !service || !credentials) {
        return res.status(400).json({
          error: 'connectionId, displayName, service, and credentials are required',
        });
      }

      const serviceConfig = connectionsService.getServiceConfig(service);
      if (!serviceConfig) {
        return res.status(404).json({ error: 'Service not found' });
      }

      // IMPORTANT: Setup CLI FIRST for CLI services (before storing connection)
      // If CLI setup fails, connection should not be created
      if (serviceConfig.type === 'cli') {
        try {
          await connectionsService.setupCliCredentials(req.session.userEmail, service, credentials);
        } catch (cliError: any) {
          console.error('[API] Failed to setup CLI credentials:', cliError);
          // Throw error - connection creation should fail if CLI setup fails
          throw cliError;
        }
      }

      // CLI is setup (or not needed for SDK services), now store connection
      const connection = await connectionsService.storeConnection({
        userId: req.session.userEmail,
        connectionId,
        displayName,
        service,
        serviceType: serviceConfig.type,
        credentials,
        authToken: req.session.authToken,
      });

      // For GitHub connections, explicitly refresh token cache
      if (service === 'github' || service === 'github-app') {
        try {
          console.log(
            `[API] Explicitly refreshing GitHub token cache for ${req.session.userEmail}...`
          );
          await githubApiService.loadTokenForUser(req.session.userEmail, req.session.authToken);
          console.log(`[API] ✓ GitHub token cache refreshed`);
        } catch (cacheError) {
          console.warn('[API] Failed to refresh GitHub token cache (non-critical):', cacheError);
          // Continue - connection is still created
        }
      }

      const response: CreateConnectionResponse = { success: true, connection };
      res.json(response);
    } catch (error: any) {
      console.error('[API] POST /api/connections - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to connect service' });
    }
  });

  // Rename a connection (updates display name and derives new connection ID)
  router.patch('/connections/:connectionId/rename', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const { newDisplayName } = req.body;

      if (!newDisplayName) {
        return res.status(400).json({ error: 'newDisplayName is required' });
      }

      const connection = await connectionsService.renameConnection({
        userId: req.session.userEmail!,
        oldConnectionId: req.params.connectionId as string,
        newDisplayName,
        authToken: req.session.authToken,
      });

      const response: RenameConnectionApiResponse = { success: true, connection };
      res.json(response);
    } catch (error: any) {
      console.error('[API] PATCH /api/connections/:connectionId/rename - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to rename connection' });
    }
  });

  // Get account info for a connection
  router.get('/connections/:connectionId/account-info', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const connection = await connectionsService.getConnection({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        authToken: req.session.authToken,
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const accountInfo = await connectionsService.getConnectionAccountInfo(connection, {
        authToken: req.session.authToken,
      });
      const response: GetConnectionAccountInfoResponse = { accountInfo };
      res.json(response);
    } catch (error: any) {
      console.error('[API] /api/connections/:connectionId/account-info - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch account info' });
    }
  });

  // Refresh account info (force refresh from API)
  router.post('/connections/:connectionId/refresh-account-info', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const connection = await connectionsService.getConnection({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        authToken: req.session.authToken,
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const accountInfo = await connectionsService.getConnectionAccountInfo(connection, {
        forceRefresh: true,
        authToken: req.session.authToken,
      });

      if (accountInfo) {
        // Fetch current credentials from Clerk
        const currentCredentials = await connectionsService.getConnectionCredentials({
          userId: req.session.userEmail!,
          connectionId: connection.connectionId,
          authToken: req.session.authToken,
        });

        if (currentCredentials) {
          // Update credentials with new accountInfo in Clerk
          await connectionsService.storeConnection({
            userId: req.session.userEmail,
            connectionId: connection.connectionId,
            displayName: connection.displayName,
            service: connection.service,
            serviceType: connection.serviceType,
            credentials: {
              ...currentCredentials,
              accountInfo,
              lastAccountInfoFetch: new Date().toISOString(),
            },
            authToken: req.session.authToken,
          });
        }
      }

      const responseData: GetConnectionAccountInfoResponse = { accountInfo };
      res.json(responseData);
    } catch (error: any) {
      console.error('[API] /api/connections/:connectionId/refresh-account-info - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to refresh account info' });
    }
  });

  // Delete a connection by ID
  router.delete('/connections/:connectionId', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      await connectionsService.deleteConnection({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        authToken: req.session.authToken,
      });
      const response: DeleteConnectionResponse = { success: true };
      res.json(response);
    } catch (error: any) {
      console.error('[API] DELETE /api/connections/:connectionId - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to disconnect service' });
    }
  });

  // Toggle connection active status (enable/disable)
  router.patch('/connections/:connectionId/toggle-active', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      // Check if connection exists first (before validating body)
      const existingConnection = await chatService.dbAdapter.getConnection({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        authToken: req.session.authToken,
      });

      if (!existingConnection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive (boolean) is required' });
      }

      const connection = await chatService.dbAdapter.toggleConnectionActive({
        userId: req.session.userEmail!,
        connectionId: req.params.connectionId as string,
        isActive,
        authToken: req.session.authToken,
      });

      // If this is an exclusive service and we're enabling it, update CLI credentials
      const serviceConfig = connectionsService.getServiceConfig(connection.service);
      if (isActive && serviceConfig?.isExclusive) {
        // Fetch credentials from Clerk (single source of truth)
        const credentials = await connectionsService.getConnectionCredentials({
          userId: req.session.userEmail!,
          connectionId: connection.connectionId,
          authToken: req.session.authToken,
        });
        if (credentials) {
          await connectionsService.setupCliCredentials(
            req.session.userEmail,
            connection.service,
            credentials
          );
        }
      }

      // For GitHub connections being activated, explicitly refresh token cache
      if (isActive && (connection.service === 'github' || connection.service === 'github-app')) {
        try {
          console.log(
            `[API] GitHub connection toggled active, refreshing token cache for ${req.session.userEmail}...`
          );
          await githubApiService.loadTokenForUser(req.session.userEmail, req.session.authToken);
          console.log(`[API] ✓ GitHub token cache refreshed`);
        } catch (cacheError) {
          console.warn('[API] Failed to refresh GitHub token cache (non-critical):', cacheError);
          // Continue - connection state is already updated
        }
      }

      const response: ToggleConnectionActiveResponse = { success: true, connection };
      res.json(response);
    } catch (error: any) {
      console.error('[API] PATCH /api/connections/:connectionId/toggle-active - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to toggle connection' });
    }
  });

  // Initiate Fly.io CLI auth (SSO-style)
  // Uses async spawn to extract URL quickly without blocking
  router.post('/connections/flyio-cli/auth-url', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const { connectionId } = req.body;

      if (!connectionId) {
        return res.status(400).json({ error: 'connectionId is required' });
      }

      // Check if flyctl is installed
      const { spawn, execSync } = await import('child_process');
      try {
        execSync('which flyctl', { encoding: 'utf8', timeout: 1000 });
      } catch (checkError) {
        return res.status(500).json({ error: 'Fly.io CLI (flyctl) not installed' });
      }

      // Spawn flyctl auth login (non-blocking, detached)
      const flyctl = spawn('flyctl', ['auth', 'login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      // Unref the process so it doesn't keep the event loop alive
      // This allows tests to complete while flyctl runs in background
      flyctl.unref();

      let hasResponded = false;

      // 5-second timeout to extract URL - should appear immediately
      // Unref so it doesn't keep the event loop alive (allows tests to complete)
      const urlExtractionTimeout = setTimeout(() => {
        if (!hasResponded) {
          hasResponded = true;
          flyctl.kill();
          res.status(500).json({ error: 'Failed to get auth URL from Fly.io CLI (timeout)' });
        }
      }, 5000);
      urlExtractionTimeout.unref();

      // Watch stdout for the auth URL (appears immediately)
      flyctl.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[flyctl] stdout:', output);

        // Look for the auth URL pattern
        const urlMatch = output.match(/https:\/\/fly\.io\/app\/auth\/cli\/[^\s]+/);
        if (urlMatch && !hasResponded) {
          const authUrl = urlMatch[0];
          console.log('[flyctl] Extracted auth URL:', authUrl);

          hasResponded = true;
          clearTimeout(urlExtractionTimeout);

          // Store pending connection info in session
          req.session.pendingFlyioConnection = {
            connectionId,
            timestamp: Date.now(),
          };

          const response: GetFlyioAuthUrlResponse = { authUrl };
          res.json(response);

          // Keep flyctl process running to complete auth flow
          // Set 30-second timeout for user to complete login after URL is sent
          // Unref so it doesn't keep the event loop alive
          const loginCompletionTimeout = setTimeout(() => {
            console.log('[flyctl] Login completion timeout - killing process');
            flyctl.kill();
          }, 30000);
          loginCompletionTimeout.unref();

          // Clear timeout if process completes naturally
          flyctl.on('close', () => {
            clearTimeout(loginCompletionTimeout);
          });
        }
      });

      // Watch stderr for errors
      flyctl.stderr.on('data', (data) => {
        console.error('[flyctl] stderr:', data.toString());
      });

      // Handle process completion
      flyctl.on('close', (code) => {
        clearTimeout(urlExtractionTimeout);
        console.log('[flyctl] Process exited with code:', code);

        if (!hasResponded) {
          hasResponded = true;
          res.status(500).json({ error: 'Fly.io CLI exited without providing auth URL' });
        }
      });

      // Handle errors
      flyctl.on('error', (err) => {
        clearTimeout(urlExtractionTimeout);
        console.error('[flyctl] Process error:', err);

        if (!hasResponded) {
          hasResponded = true;
          res.status(500).json({ error: `Fly.io CLI error: ${err.message}` });
        }
      });
    } catch (error: any) {
      console.error('[API] POST /api/connections/flyio-cli/auth-url - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to initiate Fly.io authentication' });
    }
  });

  // Complete Fly.io CLI auth (check if authenticated and store connection)
  router.post('/connections/flyio-cli/complete', requireAuth, async (req, res) => {
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const pendingConnection = req.session.pendingFlyioConnection;

      if (!pendingConnection) {
        return res.status(400).json({ error: 'No pending Fly.io connection' });
      }

      // Check if flyctl is now authenticated by reading the config
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');

      const flyctlConfigPath = path.join(os.homedir(), '.fly', 'config.yml');

      if (!fs.existsSync(flyctlConfigPath)) {
        return res.status(400).json({
          error: 'Authentication not complete yet',
          pending: true,
        });
      }

      const configContent = fs.readFileSync(flyctlConfigPath, 'utf8');
      const tokenMatch = configContent.match(/access_token:\s*(.+)/);

      if (!tokenMatch) {
        return res.status(400).json({
          error: 'Authentication not complete yet',
          pending: true,
        });
      }

      const apiToken = tokenMatch[1].trim();

      // Store the connection
      const connection = await connectionsService.storeConnection({
        userId: req.session.userEmail,
        connectionId: pendingConnection.connectionId,
        displayName: 'Fly.io CLI', // Default display name for Fly.io
        service: 'flyio-cli',
        serviceType: 'cli',
        credentials: { apiToken },
        authToken: req.session.authToken,
      });

      // Setup CLI credentials
      await connectionsService.setupCliCredentials(req.session.userEmail, 'flyio-cli', {
        apiToken,
      });

      // Clear pending connection
      delete req.session.pendingFlyioConnection;

      const response: CompleteFlyioAuthResponse = { success: true, connection };
      res.json(response);
    } catch (error: any) {
      console.error('[API] POST /api/connections/flyio-cli/complete - Error:', error);
      res.status(500).json({ error: error.message || 'Failed to complete Fly.io authentication' });
    }
  });

  // Update git credentials with GitHub token from ConnectionsService
  // This endpoint is called automatically from /auth/check-github-permissions in remote sandboxes
  router.post('/update-git-credentials', requireAuth, async (req, res) => {
    try {
      // Extract JWT from Authorization header
      const authToken = getAuthToken(req);

      if (!authToken) {
        console.log('[API] /update-git-credentials: No JWT token in Authorization header');
        return res.status(401).json({
          success: false,
          message: 'No authentication token provided',
        } as UpdateGitCredentialsResponse);
      }

      // Verify and decode JWT to extract user identity
      let userId: string | undefined;
      try {
        const jwtPayload = verifyAuthToken(authToken);
        userId = jwtPayload.email || jwtPayload.sub;

        if (!userId) {
          console.log('[API] /update-git-credentials: No user ID in JWT payload');
          return res.status(400).json({
            success: false,
            message: 'User ID not found in authentication token',
          } as UpdateGitCredentialsResponse);
        }

        console.log('[API] /update-git-credentials: User ID extracted:', userId);
      } catch (error) {
        console.error('[API] /update-git-credentials: JWT verification failed:', error);
        return res.status(401).json({
          success: false,
          message: 'Invalid authentication token',
        } as UpdateGitCredentialsResponse);
      }

      // Get GitHub token from ConnectionsService
      if (!connectionsService) {
        console.error('[API] /update-git-credentials: ConnectionsService not available');
        return res.status(500).json({
          success: false,
          message: 'Connections service not available',
        } as UpdateGitCredentialsResponse);
      }

      console.log(`[API] /update-git-credentials: Fetching GitHub connection for user: ${userId}`);
      const activeConnection = await connectionsService.getActiveGitHubConnection(
        userId,
        authToken
      );

      console.log(
        `[API] /update-git-credentials: Connection type: ${activeConnection.type}, has token: ${!!activeConnection.token}, token length: ${activeConnection.token?.length || 0}`
      );

      if (activeConnection.type === 'none' || !activeConnection.token) {
        console.log('[API] /update-git-credentials: No active GitHub connection found');
        return res.status(400).json({
          success: false,
          message: 'No GitHub connection found',
        } as UpdateGitCredentialsResponse);
      }

      // Validate token is not empty
      if (activeConnection.token.trim() === '') {
        console.error('[API] /update-git-credentials: GitHub token is empty string');
        return res.status(400).json({
          success: false,
          message: 'GitHub token is empty',
        } as UpdateGitCredentialsResponse);
      }

      console.log(
        `[API] /update-git-credentials: GitHub token retrieved via ${activeConnection.type}, token prefix: ${activeConnection.token.substring(0, 7)}...`
      );

      // Update git credentials file
      const result = await gitLocalService.updateGitCredentials(activeConnection.token);

      res.json(result as UpdateGitCredentialsResponse);
    } catch (error) {
      console.error('[API] /update-git-credentials: Error:', error);
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update git credentials',
      } as UpdateGitCredentialsResponse);
    }
  });

  return router;
}
