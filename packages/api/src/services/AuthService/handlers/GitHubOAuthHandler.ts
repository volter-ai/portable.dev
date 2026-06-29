import crypto from 'crypto';

import { Octokit } from '@octokit/rest';
import * as constants from '@vgit2/shared/constants';
import { GITHUB_APP_SERVICE_URL, debugLog, shouldLog } from '@vgit2/shared/constants';
import { generateAuthToken } from '@vgit2/shared/jwt';
import { Response } from 'express';

import { fetchWithTimeout } from '../../../utils/fetchWithTimeout.js';
import serviceTokenLoader from '../../ServiceTokenLoader.js';

import type { OAuthRequest, HandlerDependencies, WaitlistEntry } from '../types';

/**
 * GitHubOAuthHandler - Handles GitHub OAuth authentication flow
 *
 * Responsibilities:
 * - GitHub OAuth URL generation
 * - Authorization code exchange
 * - OAuth callback handling
 * - gh CLI configuration for development
 */
export class GitHubOAuthHandler {
  private waitlist: WaitlistEntry[];
  private userValidationHandler: any; // Will be injected to avoid circular dependency

  constructor(_dependencies: HandlerDependencies, waitlist: WaitlistEntry[]) {
    this.waitlist = waitlist;
    debugLog('[GitHubOAuthHandler] Initialized');
  }

  /**
   * Set UserValidationHandler (to avoid circular dependency)
   */
  setUserValidationHandler(handler: any): void {
    this.userValidationHandler = handler;
  }

