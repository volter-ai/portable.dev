import { NODE_ENV } from '@vgit2/shared/constants';
import { Router } from 'express';

/**
 * Health check and system status routes
 * No authentication required for monitoring endpoints
 */
export function createHealthRoutes(): Router {
  const router = Router();

  // Health check endpoint (for Docker healthcheck and monitoring)
  router.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: NODE_ENV,
    });
  });

  // Heartbeat endpoint (for connection validation - lighter than health check)
  router.get('/heartbeat', (req, res) => {
    res.status(200).json({
      alive: true,
      timestamp: Date.now(),
    });
  });

  // Version endpoint (returns semantic version of running sandbox)
  router.get('/version', (req, res) => {
    res.status(200).json({
      version: process.env.VGIT_VERSION || 'unknown',
    });
  });

  // Minimum required client version endpoint (no auth required)
  // Bump MINIMUM_APP_VERSION here when a breaking change ships that requires
  // users to update their native app from the store.
  const MINIMUM_APP_VERSION = '1.0.27';
  router.get('/min-version', (_req, res) => {
    res.status(200).json({
      minimumVersion: MINIMUM_APP_VERSION,
      currentServerVersion: process.env.VGIT_VERSION || 'unknown',
    });
  });

  // Ownership verification endpoint. In the local-first runtime the api runs on the
  // user's OWN PC — there is no remote sandbox owner to verify against — so the caller
  // is always reported as the owner. (Kept for client back-compat.)
  router.get('/verify-ownership', (req, res) => {
    try {
      const jwtUserId =
        req.session?.userId || (req as any).jwtUser?.userId || req.session?.githubUser?.id;

      const jwtUsername =
        req.session?.username || (req as any).jwtUser?.username || req.session?.githubUser?.login;

      return res.status(200).json({
        isOwner: true,
        sandboxUserId: null,
        jwtUserId,
        jwtUsername,
        mode: 'local',
        message: 'Local-first runtime (own PC) — ownership verification not applicable',
      });
    } catch (error: any) {
      console.error('[API] Error verifying ownership:', error);
      res.status(500).json({
        error: 'Failed to verify ownership',
        details: error.message,
      });
    }
  });

  return router;
}
