/**
 * jwtAuth device-token middleware tests.
 *
 * In local mode the device token — not a Clerk JWT — is the per-request gate.
 * Each case asserts ONE deterministic outcome:
 *  - valid device token   -> next() called, req.deviceUser populated, no 401
 *  - missing token        -> 401 (no next)
 *  - invalid/tampered      -> 401 (no next)
 *  - revoked token        -> 401 (no next)
 *  - public route          -> next() without any token
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { generateAuthToken } from '@vgit2/shared/jwt';
import { LocalSecretStore } from '@vgit2/shared/secrets';

import { createJwtAuthMiddleware } from '../../../src/middleware/jwtAuth.js';
import { DeviceTokenService } from '../../../src/services/DeviceTokenService.js';

import type { NextFunction, Request, Response } from 'express';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-jwtauth-device-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeService(): DeviceTokenService {
  return new DeviceTokenService(new LocalSecretStore({ dataDir: tmpDir }));
}

interface MockRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => MockRes;
  json: (b: unknown) => MockRes;
  setHeader: () => void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader() {},
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

describe('createJwtAuthMiddleware (device-token, local mode)', () => {
  it('accepts a valid device token and calls next() with req.deviceUser set', async () => {
    const svc = makeService();
    const { token, claims } = svc.mint('iPhone', 'user_clerk_1');
    const middleware = createJwtAuthMiddleware(svc);

    const req = makeReq(token);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(req.deviceUser?.clerkUserId).toBe('user_clerk_1');
    expect(req.deviceUser?.tokenId).toBe(claims.tokenId);
  });

  it('returns 401 when no device token is present', async () => {
    const svc = makeService();
    const middleware = createJwtAuthMiddleware(svc);

    const req = makeReq(undefined);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { message?: string }).message).toContain('Authentication required');
  });

  it('accepts a 3-part launcher-minted JWT even when a DeviceTokenService is wired (QR credential)', async () => {
    // Reproduces the PRODUCTION wiring (server.ts passes this.deviceTokenService to
    // createJwtAuthMiddleware). The pairing credential carried in the QR is a
    // 3-part JWT minted by the launcher with the shared JWT_SECRET — it must route
    // to verifyAuthToken (segment count !== 2), NOT be rejected by
    // DeviceTokenService.validate() as "Malformed device token".
    const svc = makeService();
    const middleware = createJwtAuthMiddleware(svc);
    const token = generateAuthToken(
      { userId: 'pc_local_user', username: 'localhost', email: 'local@host' },
      process.env.JWT_SECRET
    );

    const req = makeReq(token);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(req.jwtUser?.userId).toBe('pc_local_user');
    expect(req.deviceUser).toBeUndefined();
  });

  it('returns 401 for an invalid (tampered) device token', async () => {
    const svc = makeService();
    const { token } = svc.mint('iPad', 'user_clerk_2');
    const [payloadB64, sig] = token.split('.');
    const mutated = Buffer.from(payloadB64, 'base64url');
    mutated[0] = mutated[0] ^ 0xff;
    const tampered = `${mutated.toString('base64url')}.${sig}`;

    const middleware = createJwtAuthMiddleware(svc);
    const req = makeReq(tampered);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a revoked device token', async () => {
    const svc = makeService();
    const { token, claims } = svc.mint('Pixel', 'user_clerk_3');
    svc.revoke(claims.tokenId);

    const middleware = createJwtAuthMiddleware(svc);
    const req = makeReq(token);
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('skips auth for public routes (no token needed)', async () => {
    const svc = makeService();
    const middleware = createJwtAuthMiddleware(svc);

    const req = makeReq(undefined, '/api/health');
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await middleware(req, res as unknown as Response, next);

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });
});
