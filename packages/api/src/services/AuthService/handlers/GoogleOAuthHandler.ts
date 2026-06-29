import crypto from 'crypto';

import { GITHUB_APP_SERVICE_URL, debugLog } from '@vgit2/shared/constants';
import { Response } from 'express';

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';

import type { OAuthRequest, HandlerDependencies, TokenExchangeResult } from '../types';

/**
 * GoogleOAuthHandler - Handles Google OAuth authentication flow
 *
 * Responsibilities:
 * - Google OAuth URL generation
 * - Authorization code exchange
 * - OAuth callback handling
 * - Token refresh
 * - Service disconnection
 */
export class GoogleOAuthHandler {
  private dependencies: HandlerDependencies;

  constructor(dependencies: HandlerDependencies) {
    this.dependencies = dependencies;
    debugLog('[GoogleOAuthHandler] Initialized');
  }

  /**
   * Generate Google OAuth URL via remote OAuth service (production)
   */
  private async generateGoogleOAuthUrlViaService(
    res: Response,
    state: string,
    redirectUri: string,
    service: 'google-drive' | 'gmail',
    userToken: string
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/google/authorize-url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            redirectUri,
            state,
            service,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OAuth Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { url: string };
      console.log('[GoogleOAuthHandler] ✓ Google OAuth URL received from service');
      res.redirect(data.url);
    } catch (error) {
      console.error('[GoogleOAuthHandler] Failed to generate Google OAuth URL via service:', error);
      res.status(500).send('Failed to generate Google OAuth URL');
    }
  }

  /**
   * Exchange Google OAuth code for tokens via remote OAuth service (production)
   */
  private async exchangeGoogleCodeViaService(
    code: string,
    redirectUri: string,
    userToken: string
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    try {
      console.log('[GoogleOAuthHandler] Exchanging Google code via OAuth Service');

      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/google/exchange-code`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ code, redirectUri }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OAuth Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        accessToken: string;
        refreshToken?: string;
        expiresIn: number;
        tokenType: string;
        scope: string;
      };
      console.log('[GoogleOAuthHandler] ✓ Google tokens received from service');

      return { accessToken: data.accessToken, refreshToken: data.refreshToken };
    } catch (error) {
      console.error('[GoogleOAuthHandler] Failed to exchange Google code via service:', error);
      throw error;
    }
  }

  /**
   * Initiate Google OAuth flow for Drive access
   */
  handleGoogleLogin(req: OAuthRequest, res: Response): void {
    const state = crypto.randomBytes(16).toString('hex');
    const connectionId = (req.query.connectionId as string) || 'google_drive_default';

    req.session.googleOauthState = state;
    req.session.googleConnectionName = connectionId;

    // Determine which service is being connected based on the URL path
    const isGmail = req.path.includes('/gmail');
    const service: 'google-drive' | 'gmail' = isGmail ? 'gmail' : 'google-drive';

    // Store service type in session for callback
    req.session.googleService = service;

    // IMPORTANT: Save session before redirect to ensure OAuth state persists
    req.session.save((err) => {
      if (err) {
        console.error(
          '[GoogleOAuthHandler] Error saving session before Google OAuth redirect:',
          err
        );
        res.status(500).send('Failed to initialize Google OAuth flow');
        return;
      }

      console.log('[GoogleOAuthHandler] Google OAuth session saved, state:', state);

      const redirectUri = `${req.protocol}://${req.get('host')}/auth/google/callback`;

      // OAuth service is required for Google OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        console.error(
          '[GoogleOAuthHandler] GITHUB_APP_SERVICE_URL not configured - Google OAuth requires the OAuth service'
        );
        res.status(500).send('Google OAuth not configured. OAuth service URL is required.');
        return;
      }

      console.log('[GoogleOAuthHandler] Using OAuth Service for Google OAuth');
      const userToken = req.session?.authToken || '';
      this.generateGoogleOAuthUrlViaService(res, state, redirectUri, service, userToken);
    });
  }

  /**
   * Handle Google OAuth callback
   */
  async handleGoogleCallback(req: OAuthRequest, res: Response): Promise<void> {
    const { code, state, error, error_description } = req.query;

    console.log('[GoogleOAuthHandler] Google OAuth callback received');

    // Check for OAuth error parameter (e.g., user denied access)
    if (error) {
      console.error(`[GoogleOAuthHandler] Google OAuth error: ${error} - ${error_description}`);
      res.status(400).send(`OAuth error: ${error_description || error}`);
      return;
    }

    // Validate code parameter exists
    if (!code) {
      console.error('[GoogleOAuthHandler] Google OAuth callback missing code parameter');
      res.status(400).send('Missing authorization code');
      return;
    }

    // Validate state - must be present and match session state
    if (!state || !req.session.googleOauthState || state !== req.session.googleOauthState) {
      console.error('[GoogleOAuthHandler] Google OAuth state validation failed!');
      res.status(400).send('Invalid state parameter');
      return;
    }

    console.log('[GoogleOAuthHandler] Google OAuth state validation passed ✓');

    try {
      const redirectUri = `${req.protocol}://${req.get('host')}/auth/google/callback`;

      // OAuth service is required for Google OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        throw new Error('Google OAuth not configured. OAuth service URL is required.');
      }

      console.log('[GoogleOAuthHandler] Using OAuth Service for Google token exchange');
      const userToken = req.session?.authToken || '';
      const tokens = await this.exchangeGoogleCodeViaService(
        code as string,
        redirectUri,
        userToken
      );
      const googleAccessToken = tokens.accessToken;
      const googleRefreshToken = tokens.refreshToken;

      // Get user info from Google
      const userResponse = await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${googleAccessToken}`,
        },
      });

      const googleUser: any = await userResponse.json();

      console.log('[GoogleOAuthHandler] ========================================');
      console.log('[GoogleOAuthHandler] ✓ Google OAuth Success!');
      console.log('[GoogleOAuthHandler] User:', googleUser.email);
      console.log('[GoogleOAuthHandler] ========================================');
      console.log('[GoogleOAuthHandler] 📋 Copy these tokens to .env:');
      console.log('[GoogleOAuthHandler] ========================================');
      console.log('[GoogleOAuthHandler] Access token (expires in 1 hour):');
      console.log(`GOOGLE_DRIVE_TOKEN=${googleAccessToken}`);
      if (googleRefreshToken) {
        console.log('[GoogleOAuthHandler]');
        console.log('[GoogleOAuthHandler] Refresh token (for auto-renewal):');
        console.log(`GOOGLE_REFRESH_TOKEN=${googleRefreshToken}`);
      }
      console.log('[GoogleOAuthHandler] ========================================');

      // Store OAuth credentials temporarily in session (will be completed by the client with displayName)
      const serviceType = req.session.googleService || 'google-drive';
      req.session.pendingGoogleOAuth = {
        credentials: {
          accessToken: googleAccessToken,
          refreshToken: googleRefreshToken || '', // May be empty on re-auth without consent prompt
          email: googleUser.email,
          name: googleUser.name,
        },
        serviceType,
        timestamp: Date.now(),
      };

      console.log(
        `[GoogleOAuthHandler] ✓ Google OAuth completed, credentials stored temporarily. Waiting for frontend to complete connection with displayName.`
      );

      // Keep googleConnectionName for the complete-oauth endpoint
      // Clean up other OAuth state
      delete req.session.googleService;

      // Save session
      req.session.save((err) => {
        if (err) {
          console.error('[GoogleOAuthHandler] Error saving session after Google OAuth:', err);
          res.status(500).send('Failed to complete Google OAuth');
          return;
        }

        // If opened in popup (from connection modal), close the popup
        // Otherwise, redirect to profile page
        res.send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Connected</title>
              <script>
                if (window.opener) {
                  // Opened in popup - close it
                  window.close();
                } else {
                  // Opened in main window - redirect
                  window.location.href = '/profile';
                }
              </script>
            </head>
            <body>
              <p>Connection successful! This window will close automatically...</p>
            </body>
          </html>
        `);
      });
    } catch (error) {
      console.error('[GoogleOAuthHandler] Google OAuth error:', error);
      res.status(500).send('Google authentication failed');
    }
  }

  /**
   * Disconnect Google Drive
   * NOTE: Deprecated - use /api/connections/:connectionId DELETE endpoint instead
   */
  async handleGoogleDisconnect(req: OAuthRequest, res: Response): Promise<void> {
    // This endpoint is deprecated - all connection management now goes through /api/connections
    // However, we keep this for backward compatibility
    console.warn(
      '[GoogleOAuthHandler] handleGoogleDisconnect is deprecated - use /api/connections/:connectionId DELETE instead'
    );

    if (!this.dependencies.connectionsService || !req.session.userEmail) {
      res.status(400).json({ error: 'Unable to disconnect - missing required data' });
      return;
    }

    try {
      // Find and delete all Google Drive connections for this user
      const connections = await this.dependencies.connectionsService.getUserConnections({
        userId: req.session.userEmail,
        authToken: req.session.authToken,
      });
      const googleConnections = connections.filter((c: any) => c.service === 'google-drive');

      for (const conn of googleConnections) {
        await this.dependencies.connectionsService.deleteConnection({
          userId: req.session.userEmail,
          connectionId: conn.connectionId,
          authToken: req.session.authToken,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[GoogleOAuthHandler] Error disconnecting Google Drive:', error);
      res.status(500).json({ error: 'Failed to disconnect Google Drive' });
    }
  }

  /**
   * Refresh Google Drive access token using refresh token
   * Returns new access token or null if refresh fails
   *
   * NOTE: Token refresh requires the OAuth service. If not configured, returns null.
   * In production, token refresh should be handled via ConnectionsService which
   * calls the OAuth service for token refresh.
   */
  async refreshGoogleToken(refreshToken: string): Promise<string | null> {
    try {
      console.log('[GoogleOAuthHandler] Refreshing Google Drive access token...');

      if (!GITHUB_APP_SERVICE_URL) {
        console.error(
          '[GoogleOAuthHandler] OAuth service URL not configured - cannot refresh Google token'
        );
        return null;
      }

      // TODO: Add /oauth/google/refresh-token endpoint to OAuth service
      // For now, token refresh is handled by ConnectionsService via RunConnectionService
      console.warn(
        '[GoogleOAuthHandler] Google token refresh via OAuth service not yet implemented'
      );
      return null;
    } catch (error: any) {
      console.error('[GoogleOAuthHandler] Error refreshing Google token:', error);
      return null;
    }
  }

  /**
   * Get valid Google Drive token from session (with auto-refresh)
   * Returns access token or null if not available
   */
  async getValidGoogleToken(session: any): Promise<string | null> {
    if (!session) {
      return null;
    }

    // If we have an access token, return it (we'll handle expiry via API errors)
    if (session.googleDriveToken) {
      return session.googleDriveToken;
    }

    // If no access token but we have a refresh token, try to refresh
    if (session.googleRefreshToken) {
      console.log('[GoogleOAuthHandler] No access token found, attempting to refresh...');
      const newAccessToken = await this.refreshGoogleToken(session.googleRefreshToken);

      if (newAccessToken) {
        // Update session with new access token
        session.googleDriveToken = newAccessToken;
        return newAccessToken;
      }
    }

    return null;
  }
}
