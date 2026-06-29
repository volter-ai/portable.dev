/**
 * AuthService - Main facade for authentication and authorization
 *
 * This is the refactored modular version that delegates to specialized handlers:
 * - GitHubOAuthHandler: GitHub OAuth authentication flow
 * - GoogleOAuthHandler: Google OAuth authentication flow
 * - SlackOAuthHandler: Slack OAuth authentication flow
 * - TokenPermissionHandler: Token and permissions management
 * - UserValidationHandler: User validation and allowlist management
 * - SessionHandler: Session lifecycle management
 * - ConnectionStatusHandler: Service dependency management
 *
 * Architecture:
 * - Handlers are stateless where possible
 * - Shared state (waitlist) passed via constructor
 * - Each handler has single responsibility
 * - Main AuthService maintains API compatibility
 */

import { debugLog } from '@vgit2/shared/constants';

import { ConnectionStatusHandler } from './handlers/ConnectionStatusHandler';
import { GitHubOAuthHandler } from './handlers/GitHubOAuthHandler';
import { GoogleOAuthHandler } from './handlers/GoogleOAuthHandler';
import { SessionHandler } from './handlers/SessionHandler';
import { SlackOAuthHandler } from './handlers/SlackOAuthHandler';
import { TokenPermissionHandler } from './handlers/TokenPermissionHandler';
import { UserValidationHandler } from './handlers/UserValidationHandler';

import type { ConnectionsService } from '../ConnectionsService';
import type { DeviceTokenService } from '../DeviceTokenService';
import type {
  OAuthRequest,
  HandlerDependencies,
  WaitlistEntry,
  GitHubPermissionStatus,
} from './types';
import type { Request, Response } from 'express';

// Re-export types for backward compatibility
export type { GitHubPermissionStatus } from './types';

/**
 * AuthService handles GitHub OAuth authentication and session management
 * NOTE: OAuth (GitHub, Google, Slack) is delegated to the OAuth service (github-app package)
 */
export class AuthService {
  // Handlers
  private gitHubOAuthHandler: GitHubOAuthHandler;
  private googleOAuthHandler: GoogleOAuthHandler;
  private slackOAuthHandler: SlackOAuthHandler;
  private tokenPermissionHandler: TokenPermissionHandler;
  private userValidationHandler: UserValidationHandler;
  private sessionHandler: SessionHandler;
  private connectionStatusHandler: ConnectionStatusHandler;

  // Shared state
  private waitlist: WaitlistEntry[] = [];

  // Dependencies
  private connectionsService: ConnectionsService | null = null;
  private autoConnectorService: any = null; // AutoConnectorService - dynamically imported
  private githubApiService: any = null; // GitHubApiService - for token access
  // Shared, mutable dependencies object handed to every handler (same reference),
  // so late-injected deps (setGitHubApiService/setDeviceTokenService) are visible.
  private dependencies: HandlerDependencies;

  constructor(
    connectionsService?: ConnectionsService,
    autoConnectorService?: any,
    githubApiService?: any
  ) {
    this.connectionsService = connectionsService || null;
    this.autoConnectorService = autoConnectorService || null;
    this.githubApiService = githubApiService || null;

    // Build dependencies object for handlers
    const dependencies: HandlerDependencies = {
      connectionsService,
      autoConnectorService,
      githubApiService,
    };
    this.dependencies = dependencies;

    // Initialize handlers
    this.gitHubOAuthHandler = new GitHubOAuthHandler(dependencies, this.waitlist);
    this.googleOAuthHandler = new GoogleOAuthHandler(dependencies);
    this.slackOAuthHandler = new SlackOAuthHandler(dependencies);
    this.tokenPermissionHandler = new TokenPermissionHandler(dependencies);
    this.userValidationHandler = new UserValidationHandler(dependencies, this.waitlist);
    this.sessionHandler = new SessionHandler(dependencies);
    this.connectionStatusHandler = new ConnectionStatusHandler(dependencies);

    // Set cross-handler dependencies
    this.gitHubOAuthHandler.setUserValidationHandler(this.userValidationHandler);

    debugLog('[AuthService] Modular architecture initialized with 7 specialized handlers');
  }

  /**
   * Set GitHubApiService dependency (for lazy initialization)
   * Called after GitHubApiService is created since there's a circular dependency
   */
  setGitHubApiService(githubApiService: any): void {
    this.githubApiService = githubApiService;
    this.connectionStatusHandler.setGitHubApiService(githubApiService);
    debugLog('[AuthService] GitHubApiService dependency injected');
  }

  /**
   * Set the local-first DeviceTokenService. Once set, the Socket.IO
   * handshake accepts a device token as the per-request gate in local mode.
   * Mutates the shared dependencies object so handlers see it immediately.
   */
  setDeviceTokenService(deviceTokenService: DeviceTokenService): void {
    this.dependencies.deviceTokenService = deviceTokenService;
    debugLog('[AuthService] DeviceTokenService dependency injected');
  }

  // ============================================================================
  // GitHub OAuth Methods - Delegate to GitHubOAuthHandler
  // ============================================================================

  /**
   * Initiate GitHub OAuth flow
   */
  handleGitHubLogin(req: Request, res: Response): void {
    this.gitHubOAuthHandler.handleGitHubLogin(req as OAuthRequest, res);
  }

  /**
   * Generate org access OAuth URL (returns JSON with URL for popup flow)
   */
  async generateOrgAccessUrl(res: Response, userId: string, userEmail: string): Promise<void> {
    return this.gitHubOAuthHandler.generateOrgAccessUrl(res, userId, userEmail);
  }

