/**
 * E2E plaintext-rejection enforcement (portable.dev#13, hard cutover).
 *
 * Once E2E is configured on this PC (`PORTABLE_E2E_PSK` set), a protected
 * `/api/*` request MUST arrive through the encrypted tunnel. The tunnel
 * decrypts the phone's envelope and REPLAYS the inner request over loopback
 * with a per-boot secret header (`x-portable-e2e-inner`) that never leaves the
 * process — so the relay, which sees the Bearer JWT, still cannot forge a
 * plaintext request to a protected route (it can't produce the secret).
 *
 * Why a secret and not just "did it come over the tunnel": the loopback replay
 * re-enters the SAME express app through this very middleware, so we need a way
 * to distinguish the trusted inner replay from an external plaintext call. The
 * secret is that proof.
 *
 * EXEMPT (legitimately plaintext, never through the tunnel):
 *   - health / version probes (gateway + launcher + app health monitors)
 *   - the E2E routes themselves (`/api/e2e`, `/api/e2e/handshake`)
 *   - `/api/internal/*` (loopback-only, its own secret gate; mounted earlier)
 *   - binary media / raw-file bytes fetched by NATIVE loaders (can't decrypt in
 *     JS) + multipart upload — the documented remaining plaintext surfaces.
 */
import type { E2eSessionService } from '../services/E2eSessionService.js';
import type { NextFunction, Request, Response } from 'express';

/** Header the loopback dispatch stamps with the per-boot inner secret. */
export const E2E_INNER_SECRET_HEADER = 'x-portable-e2e-inner';

/**
 * Path prefixes that stay plaintext even when E2E is on. Matched against
 * `req.path` (the router mounts this at `/api`, so paths are `/api/...`).
 */
const EXEMPT_PREFIXES = [
  '/api/health',
  '/api/healthcheck',
  '/api/heartbeat',
  '/api/version',
  '/api/min-version',
  '/api/e2e', // the tunnel + handshake
  '/api/internal',
  // Binary / media surfaces fetched directly by native loaders (see #13 gap):
  '/api/video/',
  '/api/uploads/',
  '/api/workspace-file',
  '/api/upload', // multipart POST — documented plaintext gap
];

/** True for a path that legitimately bypasses the tunnel. */
function isExempt(path: string): boolean {
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return true;
  // Raw repo file bytes: /api/repos/:owner/:repo/raw/<path> (native loaders).
  if (/^\/api\/repos\/[^/]+\/[^/]+\/raw\//.test(path)) return true;
  return false;
}

/** Constant-time string compare (avoid a timing oracle on the inner secret). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Build the enforcement middleware. `innerSecret` is the per-boot secret the
 * loopback dispatch sets; when E2E is unconfigured (a bare `bun run dev` with
 * no launcher) enforcement is a no-op so local dev + tests are unaffected.
 */
export function createE2eEnforcementMiddleware(
  e2eService: Pick<E2eSessionService, 'isConfigured'>,
  innerSecret: string
) {
  return function e2eEnforcement(req: Request, res: Response, next: NextFunction): void {
    if (!e2eService.isConfigured()) {
      next();
      return;
    }
    // Mounted at `/api`, so `req.path` is stripped of the prefix — reconstruct the
    // full path (`req.baseUrl` + `req.path`) so the `/api/...` exemptions match.
    const fullPath = `${req.baseUrl || ''}${req.path}`;
    if (isExempt(fullPath)) {
      next();
      return;
    }
    const provided = req.headers[E2E_INNER_SECRET_HEADER];
    if (typeof provided === 'string' && innerSecret && safeEqual(provided, innerSecret)) {
      // The trusted loopback replay of a decrypted tunnel request.
      next();
      return;
    }
    // A plaintext request to a protected route — rejected (hard cutover). This
    // fires even with a valid Bearer, closing the "malicious relay replays the
    // token in the clear" hole.
    res.status(426).json({
      error: 'End-to-end encryption required',
      code: 'e2e_required',
    });
  };
}
