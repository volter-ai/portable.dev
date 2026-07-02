/**
 * Internal loopback routes (`/api/internal/*`) — rev12 (PRD D53/D54/D58).
 *
 * The ingest surface for the launcher-registered Claude Code integrations:
 * - `POST /claude-hook` — lifecycle events relayed by `portable hook-relay`
 *   (global hooks in the user's `~/.claude/settings.json`).
 * - `GET /external-sessions` — the live terminal-session registry (consumed by
 *   the launcher TUI's "MCP Server" status view).
 *
 * AUTH MODEL — mounted BEFORE the JWT middleware in server.ts, gated instead
 * by the per-boot internal secret (`x-portable-internal-secret`, written by
 * the launcher into `internal-bridge.json` and passed to this process as
 * `PORTABLE_HOOK_SECRET`). The secret is the REAL gate: the cloudflared tunnel
 * proxies public traffic to the same loopback port, so a loopback remote
 * address proves nothing. No secret configured ⇒ every request rejected
 * (fail closed).
 */
import crypto from 'crypto';

import { Router, type Request, type Response, type NextFunction } from 'express';

import type {
  ExternalClaudeSessionService,
  ExternalHookEvent,
} from '../../services/ExternalClaudeSessionService.js';
import type { SidecarChannelService } from '../../services/SidecarChannelService.js';

/** Header carrying the per-boot internal secret (mirrors launcher HookRelay). */
export const INTERNAL_SECRET_HEADER = 'x-portable-internal-secret';

/** Constant-time secret comparison (no early-exit timing signal). */
function secretsMatch(got: string | undefined, expected: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; a length check is itself constant
  // vs the byte compare, and the secret length isn't sensitive.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface InternalRoutesOptions {
  /** Read the expected secret at REQUEST time (env may be set after mount in tests). */
  secret?: () => string | undefined;
  /** Fired after an ingest that changed visible state (→ runtime rebroadcast). */
  onSessionsChanged?: () => void;
  /** Fired after EVERY successful ingest with the raw event (turn-complete signals). */
  onHookEvent?: (event: ExternalHookEvent) => void;
  /** The mcp-sidecar channel (register + long-poll). Absent ⇒ sidecar routes 404. */
  sidecarChannel?: SidecarChannelService;
}

export function createInternalRoutes(
  externalSessions: ExternalClaudeSessionService,
  options: InternalRoutesOptions = {}
): Router {
  const router = Router();
  const readSecret = options.secret ?? (() => process.env.PORTABLE_HOOK_SECRET);

  const requireSecret = (req: Request, res: Response, next: NextFunction) => {
    const expected = readSecret();
    if (!expected) {
      // Not running under the launcher (no bridge secret) — internal surface off.
      return res.status(503).json({ error: 'internal endpoint disabled' });
    }
    if (!secretsMatch(req.header(INTERNAL_SECRET_HEADER), expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };

  router.post('/claude-hook', requireSecret, (req, res) => {
    try {
      const event = (req.body ?? {}) as ExternalHookEvent;
      const { changed } = externalSessions.ingestHookEvent(event);
      if (changed) options.onSessionsChanged?.();
      options.onHookEvent?.(event);
      res.status(204).end();
    } catch (error) {
      console.error('[Internal] claude-hook ingest failed:', error);
      res.status(500).json({ error: 'ingest failed' });
    }
  });

  router.get('/external-sessions', requireSecret, (_req, res) => {
    try {
      res.status(200).json({ sessions: externalSessions.getLiveSessions() });
    } catch (error) {
      console.error('[Internal] external-sessions read failed:', error);
      res.status(500).json({ error: 'read failed' });
    }
  });

  // ── mcp-sidecar channel (rev12 D58) ────────────────────────────────────────
  const sidecar = options.sidecarChannel;
  if (sidecar) {
    router.post('/sidecar/register', requireSecret, (req, res) => {
      const body = (req.body ?? {}) as { ppid?: unknown; cwd?: unknown };
      const ppid = typeof body.ppid === 'number' ? body.ppid : NaN;
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      if (!Number.isInteger(ppid) || ppid <= 0) {
        return res.status(400).json({ error: 'ppid required' });
      }
      const sessionId = sidecar.register(ppid, cwd);
      return res.status(200).json({ ok: true, sessionId });
    });

    router.get('/sidecar/poll', requireSecret, async (req, res) => {
      const ppid = Number(req.query.pid);
      const waitMs = Number(req.query.waitMs) || 25_000;
      if (!Number.isInteger(ppid) || ppid <= 0) {
        return res.status(400).json({ error: 'pid required' });
      }
      try {
        const command = await sidecar.poll(ppid, waitMs);
        if (!command) return res.status(204).end();
        return res.status(200).json(command);
      } catch (error) {
        console.error('[Internal] sidecar poll failed:', error);
        return res.status(500).json({ error: 'poll failed' });
      }
    });
  }

  return router;
}
