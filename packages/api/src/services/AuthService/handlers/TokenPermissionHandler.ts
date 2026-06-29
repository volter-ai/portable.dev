import { Octokit } from '@octokit/rest';
import { debugLog, shouldLog } from '@vgit2/shared/constants';
import { REQUIRED_SCOPES } from '@vgit2/shared/types';
import { Response } from 'express';

import { fetchWithTimeout, isUpstreamUnreachableError } from '../../../utils/fetchWithTimeout.js';
import { createUserOctokit } from '../../GitHubApiService/utils/octokitFactory.js';

import type { OAuthRequest, HandlerDependencies, GitHubPermissionStatus } from '../types';
import type { GitHubScope, CheckScopesResponse } from '@vgit2/shared/types';

/**
 * TokenPermissionHandler - Manages GitHub tokens and permissions
 *
 * Responsibilities:
 * - GitHub token retrieval and management
 * - Permission checking
 * - Scope validation
 * - Octokit instance creation
 */
export class TokenPermissionHandler {
  private dependencies: HandlerDependencies;

  constructor(dependencies: HandlerDependencies) {
    this.dependencies = dependencies;
    debugLog('[TokenPermissionHandler] Initialized');
  }

  /**
   * Get user's Octokit instance with GitHub App support (async)
   * Checks for active GitHub App connection first, falls back to OAuth.
   *
   * Built via the shared octokitFactory so a 401 here behaves exactly like in
   * GitHubApiService: invalidate the caches, refetch once, replay the request
   * with the fresh token.
   */
  async getUserOctokitAsync(req: OAuthRequest): Promise<Octokit> {
    const token = await this.getGitHubToken(req);
    return createUserOctokit(token, {
      refreshToken: async () => {
        const userId = req.session.userEmail;
        if (userId) {
          if (this.dependencies.githubApiService) {
            // Clears the GitHubApiService mirror AND the ConnectionsService memo
            this.dependencies.githubApiService.clearTokenCache(userId);
          } else {
            this.dependencies.connectionsService?.invalidateActiveGitHubConnection(userId);
          }
        }
        return this.getGitHubToken(req);
      },
    });
  }

  /**
   * Get GitHub token with unified access (GitHub App first, then OAuth)
   * This is the main entry point for getting a valid GitHub token.
   *
   * @param req - Express request with session data
   * @returns GitHub access token
   * @throws Error with code 'INSUFFICIENT_GITHUB_PERMISSIONS' if no token available
   */
  async getGitHubToken(req: OAuthRequest): Promise<string> {
    const userId = req.session.userEmail;
    const authToken = req.session.authToken;

    // 1. Check for GitHub App connection first (if ConnectionsService available)
    if (this.dependencies.connectionsService && userId) {
      try {
        const activeConnection =
          await this.dependencies.connectionsService.getActiveGitHubConnection(userId, authToken);

        if (activeConnection.type === 'app' && activeConnection.token) {
          debugLog('[TokenPermissionHandler] Using GitHub App token');
          return activeConnection.token;
        }

        // GitHub App returned a token from OAuth connection
        if (activeConnection.type === 'oauth' && activeConnection.token) {
          debugLog('[TokenPermissionHandler] Using OAuth token from connection');
          return activeConnection.token;
        }
      } catch (error) {
        console.error('[TokenPermissionHandler] Error checking GitHub App connection:', error);
        // Fall through to session token
      }
    }

    // 2. No token available from GitHub App connections
    const error = new Error('INSUFFICIENT_GITHUB_PERMISSIONS');
    (error as any).code = 'INSUFFICIENT_GITHUB_PERMISSIONS';
    throw error;
  }

  /**
   * Check if user has sufficient GitHub permissions
   * Returns detailed status about current authentication state.
   *
   * @param req - Express request with session data
   * @returns Permission status object
   */
  async checkGitHubPermissions(req: OAuthRequest): Promise<GitHubPermissionStatus> {
    const userId = req.session.userEmail;
    const authToken = req.session.authToken;

    // 1. Check for GitHub App connection first
    if (this.dependencies.connectionsService && userId) {
      try {
        const activeConnection =
          await this.dependencies.connectionsService.getActiveGitHubConnection(userId, authToken);

        if (activeConnection.type === 'app' && activeConnection.token) {
          return {
            hasPermissions: true,
            authType: 'app',
            needsUpgrade: false,
            connectionId: activeConnection.connection?.connectionId,
          };
        }

        if (activeConnection.type === 'oauth' && activeConnection.token) {
          return {
            hasPermissions: true,
            authType: 'oauth',
            needsUpgrade: false,
            connectionId: activeConnection.connection?.connectionId,
          };
        }
      } catch (error) {
        console.error('[TokenPermissionHandler] Error checking GitHub connections:', error);
        // Fall through to check session
      }
    }

    // 2. No permissions - user needs to set up GitHub access
    return {
      hasPermissions: false,
      authType: 'none',
      needsUpgrade: true,
    };
  }

