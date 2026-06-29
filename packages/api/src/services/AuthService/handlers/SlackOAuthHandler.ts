import crypto from 'crypto';

import { GITHUB_APP_SERVICE_URL, debugLog } from '@vgit2/shared/constants';
import { Response } from 'express';

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';

import type { OAuthRequest, HandlerDependencies, SlackTokenExchangeResult } from '../types';

/**
 * SlackOAuthHandler - Handles Slack OAuth authentication flow
 *
 * Responsibilities:
 * - Slack OAuth URL generation
 * - Authorization code exchange
 * - OAuth callback handling
 * - Token validation
 * - Service disconnection
 */
export class SlackOAuthHandler {
  private dependencies: HandlerDependencies;

  constructor(dependencies: HandlerDependencies) {
    this.dependencies = dependencies;
    debugLog('[SlackOAuthHandler] Initialized');
  }

  /**
   * Generate Slack OAuth URL via remote OAuth service (production)
   */
  private async generateSlackOAuthUrlViaService(
    res: Response,
    state: string,
    redirectUri: string,
    userToken: string
  ): Promise<void> {
    try {
      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/slack/authorize-url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            redirectUri,
            state,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OAuth Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { url: string };
      console.log('[SlackOAuthHandler] ✓ Slack OAuth URL received from service');
      res.redirect(data.url);
    } catch (error) {
      console.error('[SlackOAuthHandler] Failed to generate Slack OAuth URL via service:', error);
      res.status(500).send('Failed to generate Slack OAuth URL');
    }
  }

  /**
   * Exchange Slack OAuth code for tokens via remote OAuth service (production)
   */
  private async exchangeSlackCodeViaService(
    code: string,
    redirectUri: string,
    userToken: string
  ): Promise<SlackTokenExchangeResult> {
    try {
      console.log('[SlackOAuthHandler] Exchanging Slack code via OAuth Service');

      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/slack/exchange-code`,
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
        ok: boolean;
        accessToken: string;
        tokenType: string;
        scope: string;
        team?: { id: string; name: string };
        authedUser?: { id: string; accessToken: string; scope: string };
        error?: string;
      };
      console.log('[SlackOAuthHandler] ✓ Slack tokens received from service');

      return data;
    } catch (error) {
      console.error('[SlackOAuthHandler] Failed to exchange Slack code via service:', error);
      throw error;
    }
  }

  /**
   * Initiate Slack OAuth flow for workspace access
   */
  handleSlackLogin(req: OAuthRequest, res: Response): void {
    const state = crypto.randomBytes(16).toString('hex');
    const connectionId = (req.query.connectionId as string) || 'slack_default';

    req.session.slackOauthState = state;
    req.session.slackConnectionName = connectionId;

    // IMPORTANT: Save session before redirect to ensure OAuth state persists
    req.session.save((err) => {
      if (err) {
        console.error('[SlackOAuthHandler] Error saving session before Slack OAuth redirect:', err);
        res.status(500).send('Failed to initialize Slack OAuth flow');
        return;
      }

      console.log(
        '[SlackOAuthHandler] Slack OAuth session saved, state:',
        state,
        'connectionId:',
        connectionId
      );

      const redirectUri = `${req.protocol}://${req.get('host')}/auth/slack/callback`;

      // OAuth service is required for Slack OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        console.error(
          '[SlackOAuthHandler] GITHUB_APP_SERVICE_URL not configured - Slack OAuth requires the OAuth service'
        );
        res.status(500).send('Slack OAuth not configured. OAuth service URL is required.');
        return;
      }

