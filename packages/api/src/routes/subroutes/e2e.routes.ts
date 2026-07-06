/**
 * E2E encryption routes — the handshake + the HTTP full tunnel
 * (portable.dev#13).
 *
 *   POST /api/e2e/handshake  (PUBLIC — the PSK-keyed MAC is the auth; listed in
 *                             jwtAuth PUBLIC_ROUTES) — body: E2eHandshakeInit,
 *                             answer: E2eHandshakeResponse. The relay cannot
 *                             complete it without the QR-carried PSK.
 *
 *   POST /api/e2e            (behind the JWT gate — outer Bearer is defense in
 *                             depth; identity is by-design visible) — body:
 *                             E2eTunnelPayload whose envelope (c2s key) carries
 *                             the REAL request {method, path, headers, bodyB64}.
 *                             The route decrypts, dispatches through the
 *                             injected seam, and answers with an envelope (s2c
 *                             key) carrying {status, headers, bodyB64}.
 *
 * Error contract (all OUTER, deliberately coarse — no oracle detail):
 *   503 e2e_unconfigured   — no PSK on this PC (bare `bun run dev` w/o launcher)
 *   401 e2e_auth_failed    — handshake init MAC rejected
 *   410 e2e_session_unknown — sid expired/unknown → client re-handshakes
 *   400 e2e_bad_request    — malformed payload / decrypt failure / blocked path
 *
 * Routes stay THIN: crypto + sessions live in E2eSessionService; the actual
 * dispatch is the injected `dispatch` seam (production: a loopback self-fetch
 * wired in server.ts; tests inject a fake).
 */
import crypto from 'crypto';

