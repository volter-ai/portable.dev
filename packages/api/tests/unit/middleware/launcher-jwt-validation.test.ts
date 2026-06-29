/**
 * rev6 (QR-pairing rework) regression: launcher-minted JWT validates on the PC.
 *
 * Per `tasks/prd-local-first-pivot-rev6-qr-pairing.md` D16, the **launcher** mints
 * the data-path JWT with `generateAuthToken({ userId, username, email }, JWT_SECRET)`
 * (@vgit2/shared/jwt) and passes `JWT_SECRET` to the api child env (D17). The api
 * gets NO pairing endpoint (its port is tunneled — `/t/<pcId>/api/pair` would leak
 * the JWT). It just validates the incoming Bearer JWT **locally** on every request.
 *
 * This file LOCKS that validation path end-to-end with NO behavioral change to the
 * api: it proves a token of the exact launcher shape validates on
 *  - the REST middleware (`createJwtAuthMiddleware()`, wired WITHOUT a
 *    DeviceTokenService — the rev6 wiring, since device tokens are dropped in D11), and
 *  - the Socket.IO handshake (`UserValidationHandler.validateSocketAuth`, no device
 *    token in deps — the 3-part JWT branch, `username` present per D16).
 *
 * The signing secret is `process.env.JWT_SECRET` — force-set by the test preload
 * (`tests/setup/preload.ts`) before `@vgit2/shared` loads, so it is the SAME secret
 * `verifyAuthToken` reads from `constants.JWT_SECRET`. That mirrors D17 exactly: the
 * launcher mints and the api validates with one shared local secret.
 *
 * Each case asserts ONE deterministic outcome.
 */
import { describe, expect, it } from 'bun:test';

import { generateAuthToken } from '@vgit2/shared/jwt';

import { createJwtAuthMiddleware, RENEWED_TOKEN_HEADER } from '../../../src/middleware/jwtAuth.js';
import { UserValidationHandler } from '../../../src/services/AuthService/handlers/UserValidationHandler.js';

import type { HandlerDependencies } from '../../../src/services/AuthService/types.js';
import type { NextFunction, Request, Response } from 'express';

// The launcher-minted identity shape (D16/D20): a stable local user with the
// mandatory `username` (the Socket.IO handshake rejects a JWT without it).
const LAUNCHER_PAYLOAD = {
  userId: 'pc_local_user',
  username: 'localhost',
  email: 'local@host',
} as const;

/**
 * Mint a JWT exactly the way the launcher does (D16): `generateAuthToken` with the
 * locally-ensured `JWT_SECRET`. The api validates with the SAME secret from env.
 */
function mintLauncherJwt(overrides?: Partial<typeof LAUNCHER_PAYLOAD>): string {
  return generateAuthToken({ ...LAUNCHER_PAYLOAD, ...overrides }, process.env.JWT_SECRET);
}

interface MockRes {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  status: (code: number) => MockRes;
  json: (b: unknown) => MockRes;
  setHeader: (name: string, value: string) => void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
  };
  return res;
}

function makeReq(authToken?: string, pathName = '/api/chats'): Request {
  return {
    path: pathName,
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
    query: {},
    session: {} as Request['session'],
  } as unknown as Request;
}

describe('rev6: launcher-minted JWT validates on REST (jwtAuth middleware, no device-token)', () => {
  it('accepts a launcher-minted JWT and calls next() with req.jwtUser populated', async () => {
    const token = mintLauncherJwt();
    // rev6 wiring: NO DeviceTokenService (device tokens dropped in D11) → JWT path.
    const middleware = createJwtAuthMiddleware();

    const req = makeReq(token);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(req.jwtUser?.userId).toBe(LAUNCHER_PAYLOAD.userId);
    expect(req.jwtUser?.username).toBe(LAUNCHER_PAYLOAD.username);
    expect(req.jwtUser?.email).toBe(LAUNCHER_PAYLOAD.email);
    // A fresh 72h token is nowhere near the 24h renewal threshold → no renewal.
    expect(res.headers[RENEWED_TOKEN_HEADER]).toBeUndefined();
  });

  it('rejects a JWT signed with the WRONG secret (proves real local validation)', async () => {
    const forged = generateAuthToken(LAUNCHER_PAYLOAD, 'a-different-secret-not-the-pc-jwt-secret');
    const middleware = createJwtAuthMiddleware();

    const req = makeReq(forged);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe('rev6: launcher-minted JWT validates on Socket.IO (validateSocketAuth, no device-token)', () => {
  function makeHandler(): UserValidationHandler {
    // rev6 wiring: NO deviceTokenService in deps → the 3-part JWT branch runs.
    const deps = {} as unknown as HandlerDependencies;
    return new UserValidationHandler(deps, []);
  }

  it('accepts a launcher-minted JWT (3-part, username present) on the handshake', async () => {
    const token = mintLauncherJwt();
    const handler = makeHandler();

    const result = await handler.validateSocketAuth(token);

    expect(result.valid).toBe(true);
    expect(result.userEmail).toBe(LAUNCHER_PAYLOAD.email);
    expect(result.username).toBe(LAUNCHER_PAYLOAD.username);
  });

  it('rejects a 3-part JWT missing the mandatory username field (D16 warning)', async () => {
    // Mint without `username` to prove the handshake enforces D16's hard requirement.
    const token = generateAuthToken(
      { userId: 'pc_local_user', email: 'local@host' } as typeof LAUNCHER_PAYLOAD,
      process.env.JWT_SECRET
    );
    const handler = makeHandler();

    const result = await handler.validateSocketAuth(token);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('username');
  });
});
