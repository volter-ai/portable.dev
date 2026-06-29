import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';

import type { TunnelService } from '../../services/TunnelService.js';
import type { TunnelRepairResult } from '@vgit2/shared/types';

/** Minimal slice of SocketIOService used to re-broadcast runtime state. */
interface RuntimeBroadcaster {
  broadcastRuntimeStateToUser(userId: string): void;
}

/**
 * Authed, user-facing tunnel API (mounted under `/api`, behind the JWT middleware).
 *
 * Distinct from the unauthed in-process `/internal/tunnel/*` routes: this is the
 * surface the MOBILE app calls to lazily repair a dead dev-server preview tunnel it
 * just touched (the `*.trycloudflare.com` → Cloudflare Bad Gateway case). The repair
 * is keyed by PORT and scoped to the authenticated user; it re-creates only that one
 * tunnel (no mass reopen) and re-broadcasts runtime state so every client converges.
 */
export function createTunnelApiRoutes(
  tunnelService: TunnelService,
  socketIOService?: RuntimeBroadcaster
): Router {
  const router = Router();

  /**
   * POST /api/tunnels/repair
   * Body: { port: number, chatId?: string, repoPath?: string, name?: string, main?: boolean }
   * Response: TunnelRepairResult ({ status: 'repaired', port, url } | { status: 'dev_server_down', port })
   *
   * `dev_server_down` is a normal domain outcome (HTTP 200), not an error — the
   * client renders a "restart your dev server" prompt rather than a Cloudflare page.
   */
  router.post('/tunnels/repair', requireAuth, async (req, res) => {
    const userEmail = req.session?.userEmail;
    if (!userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { port, chatId, repoPath, name, main } = req.body ?? {};
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Invalid or missing port (must be 1-65535)' });
    }

    try {
      const result: TunnelRepairResult = await tunnelService.repairTunnel(userEmail, port, {
        chatId: typeof chatId === 'string' ? chatId : undefined,
        repoPath: typeof repoPath === 'string' ? repoPath : undefined,
        name: typeof name === 'string' ? name : undefined,
        main: typeof main === 'boolean' ? main : undefined,
      });

      // Push the fresh snapshot to every connected client (the repair already
      // re-broadcasts via TunnelService's state-change callback, but this is the
      // explicit, surface-agnostic guarantee that the client reloads with truth).
      socketIOService?.broadcastRuntimeStateToUser(userEmail);

      return res.json(result);
    } catch (error: any) {
      console.error('[TunnelApiRoutes] Error repairing tunnel:', error);
      return res.status(500).json({ error: 'Failed to repair tunnel', message: error?.message });
    }
  });

  return router;
}
