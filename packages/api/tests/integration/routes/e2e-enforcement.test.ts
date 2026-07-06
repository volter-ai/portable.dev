/**
 * E2E plaintext-rejection enforcement (portable.dev#13, hard cutover).
 *
 * When E2E is configured, a plaintext `/api/*` request to a protected route is
 * rejected 426 — even with a valid Bearer (closing the "malicious relay replays
 * the visible token" hole) — while the decrypted-tunnel loopback replay (which
 * carries the per-boot inner secret) and the exempt surfaces pass through.
 */
import { describe, expect, it } from 'bun:test';
import express, { type Application } from 'express';
import request from 'supertest';

import {
  createE2eEnforcementMiddleware,
  E2E_INNER_SECRET_HEADER,
} from '../../../src/middleware/e2eEnforcement.js';

const INNER_SECRET = 'boot-secret-abc';

function makeApp(configured: boolean): Application {
  const app = express();
  app.use('/api', createE2eEnforcementMiddleware({ isConfigured: () => configured }, INNER_SECRET));
  // A stand-in for whatever protected route would run next.
  app.use('/api', (_req, res) => res.status(200).json({ reached: true }));
  return app;
}

describe('E2E enforcement (configured)', () => {
  it('rejects a plaintext protected request with 426 e2e_required (even with a Bearer)', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set('Authorization', 'Bearer valid-looking-jwt');
    expect(res.status).toBe(426);
    expect(res.body.code).toBe('e2e_required');
  });

  it('allows the trusted loopback replay carrying the inner secret', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set(E2E_INNER_SECRET_HEADER, INNER_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it('rejects a forged inner-secret header (relay cannot guess it)', async () => {
    const res = await request(makeApp(true))
      .get('/api/chats')
      .set(E2E_INNER_SECRET_HEADER, 'wrong-secret');
    expect(res.status).toBe(426);
  });

  it('exempts health, e2e, internal, and native-loader media/raw routes', async () => {
    const app = makeApp(true);
    for (const path of [
      '/api/health',
      '/api/e2e/handshake',
      '/api/internal/sidecar/poll',
      '/api/video/octocat/repo/clip.mp4',
      '/api/uploads/file.png',
      '/api/repos/octocat/repo/raw/src/index.ts',
      '/api/upload',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
  });
});

describe('E2E enforcement (unconfigured — bare dev / tests)', () => {
  it('is a no-op: plaintext requests pass through', async () => {
    const res = await request(makeApp(false)).get('/api/chats');
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });
});