  /**
   * Check GitHub token scopes
   * Makes a request to GitHub API and extracts scopes from X-OAuth-Scopes header
   */
  async checkScopes(req: OAuthRequest, res: Response): Promise<void> {
    try {
      // Get userEmail from session (populated by JWT middleware)
      // IMPORTANT: GitHubApiService uses userEmail as the cache key, not Clerk userId
      const userEmail = req.session.userEmail || req.jwtUser?.email;

      if (!userEmail) {
        const result: CheckScopesResponse = {
          hasRequiredScopes: false,
          currentScopes: [],
          missingScopes: REQUIRED_SCOPES,
          needsReauth: true,
          timestamp: Date.now(),
        };
        res.json(result);
        return;
      }

      // Load GitHub token from GitHubApiService (which uses ConnectionsService + cache)
      let githubToken: string | undefined;

      if (this.dependencies.githubApiService) {
        // Try to load fresh token from database if not in cache
        // Use userEmail as key (same as GitHubApiService repo endpoints)
        await this.dependencies.githubApiService.loadTokenForUser(userEmail, req.session.authToken);
        githubToken = this.dependencies.githubApiService.getCachedToken(userEmail);
      } else {
        // Fallback: use session token (legacy path for backward compatibility)
        githubToken = (req.session as any).githubToken;
      }

      // If no GitHub token, user needs to connect GitHub account
      // This is different from "token expired" - user never connected GitHub
      if (!githubToken || githubToken === '') {
        const result: CheckScopesResponse = {
          hasRequiredScopes: false,
          currentScopes: [],
          missingScopes: REQUIRED_SCOPES,
          needsReauth: false, // Not reauth - user never connected
          noGitHubConnection: true, // Flag to indicate no GitHub connection
          timestamp: Date.now(),
        };
        res.json(result);
        return;
      }

      // Check token scopes via GitHub API
      // Use a simple GET /user request which works for all token types
      // The X-OAuth-Scopes header contains the token's scopes
      if (shouldLog('debug')) {
        console.log('[TokenPermission] Checking token scopes via GitHub API');
        console.log('[TokenPermission] Token preview:', githubToken?.substring(0, 10) + '...');
      }

      // 30s timeout: native fetch never times out on its own, so an offline
      // GitHub would otherwise hang this scope check forever.
      const response = await fetchWithTimeout('https://api.github.com/user', {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          '[TokenPermissionHandler] GitHub API error response:',
          response.status,
          errorText
        );

        // Log token inspection for debugging (first 8 chars + last 4 chars)
        if (githubToken) {
          const tokenLength = githubToken.length;
          const tokenPreview =
            tokenLength > 12
              ? `${githubToken.substring(0, 8)}...${githubToken.substring(tokenLength - 4)}`
              : `${githubToken.substring(0, Math.min(8, tokenLength))}...`;
          console.error(
            '[TokenPermissionHandler] Token inspection (length:',
            tokenLength,
            '):',
            tokenPreview
          );
        } else {
          console.error('[TokenPermissionHandler] Token inspection: (no token found)');
        }

        // Token is invalid or expired - return needsReauth response instead of throwing
        if (response.status === 401 || response.status === 403) {
          console.log('[TokenPermissionHandler] GitHub token is invalid or expired - needs reauth');
          const result: CheckScopesResponse = {
            hasRequiredScopes: false,
            currentScopes: [],
            missingScopes: REQUIRED_SCOPES,
            needsReauth: true,
            timestamp: Date.now(),
          };
          res.json(result);
          return;
        }

        // Other GitHub API errors - throw to be caught below
        throw new Error(`GitHub token check failed: ${response.status}`);
      }

      // Extract scopes from X-OAuth-Scopes header
      const scopesHeader = response.headers.get('x-oauth-scopes');

      // Parse scopes from comma-separated string
      const currentScopes: GitHubScope[] = scopesHeader
        ? scopesHeader
            .split(',')
            .map((s: string) => s.trim() as GitHubScope)
            .filter((s) => s)
        : [];

      // Check if all required scopes are present
      const missingScopes = REQUIRED_SCOPES.filter((required) => !currentScopes.includes(required));

      const hasRequiredScopes = missingScopes.length === 0;

      const result: CheckScopesResponse = {
        hasRequiredScopes,
        currentScopes,
        missingScopes,
        needsReauth: !hasRequiredScopes,
        timestamp: Date.now(),
      };

      // Compact log at INFO level
      const scopesList = currentScopes.join(', ');
      const missingInfo = missingScopes.length > 0 ? ` ⚠ missing: ${missingScopes.join(', ')}` : '';
      console.log(`[TokenPermission] Scopes: ${scopesList}${missingInfo}`);

      // Verbose details at DEBUG level
      if (shouldLog('debug')) {
        console.log('[TokenPermission] Raw X-OAuth-Scopes header:', scopesHeader);
        console.log('[TokenPermission] Current scopes from token:', currentScopes);
        console.log('[TokenPermission] Required scopes:', REQUIRED_SCOPES);
        console.log('[TokenPermission] Missing scopes:', missingScopes);
        console.log('[TokenPermission] Checking each required scope:');
        REQUIRED_SCOPES.forEach((required) => {
          const hasScope = currentScopes.includes(required);
          console.log(`  - ${required}: ${hasScope ? '✓ FOUND' : '✗ MISSING'}`);
        });
        console.log('[TokenPermission] Scope check result:', JSON.stringify(result, null, 2));
      }

      res.json(result);
    } catch (error) {
      // GitHub unreachable (offline / DNS / timeout): return a retryable 503 and
      // do NOT signal needsReauth — the token may be perfectly valid, GitHub is
      // just down. Surfacing 503 lets the client back off instead of forcing a
      // pointless reconnect or treating it as a hard failure.
      if (isUpstreamUnreachableError(error)) {
        console.warn('[TokenPermissionHandler] GitHub unreachable during scope check:', error);
        res.status(503).json({
          error: 'GitHub API temporarily unavailable',
          code: 'GITHUB_UNAVAILABLE',
          retryable: true,
        });
        return;
      }
      console.error('[TokenPermissionHandler] Error checking scopes:', error);
      res.status(500).json({
        error: 'Failed to check scopes',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