      console.log('[SlackOAuthHandler] Using OAuth Service for Slack OAuth');
      const userToken = req.session?.authToken || '';
      this.generateSlackOAuthUrlViaService(res, state, redirectUri, userToken);
    });
  }

  /**
   * Handle Slack OAuth callback
   */
  async handleSlackCallback(req: OAuthRequest, res: Response): Promise<void> {
    const { code, state } = req.query;

    console.log('[SlackOAuthHandler] ========================================');
    console.log('[SlackOAuthHandler] Slack OAuth callback received');
    console.log('[SlackOAuthHandler] Code:', code ? 'Present' : 'MISSING!');
    console.log('[SlackOAuthHandler] State:', state ? 'Present' : 'MISSING!');
    console.log('[SlackOAuthHandler] Session State:', req.session.slackOauthState || 'MISSING!');
    console.log('[SlackOAuthHandler] ========================================');

    // Validate state
    if (state !== req.session.slackOauthState) {
      console.error('[SlackOAuthHandler] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌');
      console.error('[SlackOAuthHandler] ❌ SLACK OAUTH STATE VALIDATION FAILED!');
      console.error('[SlackOAuthHandler] ❌ Expected:', req.session.slackOauthState);
      console.error('[SlackOAuthHandler] ❌ Received:', state);
      console.error('[SlackOAuthHandler] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌');
      res.status(400).send('Invalid state parameter - CSRF protection failed');
      return;
    }

    console.log('[SlackOAuthHandler] Slack OAuth state validation passed ✓');

    try {
      const redirectUri = `${req.protocol}://${req.get('host')}/auth/slack/callback`;

      // OAuth service is required for Slack OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        throw new Error('Slack OAuth not configured. OAuth service URL is required.');
      }

      console.log('[SlackOAuthHandler] Using OAuth Service for Slack token exchange');
      const userToken = req.session?.authToken || '';
      const tokenData = await this.exchangeSlackCodeViaService(
        code as string,
        redirectUri,
        userToken
      );

      if (!tokenData.ok) {
        console.error('[SlackOAuthHandler] ❌ SLACK OAUTH FAILED!');
        console.error('[SlackOAuthHandler] ❌ Error:', tokenData.error);
        console.error('[SlackOAuthHandler] Common issues:');
        console.error(
          '[SlackOAuthHandler] 1. Check OAuth service has SLACK_CLIENT_ID and SLACK_CLIENT_SECRET configured'
        );
        console.error(
          '[SlackOAuthHandler] 2. Make sure redirect URL matches exactly in Slack app settings'
        );
        console.error('[SlackOAuthHandler] 3. Verify all OAuth scopes are valid for user tokens');
        throw new Error(tokenData.error || 'Failed to exchange code for token');
      }

      const slackTeam = tokenData.team;
      const slackUser = tokenData.authedUser;

      // Slack OAuth v2: user token is at authed_user.accessToken, NOT at top-level accessToken
      // Top-level accessToken is the bot token (if bot scopes were requested)
      const slackAccessToken = slackUser?.accessToken || tokenData.accessToken;
      const slackScopes = slackUser?.scope;

      console.log('[SlackOAuthHandler] ========================================');
      console.log('[SlackOAuthHandler] ✓ Slack OAuth Success!');
      console.log('[SlackOAuthHandler] User ID:', slackUser?.id);
      console.log('[SlackOAuthHandler] Team:', slackTeam?.name);
      console.log('[SlackOAuthHandler] User Scopes:', slackScopes);
      console.log('[SlackOAuthHandler] Has user token:', !!slackUser?.accessToken);
      console.log('[SlackOAuthHandler] Has bot token:', !!tokenData.accessToken);
      console.log('[SlackOAuthHandler] ========================================');
      console.log('[SlackOAuthHandler] 📋 Copy this token to .env if needed:');
      console.log('[SlackOAuthHandler] ========================================');
      console.log('[SlackOAuthHandler] Slack access token (does not expire):');
      console.log(
        `SLACK_TOKEN=${slackAccessToken ? slackAccessToken.substring(0, 20) + '...' : 'MISSING!'}`
      );
      console.log('[SlackOAuthHandler] ========================================');

      // CRITICAL: Fail fast if token is missing - don't save a broken connection
      if (!slackAccessToken) {
        console.error(
          '[SlackOAuthHandler] ⚠️  CRITICAL: Slack access token is missing from OAuth response!'
        );
        console.error(
          '[SlackOAuthHandler] This usually means the OAuth app is missing user token scopes.'
        );
        console.error(
          '[SlackOAuthHandler] Check your Slack app configuration at https://api.slack.com/apps'
        );
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Slack Connection Failed</title></head>
          <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Slack Connection Failed</h1>
            <p>The OAuth flow completed but no access token was received.</p>
            <p>This usually means the Slack app is misconfigured. Please contact support.</p>
            <button onclick="window.close()" style="padding: 10px 20px; cursor: pointer;">Close</button>
          </body>
          </html>
        `);
        return;
      }

      // Store OAuth credentials temporarily in session (will be completed by the client with displayName)
      const credentials = {
        token: slackAccessToken,
        teamId: slackTeam?.id,
        teamName: slackTeam?.name,
        userId: slackUser?.id,
      };

      req.session.pendingSlackOAuth = {
        credentials,
        timestamp: Date.now(),
      };

      console.log(
        `[SlackOAuthHandler] ✓ Slack OAuth completed, credentials stored temporarily. Waiting for frontend to complete connection with displayName.`
      );

      // Keep slackConnectionName for the complete-oauth endpoint
      // No other OAuth state to clean up

      // Save session
      req.session.save((err) => {
        if (err) {
          console.error('[SlackOAuthHandler] Error saving session after Slack OAuth:', err);
          res.status(500).send('Failed to complete Slack OAuth');
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
      console.error('[SlackOAuthHandler] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌');
      console.error('[SlackOAuthHandler] ❌ SLACK OAUTH EXCEPTION!');
      console.error('[SlackOAuthHandler] ❌ Error:', error);
      console.error(
        '[SlackOAuthHandler] ❌ Stack:',
        error instanceof Error ? error.stack : 'No stack trace'
      );
      console.error('[SlackOAuthHandler] ❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌');
      res.status(500).send('Slack authentication failed - check server logs');
    }
  }

  /**
   * Disconnect Slack
   * NOTE: Deprecated - use /api/connections/:connectionId DELETE endpoint instead
   */
  async handleSlackDisconnect(req: OAuthRequest, res: Response): Promise<void> {
    // This endpoint is deprecated - all connection management now goes through /api/connections
    // However, we keep this for backward compatibility
    console.warn(
      '[SlackOAuthHandler] handleSlackDisconnect is deprecated - use /api/connections/:connectionId DELETE instead'
    );

    if (!this.dependencies.connectionsService || !req.session.userEmail) {
      res.status(400).json({ error: 'Unable to disconnect - missing required data' });
      return;
    }

    try {
      // Find and delete all Slack connections for this user
      const connections = await this.dependencies.connectionsService.getUserConnections({
        userId: req.session.userEmail,
        authToken: req.session.authToken,
      });
      const slackConnections = connections.filter((c: any) => c.service === 'slack');

      for (const conn of slackConnections) {
        await this.dependencies.connectionsService.deleteConnection({
          userId: req.session.userEmail,
          connectionId: conn.connectionId,
          authToken: req.session.authToken,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('[SlackOAuthHandler] Error disconnecting Slack:', error);
      res.status(500).json({ error: 'Failed to disconnect Slack' });
    }
  }

  /**
   * Get valid Slack token from session
   * Returns access token or null if not available
   */
  async getValidSlackToken(session: any): Promise<string | null> {
    if (!session || !session.slackToken) {
      return null;
    }

    // Slack tokens don't expire like Google tokens, but we should check validity
    // We can do a simple API call to verify the token is still valid
    try {
      const response = await fetchWithTimeout('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.slackToken}`,
          'Content-Type': 'application/json',
        },
      });

      const data = (await response.json()) as any;

      if (data.ok) {
        return session.slackToken;
      } else {
        console.error('[SlackOAuthHandler] Slack token validation failed:', data.error);
        // Token is invalid, clear it from session
        delete session.slackToken;
        delete session.slackUser;
        delete session.slackTeam;
        return null;
      }
    } catch (error) {
      console.error('[SlackOAuthHandler] Error validating Slack token:', error);
      return null;
    }
  }
}
