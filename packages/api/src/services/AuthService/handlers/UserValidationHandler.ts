import { Octokit } from '@octokit/rest';
import { ALLOWED_EMAILS } from '@vgit2/shared/constants';
import { isJwtConfigured, verifyAuthToken, decodeAuthToken } from '@vgit2/shared/jwt';
import { Response } from 'express';

import type { OAuthRequest, HandlerDependencies, WaitlistEntry } from '../types';
import type { GetUserResponse, ServiceConnection } from '@vgit2/shared/types';

/**
 * UserValidationHandler - Manages user validation and authentication
 *
 * Responsibilities:
 * - User email validation
 * - Allowlist checking
 * - User session management
 * - Socket authentication
 * - Waitlist management
 */
export class UserValidationHandler {
  private dependencies: HandlerDependencies;
  private waitlist: WaitlistEntry[];

  constructor(dependencies: HandlerDependencies, waitlist: WaitlistEntry[]) {
    this.dependencies = dependencies;
    this.waitlist = waitlist;
    console.log('[UserValidationHandler] Initialized');
  }

  /**
   * Get current user info
   *
   * Extracts all user info from the JWT in the Authorization header (validated
   * locally via @vgit2/shared/jwt). NO session access - requireAuth middleware
   * handles authentication verification.
   */
  async getUser(req: OAuthRequest, res: Response): Promise<void> {
    // requireAuth middleware guarantees authentication
    // Extract JWT from Authorization header (all requests include this)
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!authToken) {
      res.status(401).json({ error: 'No authorization token provided' });
      return;
    }

    // Validate the JWT locally (@vgit2/shared/jwt) and read user info from the payload.
    const jwtPayload = verifyAuthToken(authToken);
    const userEmail = jwtPayload.email;
    const userId = jwtPayload.userId;
    const username = jwtPayload.username;
    const avatarUrl = jwtPayload.avatarUrl || '';

    // Auto-create the GitHub connector (fire-and-forget)
    // Note: GitHub token is retrieved from Clerk secrets via ConnectionsService, not from JWT
    if (this.dependencies.autoConnectorService && userEmail) {
      this.dependencies.autoConnectorService
        .ensureDefaultConnectors(
          userEmail,
          authToken,
          undefined // GitHub token comes from Clerk secrets, not JWT
        )
        .catch((err: Error) => {
          console.error('[UserValidationHandler] Auto-connector creation failed:', err.message);
        });
    }

    // Build user object from JWT payload
    const user = {
      login: username,
      id: userId,
      email: userEmail,
      avatar_url: avatarUrl,
      name: username,
      public_repos: 0, // Placeholder - not available from JWT
      followers: 0, // Placeholder - not available from JWT
      following: 0, // Placeholder - not available from JWT
    };

