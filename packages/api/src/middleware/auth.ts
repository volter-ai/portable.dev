/**
 * Session authentication guard.
 *
 * `requireAuth` gates protected routes on an authenticated Express session. The
 * session is populated upstream by the per-request JWT / device-token middleware
 * (`jwtAuth.ts`, `createJwtAuthMiddleware`) — this file only asserts that a user
 * identity is present before the route handler runs.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware to ensure user is authenticated for protected routes
 *
 * This checks if the Express session has user data (populated by the JWT auth
 * middleware in `jwtAuth.ts`). Use this on routes that require authentication.
 *
 * @param req Express request object
 * @param res Express response object
 * @param next Next middleware function
 *
 * @example
 * // Protect a route:
 * app.get('/api/protected', requireAuth, (req, res) => {
 *   res.json({ user: req.session.user });
 * });
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Check for authentication in priority order:
  // 1. JWT middleware populated session (from Bearer token or Clerk exchange)
  // 2. JWT user from jwtAuthMiddleware (req.jwtUser)
  // 3. GitHub OAuth session (dev mode)
  const userEmail =
    req.session?.userEmail || // JWT Bearer token or Clerk session (production)
    (req as any).jwtUser?.email || // JWT from jwtAuthMiddleware (Clerk JWT tokens)
    req.session?.githubUser?.email; // GitHub OAuth (dev mode)

  if (!userEmail) {
    console.error('[Auth] Unauthorized request: No user found');
    console.error('[Auth] Debug info:', {
      sessionUserEmail: !!req.session?.userEmail,
      jwtUserEmail: !!(req as any).jwtUser?.email,
      githubUserEmail: !!req.session?.githubUser?.email,
      hasSession: !!req.session,
      hasJwtUser: !!(req as any).jwtUser,
    });
    res.status(401).json({ error: 'Unauthorized: Please log in' });
    return;
  }

  // User is authenticated, continue
  next();
}
