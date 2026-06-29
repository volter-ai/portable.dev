/**
 * JWT Utilities
 *
 * Shared JWT functions for authentication between Gateway and Sandbox.
 *
 * Flow:
 * 1. Gateway: User logs in via GitHub OAuth
 * 2. Gateway: Creates JWT with user info (generateAuthToken)
 * 3. Gateway: Passes JWT to sandbox via URL or header
 * 4. Sandbox: Validates JWT (verifyAuthToken)
 * 5. Sandbox: Creates local session with user info
 *
 * Security:
 * - JWT signed with secret (JWT_SECRET env var)
 * - 72h expiration with sliding renewal
 * - jti (JWT ID) for blacklist support
 * - Contains: userId, username, email, avatarUrl, jti
 * - GitHub tokens managed server-side via ConnectionsService (not in JWT)
 */

import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import * as constants from './constants';

const JWT_SECRET = constants.JWT_SECRET || '';

// Token expiration time (72 hours)
export const JWT_EXPIRATION = '72h';
export const JWT_EXPIRATION_SECONDS = 72 * 60 * 60; // 259200 seconds

// if (!JWT_SECRET) {
//   const errorMessage = [
//     '',
//     '❌ JWT_SECRET environment variable is required!',
//     '',
//     'To fix this:',
//     '1. Generate a secret:',
//     '   node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
//     '',
//     '2. Add to .env file:',
//     '   JWT_SECRET=your_generated_secret_here',
//     '',
//     '3. Restart the server',
//     '',
//     'See docs/JWT_AUTHENTICATION.md for more details',
//     ''
//   ].join('\n');

//   throw new Error(errorMessage);
// }

export interface AuthTokenPayload {
  userId: string;
  username: string;
  email: string;
  avatarUrl?: string; // User's profile picture URL (from Clerk/GitHub)
  githubToken?: string; // Optional: GitHub access token (from GitHub OAuth)
  googleDriveToken?: string; // Optional: Google Drive access token (from Google OAuth)
  googleRefreshToken?: string; // Optional: Google Drive refresh token (for auto-renewal)
  sub?: string; // Subject - email (used as the user id)
  role?: string; // Role - always 'authenticated'
  aud?: string; // Audience - always 'authenticated'
  jti?: string; // JWT ID for blacklist support
  iat?: number; // Issued at
  exp?: number; // Expiration
  serviceAccount?: boolean; // Service account JWT (for headless API)
  serviceAccountId?: string; // Service account ID (if service account JWT)
  serviceAccountName?: string; // Service account name (for logging)
  allowedUserIds?: string[]; // Users this service account can access
  // Webhook-specific fields
  type?: 'webhook' | 'service'; // Token type for webhook authentication or service-to-service
  repoOwner?: string; // GitHub repository owner (webhook JWTs only)
  repoName?: string; // GitHub repository name (webhook JWTs only)
  // NOTE: GitHub tokens are NOT stored in JWT for security reasons
  // They are managed server-side via ConnectionsService and stored in database
}

/**
 * Generate a unique JWT ID (jti) for blacklist support
 */
function generateJti(): string {
  return crypto.randomUUID();
}

/**
 * Generate a JWT auth token for a user
 *
 * @param payload User information to encode in token
 * @param jwtSecret Optional custom JWT secret (defaults to process.env.JWT_SECRET)
 * @param options Optional JWT sign options (e.g., custom expiresIn)
 * @returns JWT token string with 72h expiration and unique jti
 *
 * @example
 * const token = generateAuthToken({
 *   userId: 'user123',
 *   username: 'johndoe',
 *   email: 'john@example.com',
 *   avatarUrl: 'https://avatars.githubusercontent.com/u/123',
 *   googleDriveToken: 'ya29.xxx', // Optional
 *   googleRefreshToken: '1//xxx' // Optional
 * });
 */