    const response: GetUserResponse = {
      user,
      username: username,
      userId: userId,
      email: userEmail,
      onWaitlist: false, // TODO: Get from database if needed
    };
    // Include additional fields not in GetUserResponse type (authToken, connectedServices, token)
    res.json({
      ...response,
      token: undefined, // GitHub token lives in backend, not returned from this endpoint
      authToken: authToken, // JWT auth token
      connectedServices: await this.getConnectedServicesStatus(userEmail, authToken),
    });
  }

  /**
   * Get user email from token (JWT or GitHub token)
   * Note: Allowlist verification is handled at the Gateway level during OAuth
   */
  async getUserEmail(userToken: string): Promise<string> {
    try {
      // First, try to decode as JWT (3 parts separated by dots)
      if (userToken.includes('.') && userToken.split('.').length === 3) {
        try {
          // Validate the JWT locally (@vgit2/shared/jwt). The remote
          // TokenValidationService was retired (local-first).
          if (!isJwtConfigured()) {
            throw new Error('No JWT validation method configured');
          }
          const payload = verifyAuthToken(userToken);
          console.log(`[UserValidation] JWT validated locally`);

          const email = payload.email || payload.sub;

          if (email) {
            // console.log(`[UserValidation] JWT auth successful for: ${email}`);
            return email;
          }
        } catch (_jwtError) {
          // JWT verification failed, fall back to GitHub token
          console.log(`[UserValidation] JWT verification failed, trying GitHub token...`);
        }
      }

      // Fall back to GitHub token authentication. 30s request timeout so a
      // GitHub outage can't hang this auth path forever.
      const userOctokit = new Octokit({ auth: userToken, request: { timeout: 30000 } });
      const { data: user } = await userOctokit.rest.users.getAuthenticated();

      // Fetch user's email addresses (same as OAuth flow)
      let primaryEmail: string;
      try {
        const { data: emails } = await userOctokit.rest.users.listEmailsForAuthenticatedUser();
        primaryEmail = emails.find((e) => e.primary)?.email || user.email || user.login;
      } catch (_emailError) {
        // If we can't fetch emails, fall back to public email or login
        primaryEmail = user.email || user.login;
      }

      console.log(`[UserValidation] GitHub token auth successful for: ${primaryEmail}`);
      return primaryEmail;
    } catch (error) {
      console.error('Failed to get user email:', error);
      throw error;
    }
  }

  /**
   * Validate Socket.IO authentication token
   * Extracts userEmail and username from JWT, with validation
   *
   * @param token - JWT token or GitHub token
   * @returns Validation result with userEmail and username
   */
  async validateSocketAuth(token: string): Promise<{
    valid: boolean;
    userEmail?: string;
    username?: string;
    error?: string;
  }> {
    try {
      // Local-first device-token gate: when a DeviceTokenService is
      // wired (local mode), a device token — distinguishable from a JWT by its
      // 2 dot-separated parts (JWT has 3) — is the per-request gate on the
      // handshake. The owning clerkUserId scopes the socket (the single-user
      // identity); the deviceLabel is used as the display "username".
      if (this.dependencies.deviceTokenService && token.split('.').length === 2) {
        try {
          const claims = this.dependencies.deviceTokenService.validate(token);
          return {
            valid: true,
            userEmail: claims.clerkUserId,
            username: claims.deviceLabel,
          };
        } catch (deviceError: any) {
          return {
            valid: false,
            error: deviceError?.message || 'Invalid device token',
          };
        }
      }

      // Get user email from token
      const userEmail = await this.getUserEmail(token);

      // Extract username from JWT payload
      // JWT format: header.payload.signature (3 parts separated by dots)
      if (token.includes('.') && token.split('.').length === 3) {
        try {
          const payload = decodeAuthToken(token);

          // Validate username is present in JWT
          if (!payload?.username) {
            console.error(
              `[UserValidationHandler] FATAL: JWT missing required username field for ${userEmail}`
            );
            return {
              valid: false,
              error: 'JWT missing required username field',
            };
          }

          // console.log(
          //   `[UserValidationHandler] Socket auth validated for ${userEmail} (${payload.username})`
          // );

          return {
            valid: true,
            userEmail,
            username: payload.username,
          };
        } catch (jwtError: any) {
          console.error(`[UserValidationHandler] JWT decode failed:`, jwtError);
          return {
            valid: false,
            error: `JWT decode failed: ${jwtError.message}`,
          };
        }
      }

      // Fall back to GitHub token (fetch username from GitHub). 30s request
      // timeout: this runs in the Socket.IO auth path, so a hang here would
      // block connection establishment indefinitely when GitHub is offline.
      try {
        const userOctokit = new Octokit({ auth: token, request: { timeout: 30000 } });
        const { data: user } = await userOctokit.rest.users.getAuthenticated();

        if (!user.login) {
          return {
            valid: false,
            error: 'Unable to fetch username from GitHub',
          };
        }

        // console.log(
        //   `[UserValidationHandler] Socket auth validated for ${userEmail} (${user.login}) via GitHub token`
        // );

        return {
          valid: true,
          userEmail,
          username: user.login,
        };
      } catch (githubError: any) {
        console.error(`[UserValidationHandler] GitHub username fetch failed:`, githubError);
        return {
          valid: false,
          error: `Failed to fetch username: ${githubError.message}`,
        };
      }
    } catch (error: any) {
      console.error(`[UserValidationHandler] Socket auth validation failed:`, error);
      return {
        valid: false,
        error: error.message || 'Authentication failed',
      };
    }
  }

  /**
   * Check if email is on the allowed list (case-insensitive)
   * Auto-allows @volter.ai, otherwise checks the hardcoded ALLOWED_EMAILS list.
   */
  async checkAllowedEmail(email: string): Promise<boolean> {
    // Auto-allow all @volter.ai emails (team members)
    const normalizedEmail = email.toLowerCase();
    if (normalizedEmail.endsWith('@volter.ai')) {
      console.log(
        `[UserValidationHandler] Allowlist check: ${email} -> ALLOWED (volter.ai domain)`
      );
      return true;
    }

    // Hardcoded allowlist (local-first single-user PC — no remote allowed_users table)
    const isAllowed = ALLOWED_EMAILS.some(
      (allowedEmail) => allowedEmail.toLowerCase() === email.toLowerCase()
    );
    console.log(
      `[UserValidationHandler] Hardcoded allowlist check (fallback): ${email} -> ${isAllowed ? 'ALLOWED' : 'DENIED'}`
    );
    return isAllowed;
  }

  /**
   * Get waitlist entries
   */
  getWaitlist(): WaitlistEntry[] {
    return this.waitlist;
  }

  /**
   * Get connected services status from ConnectionsService
   * Returns object with connection status for each service type
   */
  private async getConnectedServicesStatus(
    userEmail: string,
    authToken?: string
  ): Promise<{
    googleDrive: boolean;
    slack: boolean;
    slackWorkspace: string | null;
  }> {
    if (!this.dependencies.connectionsService || !userEmail) {
      return {
        googleDrive: false,
        slack: false,
        slackWorkspace: null,
      };
    }

    try {
      const connections: ServiceConnection[] =
        await this.dependencies.connectionsService.getUserConnections({
          userId: userEmail,
          authToken,
        });
      const googleDriveConnections = connections.filter(
        (c: ServiceConnection) => c.service === 'google-drive'
      );
      const slackConnections = connections.filter((c: ServiceConnection) => c.service === 'slack');

      // Get first Slack workspace name if available (fetch from Clerk)
      let slackWorkspace: string | null = null;
      if (slackConnections.length > 0) {
        const firstSlack = slackConnections[0];
        const credentials = await this.dependencies.connectionsService.getConnectionCredentials({
          userId: userEmail,
          connectionId: firstSlack.connectionId,
          authToken,
        });
        slackWorkspace = credentials?.teamName || null;
      }

      return {
        googleDrive: googleDriveConnections.length > 0,
        slack: slackConnections.length > 0,
        slackWorkspace,
      };
    } catch (error) {
      console.error('[UserValidationHandler] Error getting connected services status:', error);
      return {
        googleDrive: false,
        slack: false,
        slackWorkspace: null,
      };
    }
  }
}