  /**
   * Handle GitHub OAuth callback
   */
  async handleGitHubCallback(req: Request, res: Response): Promise<void> {
    return this.gitHubOAuthHandler.handleGitHubCallback(req as OAuthRequest, res);
  }

  // ============================================================================
  // Google OAuth Methods - Delegate to GoogleOAuthHandler
  // ============================================================================

  /**
   * Initiate Google OAuth flow for Drive access
   */
  handleGoogleLogin(req: Request, res: Response): void {
    this.googleOAuthHandler.handleGoogleLogin(req as OAuthRequest, res);
  }

  /**
   * Handle Google OAuth callback
   */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    return this.googleOAuthHandler.handleGoogleCallback(req as OAuthRequest, res);
  }

  /**
   * Disconnect Google Drive
   * NOTE: Deprecated - use /api/connections/:connectionId DELETE endpoint instead
   */
  async handleGoogleDisconnect(req: Request, res: Response): Promise<void> {
    return this.googleOAuthHandler.handleGoogleDisconnect(req as OAuthRequest, res);
  }

  /**
   * Refresh Google Drive access token using refresh token
   * Returns new access token or null if refresh fails
   */
  async refreshGoogleToken(refreshToken: string): Promise<string | null> {
    return this.googleOAuthHandler.refreshGoogleToken(refreshToken);
  }

  /**
   * Get valid Google Drive token from session (with auto-refresh)
   * Returns access token or null if not available
   */
  async getValidGoogleToken(session: any): Promise<string | null> {
    return this.googleOAuthHandler.getValidGoogleToken(session);
  }

  // ============================================================================
  // Slack OAuth Methods - Delegate to SlackOAuthHandler
  // ============================================================================

  /**
   * Initiate Slack OAuth flow for workspace access
   */
  handleSlackLogin(req: Request, res: Response): void {
    this.slackOAuthHandler.handleSlackLogin(req as OAuthRequest, res);
  }

  /**
   * Handle Slack OAuth callback
   */
  async handleSlackCallback(req: Request, res: Response): Promise<void> {
    return this.slackOAuthHandler.handleSlackCallback(req as OAuthRequest, res);
  }

  /**
   * Disconnect Slack
   * NOTE: Deprecated - use /api/connections/:connectionId DELETE endpoint instead
   */
  async handleSlackDisconnect(req: Request, res: Response): Promise<void> {
    return this.slackOAuthHandler.handleSlackDisconnect(req as OAuthRequest, res);
  }

  /**
   * Get valid Slack token from session
   * Returns access token or null if not available
   */
  async getValidSlackToken(session: any): Promise<string | null> {
    return this.slackOAuthHandler.getValidSlackToken(session);
  }

  // ============================================================================
  // Token & Permission Methods - Delegate to TokenPermissionHandler
  // ============================================================================

  /**
   * Get user's Octokit instance with GitHub App support (async)
   * Checks for active GitHub App connection first, falls back to OAuth.
   */
  async getUserOctokitAsync(req: Request): Promise<any> {
    return this.tokenPermissionHandler.getUserOctokitAsync(req as OAuthRequest);
  }

  /**
   * Get GitHub token with unified access (GitHub App first, then OAuth)
   * This is the main entry point for getting a valid GitHub token.
   */
  async getGitHubToken(req: Request): Promise<string> {
    return this.tokenPermissionHandler.getGitHubToken(req as OAuthRequest);
  }

  /**
   * Check if user has sufficient GitHub permissions
   * Returns detailed status about current authentication state.
   */
  async checkGitHubPermissions(req: Request): Promise<GitHubPermissionStatus> {
    return this.tokenPermissionHandler.checkGitHubPermissions(req as OAuthRequest);
  }

  /**
   * Check GitHub token scopes
   * Makes a request to GitHub API and extracts scopes from X-OAuth-Scopes header
   */
  async checkScopes(req: Request, res: Response): Promise<void> {
    return this.tokenPermissionHandler.checkScopes(req as OAuthRequest, res);
  }

  // ============================================================================
  // User Validation Methods - Delegate to UserValidationHandler
  // ============================================================================

  /**
   * Get current user info
   */
  async getUser(req: Request, res: Response): Promise<void> {
    return this.userValidationHandler.getUser(req as OAuthRequest, res);
  }

  /**
   * Get user email from token (JWT or GitHub token) and verify they're on the allowlist
   * @throws Error if user is not on the allowlist
   */
  async getUserEmail(userToken: string): Promise<string> {
    return this.userValidationHandler.getUserEmail(userToken);
  }

  /**
   * Validate Socket.IO authentication token
   * Extracts userEmail and username from JWT, with validation
   */
  async validateSocketAuth(token: string): Promise<{
    valid: boolean;
    userEmail?: string;
    username?: string;
    error?: string;
  }> {
    return this.userValidationHandler.validateSocketAuth(token);
  }

  /**
   * Check if email is on the allowed list (case-insensitive)
   * Uses the database if available, falls back to hardcoded list
   */
  async checkAllowedEmail(email: string): Promise<boolean> {
    return this.userValidationHandler.checkAllowedEmail(email);
  }

  /**
   * Get waitlist entries
   */
  getWaitlist(): WaitlistEntry[] {
    return this.userValidationHandler.getWaitlist();
  }

  // ============================================================================
  // Session Methods - Delegate to SessionHandler
  // ============================================================================

  /**
   * Handle logout
   */
  handleLogout(req: Request, res: Response): void {
    this.sessionHandler.handleLogout(req as OAuthRequest, res);
  }
}
