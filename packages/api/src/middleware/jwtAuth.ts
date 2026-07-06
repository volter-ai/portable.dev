/**
 * JWT Per-Request Authentication Middleware
 *
 * Validates JWT tokens on every request for secure sandbox access.
 *
 * Features:
 * - Extracts JWT from Authorization: Bearer <token> header
 * - Validates signature and expiration (locally or via remote service)
 * - Implements sliding expiration with 24-hour renewal threshold
 * - Returns renewed token via X-Renewed-Token header (only when needed)
 *
 * Validation Method (local-first):
 *   Local: If JWT_SECRET is set, validates the JWT locally. The remote
 *   remote TokenValidationService was retired — the PC validates locally.
 *
 * Renewal Strategy:
 * - Token is only renewed if it expires in < 24 hours
 * - Prevents excessive token generation (99% reduction vs renew-every-request)
 * - Maintains sliding expiration: active users never logged out
 * - Example: 72h token renewed when 24h remaining → extends to 72h again
 *
 * Security Flow:
 * 1. Extract token from Authorization header
 * 2. Verify JWT signature and expiration (remote or local)
 * 3. If valid and expires soon, renew token (sliding expiration)
 * 4. Attach user info to request
 * 5. Send renewed token in response header (if renewed)
 */

import { GATEWAY_URL } from '@vgit2/shared/constants';
import {
  verifyAuthToken,
  renewAuthToken,
  isJwtConfigured,
  type AuthTokenPayload,
} from '@vgit2/shared/jwt';

import type { DeviceTokenService } from '../services/DeviceTokenService';
import type { DeviceTokenClaims } from '@vgit2/shared/types';
import type { Request, Response, NextFunction } from 'express';

if (isJwtConfigured()) {
  console.log('[JwtAuth] Using local JWT validation');
} else {
  // No JWT validation - expected in development mode with OAuth sessions
  console.log('[JwtAuth] Using OAuth sessions (no JWT validation configured)');
}

// Extend Express Request to include JWT user data
declare global {
  namespace Express {
    interface Request {
      jwtUser?: AuthTokenPayload;
      jwtToken?: string;
      // Local-first device-token claims, set when the device token
      // — not a Clerk JWT — is the per-request gate in local mode.
      deviceUser?: DeviceTokenClaims;
    }
  }
}

// Header name for renewed token
export const RENEWED_TOKEN_HEADER = 'X-Renewed-Token';

// Renewal threshold: Only renew token if it expires in less than 24 hours
// This prevents excessive token generation while maintaining sliding expiration
const RENEWAL_THRESHOLD_SECONDS = 24 * 60 * 60; // 24 hours

// Public routes that don't require JWT authentication
const PUBLIC_ROUTES = [
  '/api/health',
  '/health',
  '/api/healthcheck',
  '/api/min-version', // Version gate check — must be reachable before auth
  // E2E handshake (portable.dev#13): self-authenticating (PSK-keyed MAC) — the
  // relay cannot complete it. NOTE: startsWith keeps `/api/e2e` itself gated.
  '/api/e2e/handshake',
  '/auth/github',
  '/auth/github/callback',
];

/**
 * Extract a bearer token from a request, mirroring the JWT path's fallbacks:
 * Authorization: Bearer header (priority) -> ?token= query (for <img> tags that
 * can't send headers) -> session.authToken.
 */
function extractAuthToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  if (req.query.token) {
    return req.query.token as string;
  }
  if (req.session?.authToken) {
    return req.session.authToken;
  }
  return undefined;
}

/**
 * Create JWT authentication middleware
 *
 * Factory function that creates middleware for JWT validation.
 * Blacklist checking is handled by the remote token-validation service.
 *
 * In local-first mode, pass a `DeviceTokenService` to make the
 * **device token** the sole per-request gate: it is validated locally (the
 * remote TokenValidationService path is bypassed) and a missing/invalid token
 * on a non-public route returns 401. In sandbox mode, or when no
 * DeviceTokenService is supplied, the existing JWT path is used unchanged.
 *
 * @param deviceTokenService Optional local device-token validator (local mode).
 * @returns Express middleware function
 *
 * @example
 * const jwtMiddleware = createJwtAuthMiddleware(deviceTokenService);
 * app.use('/api', jwtMiddleware);
 */
