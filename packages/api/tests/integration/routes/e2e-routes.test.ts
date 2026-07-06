/**
 * E2E encryption routes (portable.dev#13) — handshake + HTTP full tunnel.
 *
 * Exercises the phone↔PC protocol end-to-end with the REAL shared crypto on
 * both sides: a client (this test) holding the QR PSK completes the X25519
 * handshake, tunnels a request through `POST /api/e2e`, and reads the
 * decrypted response — while a party WITHOUT the PSK (the relay) is locked out
 * of every step even though it may hold a valid Bearer JWT.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import crypto from 'crypto';
import express, { type Application } from 'express';
import request from 'supertest';

import {
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  encodeBase64,
  openJson,
  sealJson,
  b64ToText,
  textToB64,
  type E2eHandshakeResponse,
  type E2eInnerRequest,
  type E2eInnerResponse,
  type E2eSession,
} from '@vgit2/shared/e2e';

import {
  createE2eRoutes,
  sanitizeInnerRequest,
  E2E_TUNNEL_HEADER,
  type E2eDispatch,
} from '../../../src/routes/subroutes/e2e.routes.js';
import { E2eSessionService } from '../../../src/services/E2eSessionService.js';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));

function makeApp(options: { psk?: Uint8Array; dispatch?: E2eDispatch } = {}): {
  app: Application;
  dispatched: E2eInnerRequest[];
} {
  const dispatched: E2eInnerRequest[] = [];
  const dispatch: E2eDispatch =
    options.dispatch ??
    (async (inner) => {
      dispatched.push(inner);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyB64: textToB64(JSON.stringify({ echoedPath: inner.path })),
      };
    });
  const service = new E2eSessionService({
    pskBase64: options.psk ? encodeBase64(options.psk) : undefined,
  });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', createE2eRoutes(service, dispatch));
  return { app, dispatched };
}

async function handshakeOver(app: Application, psk: Uint8Array): Promise<E2eSession> {
  const init = createHandshakeInit(psk, random);
  const res = await request(app).post('/api/e2e/handshake').send(init.message);
  expect(res.status).toBe(200);
  return completeHandshake(psk, init.state, res.body as E2eHandshakeResponse);
}

describe('POST /api/e2e/handshake', () => {
  let psk: Uint8Array;
  beforeEach(() => {
    psk = generatePsk(random);
  });

  it('completes a handshake for a client holding the PSK', async () => {
    const { app } = makeApp({ psk });
    const session = await handshakeOver(app, psk);
    expect(session.sessionId.length).toBeGreaterThanOrEqual(16);
    expect(session.keys.c2s.length).toBe(32);
  });

  it('rejects an init from a party without the PSK with 401 e2e_auth_failed', async () => {
    const { app } = makeApp({ psk });
    const attacker = createHandshakeInit(generatePsk(random), random);
    const res = await request(app).post('/api/e2e/handshake').send(attacker.message);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('e2e_auth_failed');
  });

  it('answers 503 e2e_unconfigured when no PSK is set', async () => {
    const { app } = makeApp({});
    const init = createHandshakeInit(generatePsk(random), random);
    const res = await request(app).post('/api/e2e/handshake').send(init.message);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('e2e_unconfigured');
  });

  it('rejects a garbage body with 401 e2e_auth_failed (indistinguishable from forgery — no oracle)', async () => {
    const { app } = makeApp({ psk });
    const res = await request(app).post('/api/e2e/handshake').send({ nope: true });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('e2e_auth_failed');
  });
});

describe('POST /api/e2e (full tunnel)', () => {
  let psk: Uint8Array;
  beforeEach(() => {
    psk = generatePsk(random);
  });

  it('round-trips a tunnelled request: decrypts, dispatches, encrypts the response', async () => {
    const { app, dispatched } = makeApp({ psk });
    const session = await handshakeOver(app, psk);

    const inner: E2eInnerRequest = {
      method: 'post',
      path: '/api/chats?limit=5',
      headers: { authorization: 'Bearer inner-jwt', 'content-type': 'application/json' },
      bodyB64: textToB64(JSON.stringify({ hello: 'pc' })),
    };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: session.sessionId, env: sealJson(session.keys.c2s, inner, random) });

    expect(res.status).toBe(200);
    expect(res.body.sid).toBe(session.sessionId);

    // The dispatch saw the REAL request (method upcased, marker header stamped).
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].method).toBe('POST');
    expect(dispatched[0].path).toBe('/api/chats?limit=5');
    expect(dispatched[0].headers.authorization).toBe('Bearer inner-jwt');
    expect(dispatched[0].headers[E2E_TUNNEL_HEADER]).toBe('1');

    // Only the phone (s2c key) can read the response.
    const innerRes = openJson<E2eInnerResponse>(session.keys.s2c, res.body.env);
    expect(innerRes.status).toBe(200);
    expect(JSON.parse(b64ToText(innerRes.bodyB64!))).toEqual({
      echoedPath: '/api/chats?limit=5',
    });
  });

  it('surfaces the inner X-Renewed-Token on the outer response header', async () => {
    const dispatch: E2eDispatch = async () => ({
      status: 200,
      headers: { 'x-renewed-token': 'renewed-jwt' },
      bodyB64: undefined,
    });
    const { app } = makeApp({ psk, dispatch });
    const session = await handshakeOver(app, psk);
    const inner: E2eInnerRequest = { method: 'GET', path: '/api/me', headers: {} };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: session.sessionId, env: sealJson(session.keys.c2s, inner, random) });
    expect(res.status).toBe(200);
    expect(res.headers['x-renewed-token']).toBe('renewed-jwt');
  });

  it('answers 410 e2e_session_unknown for an unknown sid (client re-handshakes)', async () => {
    const { app } = makeApp({ psk });
    const session = await handshakeOver(app, psk);
    const inner: E2eInnerRequest = { method: 'GET', path: '/api/me', headers: {} };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: 'not-a-session', env: sealJson(session.keys.c2s, inner, random) });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('e2e_session_unknown');
  });

  it('answers 400 e2e_bad_request for an envelope sealed under the wrong key (forged by the relay)', async () => {
    const { app, dispatched } = makeApp({ psk });
    const session = await handshakeOver(app, psk);
    const attackerKey = new Uint8Array(crypto.randomBytes(32));
    const inner: E2eInnerRequest = { method: 'GET', path: '/api/user/secrets', headers: {} };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: session.sessionId, env: sealJson(attackerKey, inner, random) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('e2e_bad_request');
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a tunnelled request targeting the tunnel itself (no recursion)', async () => {
    const { app, dispatched } = makeApp({ psk });
    const session = await handshakeOver(app, psk);
    const inner: E2eInnerRequest = { method: 'POST', path: '/api/e2e', headers: {} };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: session.sessionId, env: sealJson(session.keys.c2s, inner, random) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('e2e_bad_request');
    expect(dispatched).toHaveLength(0);
  });

  it('answers 502 inside the envelope when the dispatch itself fails', async () => {
    const dispatch: E2eDispatch = async () => {
      throw new Error('api unreachable');
    };
    const { app } = makeApp({ psk, dispatch });
    const session = await handshakeOver(app, psk);
    const inner: E2eInnerRequest = { method: 'GET', path: '/api/me', headers: {} };
    const res = await request(app)
      .post('/api/e2e')
      .send({ sid: session.sessionId, env: sealJson(session.keys.c2s, inner, random) });
    expect(res.status).toBe(200);
    const innerRes = openJson<E2eInnerResponse>(session.keys.s2c, res.body.env);
    expect(innerRes.status).toBe(502);
  });
});

describe('sanitizeInnerRequest', () => {
  it('rejects scheme/protocol-relative paths (no SSRF through the tunnel)', () => {
    expect(
      sanitizeInnerRequest({ method: 'GET', path: 'https://evil.example/x', headers: {} })
    ).toBeNull();
    expect(
      sanitizeInnerRequest({ method: 'GET', path: '//evil.example/x', headers: {} })
    ).toBeNull();
  });

  it('drops non-forwardable headers and stamps the tunnel marker', () => {
    const out = sanitizeInnerRequest({
      method: 'get',
      path: '/api/me',
      headers: {
        authorization: 'Bearer x',
        cookie: 'session=steal-me',
        host: 'evil',
        [E2E_TUNNEL_HEADER]: 'spoofed',
      } as Record<string, string>,
    });
    expect(out).not.toBeNull();
    expect(out!.headers.authorization).toBe('Bearer x');
    expect(out!.headers.cookie).toBeUndefined();
    expect(out!.headers.host).toBeUndefined();
    expect(out!.headers[E2E_TUNNEL_HEADER]).toBe('1');
  });
});
