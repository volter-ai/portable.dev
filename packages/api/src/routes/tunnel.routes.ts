import { Router } from 'express';

import type { TunnelService } from '../services/TunnelService.js';

/**
 * Internal API routes for TunnelService
 *
 * These routes are used by user containers (lazy adapter) to create/destroy
 * Cloudflare tunnels for localhost URLs.
 */
export function createTunnelRoutes(tunnelService: TunnelService): Router {
  const router = Router();

  /**
   * POST /internal/tunnel/create
   * Create a dynamic Cloudflare tunnel for a localhost port
   *
   * Body: { userId: string, port: number }
   * Response: { url: string, port: number, createdAt: number }
   */
  router.post('/internal/tunnel/create', async (req, res) => {
    try {
      const { userId, port } = req.body;

      if (!userId || !port) {
        return res.status(400).json({
          error: 'Missing required fields: userId, port',
        });
      }

      if (typeof port !== 'number' || port < 1 || port > 65535) {
        return res.status(400).json({
          error: 'Invalid port number (must be 1-65535)',
        });
      }

      console.log(`[TunnelRoutes] Creating tunnel for user ${userId} on port ${port}`);

      const tunnelUrl = await tunnelService.createDynamicTunnel(userId, port, 'app');

      return res.json({
        url: tunnelUrl,
        port: port,
        createdAt: Date.now(),
      });
    } catch (error: any) {
      console.error('[TunnelRoutes] Error creating tunnel:', error);

      if (error.message?.includes('Rate limit exceeded')) {
        return res.status(429).json({
          error: error.message,
        });
      }

      return res.status(500).json({
        error: 'Failed to create tunnel',
        message: error.message,
      });
    }
  });

  /**
   * POST /internal/tunnel/destroy
   * Destroy a dynamic tunnel by user ID and port
   *
   * Body: { userId: string, port: number }
   * Response: { success: boolean }
   */
  router.post('/internal/tunnel/destroy', async (req, res) => {
    try {
      const { userId, port } = req.body;

      if (!userId || !port) {
        return res.status(400).json({
          error: 'Missing required fields: userId, port',
        });
      }

      console.log(`[TunnelRoutes] Destroying tunnel for user ${userId} on port ${port}`);

      // Find tunnel ID by userId and port
      const userTunnels = tunnelService.getUserTunnels(userId);
      const tunnel = userTunnels.find((t) => t.port === port);

      if (!tunnel) {
        console.warn(`[TunnelRoutes] Tunnel not found for user ${userId}, port ${port}`);
        return res.json({ success: true }); // Already destroyed or never existed
      }

      await tunnelService.destroyTunnel(tunnel.id);

      return res.json({ success: true });
    } catch (error: any) {
      console.error('[TunnelRoutes] Error destroying tunnel:', error);

      return res.status(500).json({
        error: 'Failed to destroy tunnel',
        message: error.message,
      });
    }
  });

  /**
   * GET /internal/tunnel/status
   * Get status of all tunnels for a user
   *
   * Query: userId=string
   * Response: { tunnels: Array<{ id, url, port, createdAt }> }
   */
  router.get('/internal/tunnel/status', async (req, res) => {
    try {
      const { userId } = req.query;

      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({
          error: 'Missing required query parameter: userId',
        });
      }

      const tunnels = tunnelService.getUserTunnels(userId);

      return res.json({ tunnels });
    } catch (error: any) {
      console.error('[TunnelRoutes] Error getting tunnel status:', error);

      return res.status(500).json({
        error: 'Failed to get tunnel status',
        message: error.message,
      });
    }
  });

  return router;
}