  /**
   * Generate OAuth URL via remote GitHub App Service (production)
   * @param returnJson - If true, returns URL as JSON; if false, redirects to URL
   */
  async generateOAuthUrlViaService(
    res: Response,
    state: string,
    returnJson: boolean = false
  ): Promise<void> {
    try {
      const redirectUri = `${constants.GATEWAY_URL}/auth/github/callback`;
      const scopes = ['repo', 'workflow', 'read:user', 'user:email', 'read:org'];

      // Service-to-service authentication uses SERVICE_TOKEN
      const serviceToken = serviceTokenLoader.getToken();

      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/github/authorize-url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceToken}`, // Service token for inter-service auth
          },
          body: JSON.stringify({
            redirectUri,
            state,
            scopes,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub App Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { url: string };

      if (returnJson) {
        // Mobile: Return URL as JSON
        console.log('[GitHubOAuthHandler] ✓ OAuth URL received from service (JSON response)');
        res.json({ url: data.url });
      } else {
        // Web: Redirect to OAuth URL
        console.log('[GitHubOAuthHandler] ✓ OAuth URL received from service (redirecting)');
        res.redirect(data.url);
      }
    } catch (error) {
      console.error('[GitHubOAuthHandler] Failed to generate OAuth URL via service:', error);
      if (returnJson) {
        res.status(500).json({ error: 'Failed to generate OAuth URL' });
      } else {
        res.status(500).send('Failed to generate OAuth URL');
      }
    }
  }

  /**
   * Exchange OAuth code for access token via remote GitHub App Service (production)
   */
  async exchangeCodeViaService(code: string): Promise<string> {
    try {
      console.log('[GitHubOAuthHandler] Exchanging code via GitHub App Service');

      // Service-to-service authentication uses SERVICE_TOKEN
      const serviceToken = serviceTokenLoader.getToken();

      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/github/exchange-code`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceToken}`, // Service token for inter-service auth
          },
          body: JSON.stringify({ code }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        // Distinguish between invalid code (400) and other errors
        if (response.status === 400) {
          const error = new Error(`Invalid authorization code: ${errorText}`);
          (error as any).isInvalidCode = true;
          throw error;
        }
        throw new Error(`GitHub App Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        accessToken: string;
        scope: string;
        tokenType: string;
      };
      console.log('[GitHubOAuthHandler] ✓ Access token received from service');

      return data.accessToken;
    } catch (error) {
      console.error('[GitHubOAuthHandler] Failed to exchange code via service:', error);
      throw error;
    }
  }

  /**
   * Generate org access OAuth URL via remote GitHub App Service
   *
   * Returns the URL as JSON for the client to open in a popup.
   * The redirect URI points to github-app service's org-access-callback.
   */
  async generateOrgAccessUrl(res: Response, userId: string, userEmail: string): Promise<void> {
    try {
      if (!GITHUB_APP_SERVICE_URL) {
        console.error('[GitHubOAuthHandler] GITHUB_APP_SERVICE_URL not configured');
        res.status(500).json({ error: 'GitHub App service not configured' });
        return;
      }

      // Use the same callback URL as regular OAuth (GitHub App only allows one callback URL)
      const redirectUri = `${constants.GATEWAY_URL}/auth/github/callback`;

      // Encode user identity in state so the gateway callback can store the connection
      // Add type: 'org-access' so the gateway can differentiate from regular OAuth
      const state = Buffer.from(
        JSON.stringify({ userId, email: userEmail, type: 'org-access' })
      ).toString('base64');

      const serviceToken = serviceTokenLoader.getToken();

      const response = await fetchWithTimeout(
        `${GITHUB_APP_SERVICE_URL}/oauth/github/org-access-url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceToken}`,
          },
          body: JSON.stringify({ redirectUri, state }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub App Service error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { url: string };
      console.log('[GitHubOAuthHandler] ✓ Org access URL received from service');
      res.json({ url: data.url });
    } catch (error) {
      console.error('[GitHubOAuthHandler] Failed to generate org access URL:', error);
      res.status(500).json({ error: 'Failed to generate org access URL' });
    }
  }

  /**
   * Initiate GitHub OAuth flow
   */
  handleGitHubLogin(req: OAuthRequest, res: Response): void {
    // Create state object with userId and returnTo for Gateway callback
    // Gateway will resolve Clerk ID to email automatically via Clerk API
    // Prioritize query param (from the mobile app) over session
    const userId =
      (req.query.userId as string) || req.session.userId || req.session.userEmail || '';
    const returnTo = (req.query.returnTo as string) || '/';

    const stateObject = {
      oauthState: crypto.randomBytes(16).toString('hex'),
      userId,
      returnTo,
    };

    // Encode state as base64 JSON (will be decoded by Gateway callback)
    const state = Buffer.from(JSON.stringify(stateObject)).toString('base64');

    // Store just the oauthState hex in session for validation (backward compatibility)
    req.session.oauthState = stateObject.oauthState;

    // Store mobile flag if provided (for mobile app OAuth flows)
    if (req.query.mobile === 'true') {
      req.session.isMobileOAuth = true;
      console.log('[GitHubOAuthHandler] Mobile OAuth flow detected');
    }

    // Store the returnTo URL if provided (keep for backward compatibility)
    if (req.query.returnTo) {
      req.session.returnTo = req.query.returnTo as string;
    }

    // Store upgrade_scopes flag if provided
    if (req.query.upgrade_scopes === 'true') {
      req.session.upgradeScopes = true;
      console.log('[GitHubOAuthHandler] Scope upgrade requested');
    }

    // Store connectionId if this is a connection flow (from ConnectionModal)
    if (req.query.connectionId) {
      req.session.githubConnectionId = req.query.connectionId as string;
    }

    // IMPORTANT: Save session before redirect to ensure OAuth state persists
    req.session.save((err) => {
      if (err) {
        console.error('[GitHubOAuthHandler] Error saving session before OAuth redirect:', err);
        res.status(500).send('Failed to initialize OAuth flow');
        return;
      }

      console.log('[GitHubOAuthHandler] Session saved, OAuth state:', stateObject.oauthState);
      console.log('[GitHubOAuthHandler] State includes userId and returnTo for Gateway callback');
      console.log('[GitHubOAuthHandler] Session ID:', req.sessionID);

      // OAuth service is required for GitHub OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        console.error(
          '[GitHubOAuthHandler] GITHUB_APP_SERVICE_URL not configured - GitHub OAuth requires the OAuth service'
        );
        res.status(500).send('GitHub OAuth not configured. OAuth service URL is required.');
        return;
      }

      // Detect if mobile client (should return JSON instead of redirect)
      const returnJson = req.query.mobile === 'true';
      console.log(
        '[GitHubOAuthHandler] Using OAuth Service for GitHub OAuth',
        returnJson ? '(JSON response)' : '(redirect)'
      );
      this.generateOAuthUrlViaService(res, state, returnJson);
    });
  }

  /**
   * Handle GitHub OAuth callback
   */
  async handleGitHubCallback(req: OAuthRequest, res: Response): Promise<void> {
    const { code, state, error, error_description } = req.query;

    // Check for OAuth error (user denied access or other OAuth error)
    if (error) {
      console.error('[GitHubOAuthHandler] OAuth error:', error, error_description);
      res.status(400).send(`OAuth error: ${error_description || error}`);
      return;
    }

    // Check for missing code parameter
    if (!code || typeof code !== 'string') {
      console.error('[GitHubOAuthHandler] Missing code parameter in callback');
      res.status(400).send('Missing authorization code');
      return;
    }

    // Validate state (decode base64 JSON and compare oauthState)
    let decodedState: { oauthState: string; userId: string; returnTo: string } | null = null;
    try {
      if (state && typeof state === 'string') {
        decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        if (decodedState?.oauthState !== req.session.oauthState) {
          console.error('[GitHubOAuthHandler] State validation failed');
          res.status(400).send('Invalid state parameter');
          return;
        }
      } else {
        console.error('[GitHubOAuthHandler] Missing state parameter');
        res.status(400).send('Missing state parameter');
        return;
      }
    } catch (error) {
      console.error('[GitHubOAuthHandler] Failed to decode state:', error);
      res.status(400).send('Invalid state parameter');
      return;
    }

    try {
      // OAuth service is required for GitHub OAuth
      if (!GITHUB_APP_SERVICE_URL) {
        throw new Error('GitHub OAuth not configured. OAuth service URL is required.');
      }

      // Exchange code for access token via OAuth service
      console.log('[GitHubOAuthHandler] Using OAuth Service for GitHub token exchange');
      const accessToken = await this.exchangeCodeViaService(code);

      // Fetch user info FIRST (before storing token). 30s request timeout so the
      // OAuth callback can't hang forever if GitHub is offline.
      const tempOctokit = new Octokit({ auth: accessToken, request: { timeout: 30000 } });
      const { data: user } = await tempOctokit.users.getAuthenticated();

      // Fetch user's email addresses
      const { data: emails } = await tempOctokit.users.listEmailsForAuthenticatedUser();
      const primaryEmail = emails.find((e) => e.primary)?.email || user.email;

      // Extract GitHub scopes from token (matches gateway flow)
      // Use GitHub API to get scopes from X-OAuth-Scopes header
      let githubScopes: string[] = [];
      try {
        const scopeResponse = await fetchWithTimeout('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        if (scopeResponse.ok) {
          const scopesHeader = scopeResponse.headers.get('x-oauth-scopes');
          if (scopesHeader) {
            githubScopes = scopesHeader
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            console.log('[GitHubOAuthHandler] GitHub scopes extracted from token:', githubScopes);
          }
        } else {
          console.warn(
            '[GitHubOAuthHandler] Failed to fetch scopes from GitHub API, using default'
          );
        }
      } catch (error) {
        console.warn('[GitHubOAuthHandler] Error extracting GitHub scopes:', error);
      }

      // Default to basic scopes if extraction failed
      if (githubScopes.length === 0) {
        githubScopes = ['public_repo', 'read:user', 'user:email'];
        console.log('[GitHubOAuthHandler] Using default scopes:', githubScopes);
      }

      // Check if user is on allowlist (case-insensitive)
      const isAllowed = await this.userValidationHandler?.checkAllowedEmail(primaryEmail || '');

      if (!isAllowed) {
        // User NOT on allowlist - DO NOT store GitHub token
        // Add to waitlist if not already there
        if (!this.waitlist.some((w) => w.email === primaryEmail)) {
          this.waitlist.push({
            email: primaryEmail || user.login,
            username: user.login,
            addedAt: new Date(),
          });
          console.log(
            `[GitHubOAuth] ⚠️  Unauthorized login attempt: ${user.login} (${primaryEmail}) - added to waitlist`
          );
        }

        // Store minimal session data (NO GitHub token!)
        req.session.onWaitlist = true;
        req.session.githubUser = user;
        req.session.userEmail = primaryEmail || undefined;
        // NOTE: GitHub tokens are managed via ConnectionsService, not session

        // Save session before redirect to ensure data persists
        req.session.save((err) => {
          if (err) {
            console.error('Session save error:', err);
            res.status(500).send('Failed to save session');
            return;
          }
          // Redirect to waitlist page
          res.redirect('/?waitlist=true');
        });
        return;
      }

      // Check if this is a connection flow (from ConnectionModal)
      // If so, store credentials temporarily and close popup instead of normal login flow
      if (req.session.githubConnectionId) {
        // Store OAuth credentials temporarily in session (will be completed by the client with displayName)
        req.session.pendingGitHubOAuth = {
          credentials: {
            token: accessToken,
            username: user.login,
            email: primaryEmail || undefined,
            userId: user.id,
            avatarUrl: user.avatar_url,
          },
          timestamp: Date.now(),
        };

        // Save session and close popup
        req.session.save((err) => {
          if (err) {
            console.error('[GitHubOAuthHandler] Error saving session after GitHub OAuth:', err);
            res.status(500).send('Failed to complete GitHub OAuth');
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
        return;
      }

      // User is allowed - store full session data
      const wasUpgrade = req.session.upgradeScopes || false;
      req.session.githubUser = user;
      req.session.username = user.login; // REQUIRED: Store GitHub username for git commits
      req.session.userEmail = primaryEmail || undefined;
      req.session.onWaitlist = false;

      // Always generate JWT for authentication
      // SECURITY: GitHub token stored in database via ConnectionsService, NOT in JWT
      const authToken = generateAuthToken({
        userId: user.id.toString(),
        username: user.login,
        email: primaryEmail || user.login,
        avatarUrl: user.avatar_url,
      });
      req.session.authToken = authToken;

      // Compact log at INFO level
      const isOnWaitlist = this.waitlist.some((w) => w.email === primaryEmail);
      const status = isAllowed ? '✓' : isOnWaitlist ? '⏳ waitlist' : '✗ denied';
      console.log(`[GitHubOAuth] OAuth success: ${user.login} (${primaryEmail}) ${status}`);

      // Verbose details at DEBUG level
      if (shouldLog('debug')) {
        console.log(`[GitHubOAuth] Token: ${accessToken.substring(0, 10)}...`);
        console.log(`[GitHubOAuth] User:`, user);
        console.log(`[GitHubOAuth] Emails:`, emails);
        console.log(`[GitHubOAuth] Primary email: ${primaryEmail}`);
        console.log(`[GitHubOAuth] Is allowed: ${isAllowed}`);
        console.log(`[GitHubOAuth] On waitlist: ${isOnWaitlist}`);
        console.log(`[GitHubOAuth] Return to: ${req.session.returnTo || '/'}`);
        console.log(`[GitHubOAuth] Session ID: ${req.sessionID}`);
      }

      // Configure gh CLI for local development (non-blocking)
      if (constants.NODE_ENV !== 'production') {
        // Run in background to avoid blocking the OAuth redirect
        this.configureGhCliForDev(accessToken, user.login).catch((err) => {
          console.warn('[GitHubOAuthHandler] gh CLI configuration failed:', err);
        });
      }

      // Check if this is a mobile OAuth flow (from the mobile app)
      const isMobileOAuth = req.session.isMobileOAuth === true;

      if (isMobileOAuth) {
        // Mobile flow: Return deeplink instead of HTTP redirect
        // The mobile app will intercept this deeplink and handle the token
        const deeplink = `portable://auth/github-complete?token=${encodeURIComponent(authToken)}&scopes_updated=${wasUpgrade}`;

        console.log('[GitHubOAuthHandler] Mobile OAuth complete, returning deeplink:', deeplink);

        // Clear mobile flag and other session data
        delete req.session.isMobileOAuth;
        delete req.session.returnTo;
        delete req.session.upgradeScopes;

        // Save session and redirect to deeplink
        req.session.save((err) => {
          if (err) {
            console.error('[GitHubOAuthHandler] Session save error:', err);
            res.status(500).send('Failed to save session');
            return;
          }
          // Redirect to deeplink - the browser will try to open this
          // and the mobile app will intercept it
          res.redirect(deeplink);
        });
      } else {
        // Web flow: Normal HTTP redirect (existing code)
        // Always redirect to home page (/) to ensure token is properly extracted
        // This prevents redirecting to /signin which would trigger token clearing
        let returnTo = '/';

        if (wasUpgrade) {
          const separator = returnTo.includes('?') ? '&' : '?';
          returnTo += `${separator}scopes_updated=true`;
        }

        // Always add token to URL for client extraction
        const separator = returnTo.includes('?') ? '&' : '?';
        returnTo += `${separator}token=${encodeURIComponent(authToken)}`;

        delete req.session.returnTo; // Clear it after use
        delete req.session.upgradeScopes; // Clear upgrade flag

        // NOTE: Git credentials update moved to /auth/check-github-permissions
        // This ensures credentials are updated whenever permissions are verified,
        // not just during OAuth callbacks (which may not run if connection already exists)

        // IMPORTANT: Save session before redirect to ensure data persists
        req.session.save((err) => {
          if (err) {
            console.error('[GitHubOAuthHandler] Session save error:', err);
            res.status(500).send('Failed to save session');
            return;
          }
          res.redirect(returnTo);
        });
      }
    } catch (error: any) {
      console.error('Error during OAuth callback:', error);
      // Return 400 for invalid code errors, 500 for other errors
      if (error?.isInvalidCode) {
        res.status(400).send('Invalid or expired authorization code');
      } else {
        res.status(500).send('Authentication failed');
      }
    }
  }

  /**
   * Configure gh CLI for local development
   * Automatically authenticates gh CLI with GitHub token after OAuth
   * Non-blocking - logs warnings if configuration fails
   */
  private async configureGhCliForDev(token: string, username: string): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check if gh CLI is installed
      try {
        await execAsync('gh --version');
      } catch (_versionError) {
        console.log('[GitHubOAuthHandler] gh CLI not installed, skipping auto-configuration');
        console.log(
          '[GitHubOAuthHandler] Install with: brew install gh (macOS) or apt-get install gh (Linux)'
        );
        return;
      }

      console.log('[GitHubOAuthHandler] Configuring gh CLI for local development...');

      // Authenticate gh CLI with token
      const command = `echo '${token}' | gh auth login --with-token`;
      await execAsync(command);

      // Verify authentication
      const { stdout } = await execAsync('gh auth status');
      console.log('[GitHubOAuthHandler] ✓ gh CLI configured successfully for user:', username);
      console.log('[GitHubOAuthHandler] gh CLI status:', stdout.trim().split('\n')[0]); // First line only
    } catch (error) {
      console.warn(
        '[GitHubOAuthHandler] ⚠️  WARNING: Failed to configure gh CLI (non-critical):',
        error instanceof Error ? error.message : String(error)
      );
      console.warn(
        '[GitHubOAuthHandler] You can manually configure gh CLI by running: gh auth login'
      );
    }
  }
}