import {
  E2eAuthError,
  E2eDecryptError,
  openJson,
  sealJson,
  textToB64,
  type E2eHandshakeInit,
  type E2eInnerRequest,
  type E2eInnerResponse,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';
import { Router, type Request, type Response } from 'express';

import type { E2eSessionService } from '../../services/E2eSessionService.js';

/** Dispatch seam: run the decrypted inner request against this api. */
export type E2eDispatch = (inner: E2eInnerRequest) => Promise<E2eInnerResponse>;

/**
 * Inner-request headers forwarded to the dispatch. Everything else is dropped
 * (hop-by-hop and infrastructure headers are the dispatcher's business).
 */
const FORWARDABLE_REQUEST_HEADERS = ['authorization', 'content-type', 'accept'];

/**
 * Marker header stamped on every dispatched inner request so the enforcement
 * middleware can tell tunnelled traffic from a plaintext call that merely
 * carries a valid Bearer (the relay sees the Bearer; it can never mint this
 * path because it cannot produce a valid envelope).
 */
export const E2E_TUNNEL_HEADER = 'x-portable-e2e';

const rand = (n: number) => new Uint8Array(crypto.randomBytes(n));

function sendCode(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

/** Validate + normalize the inner request; null when it must be rejected. */
export function sanitizeInnerRequest(inner: E2eInnerRequest): E2eInnerRequest | null {
  if (!inner || typeof inner !== 'object') return null;
  const method = typeof inner.method === 'string' ? inner.method.toUpperCase() : '';
  const path = typeof inner.path === 'string' ? inner.path : '';
  if (!/^[A-Z]+$/.test(method)) return null;
  // Absolute-path only (no scheme/host → no SSRF), and never the tunnel itself.
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  const pathOnly = path.split('?')[0];
  if (pathOnly === '/api/e2e' || pathOnly.startsWith('/api/e2e/')) return null;

  const headers: Record<string, string> = {};
  if (inner.headers && typeof inner.headers === 'object') {
    for (const name of FORWARDABLE_REQUEST_HEADERS) {
      const value = (inner.headers as Record<string, unknown>)[name];
      if (typeof value === 'string') headers[name] = value;
    }
  }
  headers[E2E_TUNNEL_HEADER] = '1';
  return { method, path, headers, bodyB64: inner.bodyB64 };
}

export function createE2eRoutes(e2eService: E2eSessionService, dispatch: E2eDispatch): Router {
  const router = Router();

  // ── Handshake (public; PSK MAC is the credential) ─────────────────────────
  router.post('/e2e/handshake', (req: Request, res: Response) => {
    if (!e2eService.isConfigured()) {
      sendCode(res, 503, 'e2e_unconfigured', 'E2E is not configured on this PC');
      return;
    }
    try {
      const response = e2eService.handshake(req.body as E2eHandshakeInit);
      res.status(200).json(response);
    } catch (err) {
      if (err instanceof E2eAuthError) {
        sendCode(res, 401, 'e2e_auth_failed', 'handshake authentication failed');
        return;
      }
      sendCode(res, 400, 'e2e_bad_request', 'malformed handshake');
    }
  });

  // ── The full tunnel ────────────────────────────────────────────────────────
  router.post('/e2e', async (req: Request, res: Response) => {
    if (!e2eService.isConfigured()) {
      sendCode(res, 503, 'e2e_unconfigured', 'E2E is not configured on this PC');
      return;
    }
    const payload = req.body as E2eTunnelPayload;
    if (!payload || typeof payload.sid !== 'string' || !payload.env) {
      sendCode(res, 400, 'e2e_bad_request', 'malformed tunnel payload');
      return;
    }
    const keys = e2eService.getSessionKeys(payload.sid);
    if (!keys) {
      sendCode(res, 410, 'e2e_session_unknown', 'unknown or expired E2E session');
      return;
    }

    let inner: E2eInnerRequest | null;
    try {
      inner = sanitizeInnerRequest(openJson<E2eInnerRequest>(keys.c2s, payload.env));
    } catch (err) {
      // Decrypt failure and malformed plaintext collapse into one coarse error.
      if (err instanceof E2eDecryptError || err instanceof SyntaxError) {
        sendCode(res, 400, 'e2e_bad_request', 'envelope failed to open');
        return;
      }
      throw err;
    }
    if (!inner) {
      sendCode(res, 400, 'e2e_bad_request', 'inner request rejected');
      return;
    }

    // The OUTER request already passed the JWT gate; carry that identity onto the
    // inner (loopback) dispatch so the phone need not duplicate the Bearer inside
    // the envelope. An explicit inner Authorization (if the client set one) wins.
    const outerAuth = req.headers.authorization;
    if (!inner.headers.authorization && typeof outerAuth === 'string') {
      inner.headers.authorization = outerAuth;
    }

    let innerResponse: E2eInnerResponse;
    try {
      innerResponse = await dispatch(inner);
    } catch {
      innerResponse = { status: 502, headers: {}, bodyB64: undefined };
    }

    // Surface the renewed JWT on the OUTER response too — the identity token is
    // by-design visible, and the client's authedFetch reads outer headers.
    const renewed = innerResponse.headers['x-renewed-token'];
    if (renewed) res.setHeader('X-Renewed-Token', renewed);

    res.status(200).json({
      sid: payload.sid,
      env: sealJson(keys.s2c, innerResponse, rand),
    });
  });

  return router;
}

/**
 * Production dispatch: replay the inner request against this api over
 * loopback. The api is pinned to 127.0.0.1 in local mode, so this never leaves
 * the machine; every middleware (JWT auth, body parsing, routes) applies to the
 * inner request exactly as if the phone had called it directly.
 *
 * `innerSecret` is stamped as the `x-portable-e2e-inner` header so the E2E
 * enforcement middleware trusts this replay (the relay can't produce it — it
 * never leaves the process). See `middleware/e2eEnforcement.ts`.
 */
export function createLoopbackDispatch(getBaseUrl: () => string, innerSecret: string): E2eDispatch {
  return async (inner: E2eInnerRequest): Promise<E2eInnerResponse> => {
    const url = `${getBaseUrl()}${inner.path}`;
    const hasBody = inner.bodyB64 !== undefined && !['GET', 'HEAD'].includes(inner.method);
    const response = await fetch(url, {
      method: inner.method,
      headers: { ...inner.headers, 'x-portable-e2e-inner': innerSecret },
      body: hasBody && inner.bodyB64 ? Buffer.from(inner.bodyB64, 'base64') : undefined,
    });
    const bodyText = await response.text();
    const headers: Record<string, string> = {};
    const contentType = response.headers.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    const renewedToken = response.headers.get('x-renewed-token');
    if (renewedToken) headers['x-renewed-token'] = renewedToken;
    return {
      status: response.status,
      headers,
      bodyB64: bodyText.length > 0 ? textToB64(bodyText) : undefined,
    };
  };
}
