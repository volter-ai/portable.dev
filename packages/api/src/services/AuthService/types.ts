/**
 * Shared types for AuthService handlers
 */

import type { ConnectionsService } from '../ConnectionsService';
import type { DeviceTokenService } from '../DeviceTokenService';
import type { Request, Response } from 'express';
import type { Session } from 'express-session';

/**
 * Result of checking GitHub permissions
 */
export interface GitHubPermissionStatus {
  hasPermissions: boolean;
  authType: 'none' | 'oauth' | 'app';
  needsUpgrade: boolean;
  connectionId?: string;
}

/**
 * Waitlist entry
 */
export interface WaitlistEntry {
  email: string;
  username: string;
  addedAt: Date;
}

/**
 * Pending OAuth credentials stored in session
 */
export interface PendingOAuthCredentials {
  credentials: {
    token?: string;
    refreshToken?: string;
    accessToken?: string;
    username?: string;
    email?: string;
    userId?: string | number;
    avatarUrl?: string;
    name?: string;
    teamId?: string;
    teamName?: string;
  };
  serviceType?: string;
  timestamp: number;
}

/**
 * Dependencies shared across handlers
 */
export interface HandlerDependencies {
  connectionsService?: ConnectionsService;
  autoConnectorService?: any; // AutoConnectorService - dynamically imported
  githubApiService?: any; // GitHubApiService - for token access
  // Local-first device-token validator. When set, the Socket.IO
  // handshake accepts a device token as the per-request gate (local mode).
  deviceTokenService?: DeviceTokenService;
}

/**
 * Session extensions for OAuth flows
 * Extends Session to include OAuth-specific fields
 */
export interface OAuthSession extends Partial<Session> {
  // GitHub OAuth
  oauthState?: string;
  returnTo?: string;
  upgradeScopes?: boolean;
  githubConnectionId?: string;
  pendingGitHubOAuth?: PendingOAuthCredentials;
  isMobileOAuth?: boolean; // Mobile OAuth flow flag

  // Google OAuth
  googleOauthState?: string;
  googleConnectionName?: string;
  googleService?: 'google-drive' | 'gmail';
  pendingGoogleOAuth?: PendingOAuthCredentials;
  googleDriveToken?: string;
  googleRefreshToken?: string;

  // Slack OAuth
  slackOauthState?: string;
  slackConnectionName?: string;
  pendingSlackOAuth?: PendingOAuthCredentials;
  slackToken?: string;
  slackUser?: any;
  slackTeam?: any;

  // User session data
  githubUser?: any;
  username?: string;
  userId?: string; // User ID for Gateway callback state
  userEmail?: string;
  onWaitlist?: boolean;
  authToken?: string;
}

/**
 * Extended Request with OAuth session
 * Using type assertion to avoid Session compatibility issues
 */
export type OAuthRequest = Request & {
  session: OAuthSession & Session;
  jwtUser?: {
    email?: string;
    userId?: string;
  };
};

/**
 * OAuth URL generation result
 */
export interface OAuthUrlResult {
  url: string;
  state?: string;
}

/**
 * Token exchange result
 */
export interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
  expiresIn?: number;
}

/**
 * Slack token exchange result
 */
export interface SlackTokenExchangeResult {
  ok: boolean;
  accessToken: string;
  tokenType?: string;
  scope?: string;
  team?: { id: string; name: string };
  authedUser?: {
    id: string;
    accessToken: string;
    scope: string;
  };
  error?: string;
}
