/**
 * Stop-on-PC route (`POST /api/chat/:sessionId/stop-on-pc`) — rev12 D59/D60.
 *
 * AUTHED (mounted under the JWT-gated `/api` surface — the caller is the mobile
 * app, unlike the secret-gated `/api/internal/*` hook/sidecar ingest). Delivers
 * a stop to a live TERMINAL `claude` session (sessionId == the Claude Code
 * session id == the discovered chat id) and reports whether it was confirmed,
 * so the client can decide between "continue here" (confirmed) and "fork".
 */
import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';

import type { StopMode, StopOnPcService } from '../../services/StopOnPcService.js';

export function createStopOnPcRoutes(stopOnPc: StopOnPcService): Router {
  const router = Router();

  router.post('/chat/:sessionId/stop-on-pc', requireAuth, async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '');
    const rawMode = (req.body ?? {}).mode;
    const mode: StopMode = rawMode === 'interrupt' ? 'interrupt' : 'end';
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }
    try {
      const result = await stopOnPc.stop(sessionId, mode);
      return res.status(200).json(result);
    } catch (error) {
      console.error('[StopOnPc] stop failed:', error);
      return res.status(500).json({ error: 'stop failed' });
    }
  });

  return router;
}
