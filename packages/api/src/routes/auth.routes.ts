import { createClerkClient } from '@clerk/backend';
import { GATEWAY_URL } from '@vgit2/shared/constants';
import * as constants from '@vgit2/shared/constants';
import { decodeAuthToken, generateAuthToken } from '@vgit2/shared/jwt';
import { Router } from 'express';

import { extractToken } from '../middleware/jwtAuth.js';
import { verifyGitHubPermissionsWithRefresh } from '../services/AuthService/verifyGitHubPermissions.js';
import { AuthService } from '../services/AuthService.js';
import { fetchWithTimeout, isUpstreamUnreachableError } from '../utils/fetchWithTimeout.js';

import type { ConnectionsService } from '../services/ConnectionsService.js';
import type { GitLocalService } from '../services/GitLocalService.js';

// Initialize Clerk client - in tests this is mocked, in production it requires CLERK_SECRET_KEY
const clerkClient = createClerkClient({ secretKey: constants.CLERK_SECRET_KEY || '' });

export function createAuthRoutes(
  authService: AuthService,
  connectionsService?: ConnectionsService,
  onAuthTokenCreated?: (token: string) => Promise<void>,
  // Retained for call-site compatibility; the remote git-credentials writer
  // it fed was removed in the local-first pivot (git auth is LocalGitHubAuthService).
  _gitLocalService?: GitLocalService
): Router {
  const router = Router();

  // GitHub OAuth login (returns JSON if mobile=true, otherwise redirects).
  //
  // Flush this user's active-GitHub-connection cache BEFORE starting OAuth. The
  // user is about to (re)connect GitHub, and a pre-connect permission check has
  // very likely populated a stale NEGATIVE entry (type 'none', 45s TTL — see
  // ActiveGitHubConnectionCache). The brand-new connection is stored by the
  // GATEWAY's /auth/github/callback (a SEPARATE process whose write cannot reach
  // this sandbox's in-memory cache), so without flushing here the post-OAuth
  // GET /auth/check-github-permissions keeps returning "no connection" until the
  // 45s negative TTL expires — making "Connect" look broken and forcing the user
  // to retry several times. This is most visible on the RN mobile gate, which
  // re-checks the instant the in-app browser closes (well within 45s). Dropping
  // the entry now makes that post-connect check refetch fresh from Clerk and pick
  // up the connection immediately. Cache key == req.session.userEmail, the same
  // key checkGitHubPermissions uses.
  router.get('/github', (req, res) => {
    const userEmail = req.session?.userEmail;
    if (userEmail && connectionsService) {
      console.log(
        `[Auth] GitHub OAuth initiated — flushing active-connection cache for ${userEmail}`
      );
      connectionsService.invalidateActiveGitHubConnection(userEmail);
    }
    return authService.handleGitHubLogin(req, res);
  });

  // GitHub OAuth callback
  router.get('/github/callback', async (req, res) => authService.handleGitHubCallback(req, res));

  // Generate org access OAuth URL (for popup flow)
  router.post('/github/org-access-url', async (req, res) => {
    const userId = req.session?.userId || '';
    const userEmail = req.session?.userEmail || '';
    return authService.generateOrgAccessUrl(res, userId, userEmail);
  });

  // Google OAuth login
  router.get('/google', (req, res) => authService.handleGoogleLogin(req, res));

  // Google Drive OAuth login (alias for /google to support named connections)
  router.get('/google-drive', (req, res) => authService.handleGoogleLogin(req, res));

  // Gmail OAuth login (alias for /google to support named connections)
  router.get('/gmail', (req, res) => authService.handleGoogleLogin(req, res));

  // Google OAuth callback
  router.get('/google/callback', async (req, res) => authService.handleGoogleCallback(req, res));

  // Google Drive disconnect
  router.post('/google/disconnect', (req, res) => authService.handleGoogleDisconnect(req, res));

  // Slack OAuth login
  router.get('/slack', (req, res) => authService.handleSlackLogin(req, res));

  // Slack OAuth callback
  router.get('/slack/callback', async (req, res) => authService.handleSlackCallback(req, res));

  // Slack disconnect
  router.post('/slack/disconnect', (req, res) => authService.handleSlackDisconnect(req, res));

  // Logout (session-based)
  router.get('/logout', (req, res) => authService.handleLogout(req, res));

  // Check GitHub token scopes
  router.get('/check-scopes', async (req, res) => authService.checkScopes(req, res));

  // Update token (used after scope upgrade from Gateway)
  router.post('/update-token', async (req, res) => {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Missing token' });
      }

      // Verify the new JWT token
      const payload = decodeAuthToken(token);
      if (!payload) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      // NOTE: GitHub tokens are no longer in JWT for security reasons
      // They are managed server-side via ConnectionsService

      // Update session with new JWT token
      req.session.authToken = token;

      // Update user info if provided in payload
      if (payload.username) {
        req.session.username = payload.username;
      }

      if (payload.email) {
        req.session.userEmail = payload.email;
      }

      if (payload.userId || (payload as any).userId) {
        req.session.userId = payload.userId || (payload as any).userId;
      }

      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Error saving session after token update:', err);
          return res.status(500).json({ error: 'Failed to save session' });
        }

        console.log(`[Auth] Token updated successfully for user: ${payload.username}`);
        res.json({ success: true, message: 'Token updated successfully' });
      });
    } catch (error) {
      console.error('[Auth] Error updating token:', error);
      res.status(500).json({ error: 'Failed to update token' });
    }
  });

  // JWT Logout - Invalidates the token via token-validation service
  // POST /auth/jwt-logout
  router.post('/jwt-logout', async (req, res) => {
    try {
      const token = extractToken(req);

      if (!token) {
        return res.status(400).json({
          error: 'No token provided',
          redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
        });
      }

      const payload = decodeAuthToken(token);

      if (!payload?.jti) {
        console.warn('[Auth] JWT logout: Token has no jti, cannot invalidate');
        return res.json({
          success: true,
          message: 'Logged out (token not invalidated - no jti)',
          redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
        });
      }

      // Local-first: the remote token-validation/invalidation service
      // was retired. Logout just destroys the local session below; the JWT
      // expires on its own TTL (the PC validates tokens locally — there is no
      // central blacklist to update).
      console.log(`[Auth] JWT logout (jti: ${payload.jti.substring(0, 8)}...): session cleared`);

      // Clear session if exists
      if (req.session) {
        req.session.destroy((err) => {
          if (err) {
            console.error('[Auth] Error destroying session:', err);
          }
        });
      }

      res.json({
        success: true,
        message: 'Logged out successfully',
        redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
      });
    } catch (error) {
      console.error('[Auth] JWT logout error:', error);
      res.status(500).json({
        error: 'Logout failed',
        redirectUrl: `${GATEWAY_URL}/?logout=true`, // Landing page with logout param
      });
    }
  });

  // Check GitHub permissions (GitHub App or OAuth)
  // GET /auth/check-github-permissions
  router.get('/check-github-permissions', async (req, res) => {
    try {
      // Post-connect re-verify: the client sends ?refresh=1 right after a connect
      // flow settles. The connection was just stored by the GATEWAY (in Clerk),
      // so a single cached/fresh read can still miss it (a negative entry
      // re-cached during the OAuth window, or Clerk read-after-write lag) — which
      // made the gate only drop on the SECOND tap. On refresh we invalidate this
      // user's cache entry before each read and briefly retry until it appears.
      const userEmail = req.session?.userEmail;
      const wantsFreshVerify = req.query.refresh === '1' && !!connectionsService && !!userEmail;

      const permissionStatus = wantsFreshVerify
        ? await verifyGitHubPermissionsWithRefresh(
            () => authService.checkGitHubPermissions(req),
            () => connectionsService!.invalidateActiveGitHubConnection(userEmail!)
          )
        : await authService.checkGitHubPermissions(req);

      res.json(permissionStatus);
    } catch (error: any) {
      console.error('[Auth] Error checking GitHub permissions:', error);
      res.status(500).json({
        hasPermissions: false,
        authType: 'none',
        needsUpgrade: true,
        error: error.message || 'Failed to check GitHub permissions',
      });
    }
  });

  // Check for existing GitHub App installations
  // NOTE: GET /auth/github-app/callback removed — now handled by gateway (packages/gateway/src/routes/auth.ts)
  // GET /auth/github-app/check-existing
  router.get('/github-app/check-existing', async (req, res) => {
    if (!req.session?.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!connectionsService) {
      return res.status(500).json({ error: 'Connections service not available' });
    }

    try {
      // Get the user's GitHub token to fetch their installations
      const authService = (req as any).app.locals.authService;
      if (!authService) {
        return res.status(500).json({ error: 'Auth service not available' });
      }

      let githubToken: string | null = null;
      try {
        githubToken = await authService.getGitHubToken(req);
      } catch (err: any) {
        // INSUFFICIENT_GITHUB_PERMISSIONS means no token available - this is OK
        if (err.code === 'INSUFFICIENT_GITHUB_PERMISSIONS') {
          console.log('[Auth] No GitHub token found, skipping existing installations check');
          return res.json({ found: false, installations: [] });
        }
        throw err; // Re-throw unexpected errors
      }
      if (!githubToken) {
        // User hasn't connected GitHub OAuth yet - can't check for existing installations
        // This is fine, they can install GitHub App as their first connection
        console.log('[Auth] No GitHub token found, skipping existing installations check');
        return res.json({ found: false, installations: [] });
      }

      // Fetch user's installations
      const installationsResponse = await fetchWithTimeout(
        'https://api.github.com/user/installations',
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (!installationsResponse.ok) {
        const errorText = await installationsResponse.text();
        console.error(
          '[Auth] Failed to fetch installations:',
          installationsResponse.status,
          errorText
        );
        return res.status(500).json({ error: 'Failed to fetch GitHub App installations' });
      }

      const data = (await installationsResponse.json()) as any;
      const installations = data.installations || [];

      // Filter for our app
      const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
      const ourInstallations = installations.filter(
        (inst: any) => inst.app_id === parseInt(GITHUB_APP_ID || '0', 10)
      );

      if (ourInstallations.length === 0) {
        return res.json({ found: false, installations: [] });
      }

      // Check if we already have connections for these installations
      const existingConnections = await connectionsService.getUserConnections({
        userId: req.session.userEmail,
        authToken: req.session.authToken,
      });

      const githubAppConnections = existingConnections.filter((c) => c.service === 'github-app');

      // Fetch credentials from Clerk for each GitHub App connection
      const existingInstallationIds: number[] = [];
      for (const c of githubAppConnections) {
        const credentials = await connectionsService.getConnectionCredentials({
          userId: req.session.userEmail!,
          connectionId: c.connectionId,
          authToken: req.session.authToken,
        });
        if (credentials?.installationId) {
          existingInstallationIds.push(credentials.installationId);
        }
      }

      // Create connections for new installations
      const newConnections = [];
      for (const installation of ourInstallations) {
        if (!existingInstallationIds.includes(installation.id)) {
          console.log(`[Auth] Creating connection for existing installation: ${installation.id}`);
          const connection = await connectionsService.createGitHubAppConnection(
            req.session.userEmail,
            installation.id,
            req.session.authToken
          );
          newConnections.push(connection);
        }
      }

      return res.json({
        found: true,
        installations: ourInstallations.length,
        newConnections: newConnections.length,
        connections: newConnections,
      });
    } catch (error: any) {
      // GitHub unreachable (offline / DNS / timeout): retryable 503, not an opaque 500
      if (isUpstreamUnreachableError(error)) {
        console.warn('[Auth] GitHub unreachable while checking installations:', error?.message);
        return res.status(503).json({
          error: 'GitHub API temporarily unavailable',
          code: 'GITHUB_UNAVAILABLE',
          retryable: true,
        });
      }
      console.error('[Auth] Error checking existing installations:', error);
      return res.status(500).json({ error: error.message || 'Failed to check installations' });
    }
  });

  // NOTE: POST /auth/github-app/complete removed — now handled by gateway (packages/gateway/src/routes/auth.ts)

  // Activate a specific GitHub connection (OAuth or App)
  // POST /auth/github/activate
  router.post('/github/activate', async (req, res) => {
    if (!req.session?.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!connectionsService) {
      return res.status(500).json({ error: 'Connections service not available' });
    }

    try {
      const { connectionId } = req.body;

      if (!connectionId) {
        return res.status(400).json({ error: 'connectionId is required' });
      }

      await connectionsService.setActiveGitHubConnection(
        req.session.userEmail,
        connectionId,
        req.session.authToken
      );

      res.json({ success: true, connectionId });
    } catch (error: any) {
      console.error('[Auth] Error activating GitHub connection:', error);
      res.status(500).json({ error: error.message || 'Failed to activate GitHub connection' });
    }
  });

  // Exchange Clerk session for our JWT (for local dev with Clerk)
  // POST /auth/clerk/exchange
  router.post('/clerk/exchange', async (req, res) => {
    try {
      const { sessionId, sessionToken } = req.body;

      if (!sessionId || !sessionToken) {
        return res.status(400).json({ error: 'sessionId and sessionToken are required' });
      }

      // Use injectable Clerk client for testing, fall back to module-level client
      const client = (req as any).app.locals.clerkClient || clerkClient;

      // Verify the session token with Clerk
      let clerkSession;
      try {
        clerkSession = await client.sessions.getSession(sessionId);
      } catch (err: any) {
        console.error('[Auth] Clerk exchange: Failed to get session:', err.message);
        return res.status(401).json({ error: 'Invalid Clerk session' });
      }

      if (clerkSession.status !== 'active') {
        return res.status(401).json({ error: 'Clerk session is not active' });
      }

      // Get user info from Clerk
      const clerkUser = await client.users.getUser(clerkSession.userId);
      const email = clerkUser.primaryEmailAddress?.emailAddress;
      const username = clerkUser.username || email?.split('@')[0] || 'user';
      const avatarUrl = clerkUser.imageUrl || '';

      if (!email) {
        return res.status(400).json({ error: 'No email associated with Clerk account' });
      }

      // Generate our JWT with user identity + platform tokens
      // SECURITY: GitHub tokens stored in database ONLY, accessed server-side via ConnectionsService
      // In local mode, populate JWT with platform tokens from .env
      const token = generateAuthToken({
        userId: clerkSession.userId,
        username,
        email,
        avatarUrl,
      });

      // Initialize services with new token (fire-and-forget)
      onAuthTokenCreated?.(token).catch((err) =>
        console.error('[Auth] Clerk exchange: Failed to initialize services:', err)
      );

      // Set up session
      req.session.userEmail = email;
      req.session.username = username;
      req.session.userId = clerkSession.userId;
      req.session.authToken = token;

      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Clerk exchange: Error saving session:', err);
          // Still return token even if session save fails
        }

        res.json({ token, user: { email, username, userId: clerkSession.userId } });
      });
    } catch (error: any) {
      console.error('[Auth] Clerk exchange error:', error);
      res.status(500).json({ error: error.message || 'Failed to exchange Clerk session' });
    }
  });

  // Refresh JWT with GitHub token from ConnectionsService
  // POST /auth/refresh-jwt-with-github
  // Called after user completes GitHub App installation or OAuth to update JWT with new token
  router.post('/refresh-jwt-with-github', async (req, res) => {
    if (!req.session?.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!connectionsService) {
      return res.status(500).json({ error: 'Connections service not available' });
    }

    try {
      const userId = req.session.userEmail;
      const authToken = req.session.authToken;

      // Preserve avatarUrl from existing JWT
      let avatarUrl = '';
      if (authToken) {
        try {
          const decoded = decodeAuthToken(authToken);
          avatarUrl = decoded?.avatarUrl || '';
        } catch (err) {
          console.warn('[Auth] Failed to decode existing JWT for avatar preservation:', err);
        }
      }

      const activeConnection = await connectionsService.getActiveGitHubConnection(
        userId,
        authToken
      );

      if (activeConnection.type === 'none' || !activeConnection.token) {
        return res.status(404).json({ error: 'No GitHub connection found' });
      }

      // Generate new JWT (GitHub token stays in database, not in JWT)
      // SECURITY: GitHub tokens accessed server-side via ConnectionsService
      // In local mode, populate JWT with platform tokens from .env
      const newToken = generateAuthToken({
        userId: req.session.userEmail, // Fallback to email if userId not set
        username: req.session.username || req.session.userEmail,
        email: req.session.userEmail,
        avatarUrl,
      });

      // Initialize services with refreshed token (fire-and-forget)
      onAuthTokenCreated?.(newToken).catch((err) =>
        console.error('[Auth] JWT refresh: Failed to initialize services:', err)
      );

      // Update session with new JWT token
      req.session.authToken = newToken;

      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Error saving session after JWT refresh:', err);
          return res.status(500).json({ error: 'Failed to save session' });
        }

        res.json({
          token: newToken,
          authType: activeConnection.type,
          connectionId: activeConnection.connection?.connectionId,
        });
      });
    } catch (error: any) {
      console.error('[Auth] Error refreshing JWT with GitHub:', error);
      res.status(500).json({ error: error.message || 'Failed to refresh JWT' });
    }
  });

  return router;
}