export function createJwtAuthMiddleware(deviceTokenService?: DeviceTokenService) {
  return async function jwtAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Skip JWT validation for public routes
    if (PUBLIC_ROUTES.some((route) => req.path.startsWith(route))) {
      return next();
    }

    // Local-first per-request gate: in local mode the
    // credential is EITHER a legacy 2-part device token OR the PC-minted
    // 3-part JWT carried in the pairing QR. Route by segment count — mirroring
    // validateSocketAuth (UserValidationHandler) — so a 3-part JWT is NOT fed
    // to DeviceTokenService.validate() (which would reject it as a "Malformed
    // device token") but falls through to the verifyAuthToken block below.
    if (deviceTokenService) {
      const token = extractAuthToken(req);
      if (!token) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
        return;
      }
      // 2-part = device token (legacy); 3-part = PC-minted JWT → fall
      // through to the local verifyAuthToken path below.
      if (token.split('.').length === 2) {
        try {
          const claims = deviceTokenService.validate(token);
          req.deviceUser = claims;
          req.jwtToken = token;
          if (req.session) {
            req.session.authToken = token;
            req.session.userId = claims.clerkUserId;
          }
          return next();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid device token';
          console.error(`[JwtAuth] Device token validation failed: ${message}`);
          res.status(401).json({ error: 'Unauthorized', message });
          return;
        }
      }
      // 3-part JWT: continue to the verifyAuthToken block below. If JWT_SECRET
      // is unset (isJwtConfigured() === false) a present-but-unverifiable token
      // must NOT fail open — reject it deterministically here.
      if (!isJwtConfigured()) {
        res.status(401).json({ error: 'Unauthorized', message: 'JWT validation not configured' });
        return;
      }
    }

    // Skip if no validation method is configured
    if (!isJwtConfigured()) {
      return next();
    }

    try {
      // 1. Extract token from Authorization header (priority)
      let token: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove "Bearer " prefix
      }

      // 2. Fallback: Extract token from query param (for <img> tags that can't send headers)
      if (!token && req.query.token) {
        token = req.query.token as string;
      }

      // 3. Fallback: Extract token from session (after Clerk exchange or JWT auth)
      if (!token && req.session?.authToken) {
        token = req.session.authToken;
      }

      // 4. No token found - continue without JWT auth
      if (!token) {
        return next();
      }

      // 5. Verify JWT signature and expiration locally
      let payload: AuthTokenPayload;
      try {
        payload = verifyAuthToken(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token';
        console.error(`[JwtAuth] Token verification failed: ${message}`);
        res.status(401).json({
          error: 'Unauthorized',
          message,
          redirectUrl: GATEWAY_URL,
        });
        return;
      }

      // 6. Attach user info to request
      req.jwtUser = payload;
      req.jwtToken = token;

      // Populate MINIMAL session data - only user identity + JWT reference
      // All tokens should be extracted from JWT payload when needed
      if (req.session) {
        req.session.authToken = token; // JWT string (decode to get tokens/user data)
        req.session.userId = payload.userId; // User identity
        req.session.userEmail = payload.email; // User identity
      }

      // 7. Check if token needs renewal (sliding expiration with threshold)
      // Only renew if token expires in less than RENEWAL_THRESHOLD_SECONDS
      const now = Math.floor(Date.now() / 1000);
      const timeUntilExpiry = payload.exp ? payload.exp - now : 0;

      if (timeUntilExpiry > 0 && timeUntilExpiry < RENEWAL_THRESHOLD_SECONDS) {
        try {
          // Local renewal (remote renewal service retired)
          const renewedToken = renewAuthToken(token);
          res.setHeader(RENEWED_TOKEN_HEADER, renewedToken);
          console.log(`[JwtAuth] Token renewed (${Math.floor(timeUntilExpiry / 3600)}h remaining)`);
        } catch (renewError) {
          // Non-fatal: log but continue (token is still valid)
          console.warn('[JwtAuth] Failed to renew token:', renewError);
        }
      }

      // 8. Continue to route handler
      next();
    } catch (error) {
      console.error('[JwtAuth] Unexpected error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication processing failed',
      });
    }
  };
}

/**
 * Middleware to require JWT authentication (strict mode)
 *
 * Use this for routes that MUST have JWT validation.
 * Returns 401 if no valid token found.
 *
 * @example
 * router.get('/api/protected', requireJwtAuth, handler);
 */
export function requireJwtAuth(req: Request, res: Response, next: NextFunction): void {
  // In local mode the device token (req.deviceUser) is the gate; in sandbox mode
  // it's the JWT (req.jwtUser). Accept either.
  if (!req.jwtUser && !req.deviceUser) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'JWT authentication required',
      redirectUrl: GATEWAY_URL,
    });
    return;
  }
  next();
}

/**
 * Middleware for optional JWT authentication
 *
 * Continues even if no valid token found.
 * Use for routes that can work with or without authentication.
 *
 * @example
 * router.get('/api/public-profile', optionalJwtAuth, handler);
 */
export function optionalJwtAuth(req: Request, res: Response, next: NextFunction): void {
  // Just continue - jwtUser will be undefined if not authenticated
  next();
}

/**
 * Extract JWT token from request
 *
 * Utility function to get token from Authorization header.
 *
 * @param req Express request
 * @returns JWT token string or null
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

/**
 * Get user info from JWT on request
 *
 * @param req Express request
 * @returns User payload or null
 */
export function getJwtUser(req: Request): AuthTokenPayload | null {
  return req.jwtUser || null;
}