export function generateAuthToken(
  payload: Omit<AuthTokenPayload, 'iat' | 'exp' | 'jti' | 'sub' | 'role' | 'aud'>,
  jwtSecret?: string,
  options?: { expiresIn?: string | number }
): string {
  const secret = jwtSecret || JWT_SECRET;

  const tokenPayload = {
    ...payload,
    sub: payload.email, // IMPORTANT: email is the user id (DB keys rows by email)
    role: 'authenticated', // Standard authenticated role
    aud: 'authenticated', // Standard authenticated audience
    jti: generateJti(), // Unique ID for blacklist support
  };

  // Build sign options with explicit algorithm (must match verify)
  const expiresIn = options?.expiresIn || JWT_EXPIRATION;
  const token = jwt.sign(tokenPayload, secret, {
    expiresIn,
    algorithm: 'HS256',
  } as jwt.SignOptions);

  return token;
}

/**
 * Verify and decode a JWT auth token
 *
 * @param token JWT token string
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 *
 * @example
 * try {
 *   const user = verifyAuthToken(token);
 *   console.log(user.username);
 * } catch (err) {
 *   console.error('Invalid token:', err.message);
 * }
 */
export function verifyAuthToken(token: string): AuthTokenPayload {
  try {
    // Verify with same options as signing (audience check)
    const decoded = jwt.verify(token, JWT_SECRET, {
      audience: 'authenticated',
      algorithms: ['HS256'],
    }) as AuthTokenPayload;

    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('Token has expired');
    }
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error(`Invalid token: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Decode a JWT token without verifying (useful for debugging)
 *
 * @param token JWT token string
 * @returns Decoded token payload (unverified!)
 *
 * @example
 * const payload = decodeAuthToken(token);
 * console.log('Token expires:', new Date(payload.exp! * 1000));
 */
export function decodeAuthToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.decode(token) as AuthTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Renew a JWT token with a new expiration (sliding expiration)
 *
 * Creates a new token with the same user data but:
 * - New jti (for fresh blacklist tracking)
 * - New iat (issued at)
 * - New exp (72h from now)
 *
 * NOTE: This function should only be called when token is near expiration
 * (e.g., < 24h remaining) to avoid excessive token generation.
 *
 * @param token Current valid JWT token
 * @returns New JWT token with renewed expiration
 * @throws Error if token is invalid or expired
 *
 * @example
 * // Check expiration before renewing (threshold-based renewal)
 * const payload = verifyAuthToken(token);
 * const now = Math.floor(Date.now() / 1000);
 * const timeUntilExpiry = payload.exp! - now;
 *
 * if (timeUntilExpiry < 24 * 60 * 60) { // < 24 hours
 *   const newToken = renewAuthToken(token);
 *   res.setHeader('X-Renewed-Token', newToken);
 * }
 */
export function renewAuthToken(token: string): string {
  // First verify the token is valid
  const payload = verifyAuthToken(token);

  // Create new token with same user data but new jti/exp
  return generateAuthToken({
    userId: payload.userId,
    username: payload.username,
    email: payload.email,
    avatarUrl: payload.avatarUrl,
    googleDriveToken: payload.googleDriveToken,
    googleRefreshToken: payload.googleRefreshToken,
  });
}

/**
 * Service token payload (minimal fields for service-to-service auth)
 *
 * NOTE: Uses role='authenticated' and sub=email, matching the user-token claims.
 * The 'type: service' field differentiates service tokens from user tokens.
 */
export interface ServiceTokenPayload {
  userId: string;
  email: string; // User email for identification
  type: 'service';
  sub: string; // Email (used as the user id)
  role: 'authenticated'; // Always 'authenticated' (was 'service')
  aud: 'authenticated';
  jti: string;
  iat: number;
}

/**
 * Generate a permanent service JWT token for service-to-service communication
 *
 * This JWT is used for internal service authentication and has no expiration.
 * It contains the userId and email to identify the sandbox owner.
 *
 * @param payload Service token information (userId and email)
 * @param jwtSecret Optional custom JWT secret (defaults to process.env.JWT_SECRET)
 * @returns JWT token string with NO expiration
 *
 * @example
 * const serviceToken = generateServiceAuthToken({
 *   userId: 'user_2abc123xyz',
 *   email: 'user@example.com'
 * });
 */
export function generateServiceAuthToken(
  payload: { userId: string; email: string },
  jwtSecret?: string
): string {
  const secret = jwtSecret || JWT_SECRET;

  const tokenPayload = {
    userId: payload.userId,
    email: payload.email,
    type: 'service' as const,
    sub: payload.email, // Email is the user id (DB keys rows by email)
    role: 'authenticated', // Always 'authenticated'
    aud: 'authenticated', // Standard authenticated audience
    jti: generateJti(), // Unique ID for blacklist support
  };

  // Build sign options WITHOUT expiresIn (permanent token)
  const token = jwt.sign(tokenPayload, secret, {
    algorithm: 'HS256',
    // NOTE: No expiresIn - this token never expires
  } as jwt.SignOptions);

  return token;
}

/**
 * Verify a service JWT token (no expiration, minimal payload)
 *
 * @param token Service JWT token string
 * @returns Decoded service token payload
 * @throws Error if token is invalid
 *
 * @example
 * try {
 *   const service = verifyServiceToken(token);
 *   console.log(service.userId);
 * } catch (err) {
 *   console.error('Invalid service token:', err.message);
 * }
 */
export function verifyServiceToken(token: string): ServiceTokenPayload {
  try {
    // Service tokens use role='authenticated', matching user tokens
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'authenticated', // Now uses audience check like user tokens
    }) as ServiceTokenPayload;

    // Validate that this is actually a service token (by type, not role)
    // NOTE: role is 'authenticated' (same as user tokens), so we only check type
    if (decoded.type !== 'service') {
      throw new Error('Token is not a service token');
    }

    return decoded;
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error(`Invalid service token: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Verify any JWT token (auto-detects service vs user token)
 *
 * @param token JWT token string
 * @returns Decoded token payload (service or user)
 * @throws Error if token is invalid or expired
 *
 * @example
 * try {
 *   const payload = verifyToken(token);
 *   if ('username' in payload) {
 *     // User token
 *     console.log('User:', payload.username);
 *   } else {
 *     // Service token
 *     console.log('Service:', payload.userId);
 *   }
 * } catch (err) {
 *   console.error('Invalid token:', err.message);
 * }
 */
export function verifyToken(token: string): AuthTokenPayload | ServiceTokenPayload {
  try {
    // Validate token format
    if (!token || typeof token !== 'string') {
      throw new Error('Token must be a non-empty string');
    }

    // Check if token has 3 parts (header.payload.signature)
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error(`Malformed JWT: expected 3 parts, got ${parts.length}`);
    }

    // First, decode without verification to check token type
    const decoded = jwt.decode(token) as { role?: string; type?: string } | null;

    if (!decoded) {
      throw new Error('Token could not be decoded - may be malformed or invalid base64');
    }

    // Check if it's a service token (by type only, since role is now 'authenticated')
    if (decoded.type === 'service') {
      return verifyServiceToken(token);
    }

    // Otherwise, verify as user token
    return verifyAuthToken(token);
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      throw new Error(`Invalid token: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Get the remaining TTL (time to live) for a token in seconds
 *
 * Useful for setting Redis blacklist TTL to match token expiration.
 *
 * @param token JWT token string
 * @returns Remaining seconds until expiration, or 0 if expired/invalid
 *
 * @example
 * const ttl = getTokenTtl(token);
 * await redis.setex(`jwt:blacklist:${jti}`, ttl, '1');
 */
export function getTokenTtl(token: string): number {
  const payload = decodeAuthToken(token);
  if (!payload?.exp) return 0;

  const now = Math.floor(Date.now() / 1000);
  const remaining = payload.exp - now;

  return remaining > 0 ? remaining : 0;
}

/**
 * Check if JWT_SECRET is configured
 *
 * @returns true if JWT_SECRET is set and non-empty
 */
export function isJwtConfigured(): boolean {
  return JWT_SECRET.length > 0;
}
