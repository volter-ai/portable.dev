/**
 * /api/ai-credentials/* integration tests (portable.dev#18).
 *
 * Full request/response cycle over supertest with a REAL ClaudeOAuthService +
 * REAL LocalAiCredentialsService on a temp LocalSecretStore. Only the Claude
 * token endpoint is faked (injected fetchImpl).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

setupAllExternalMocks(mock);
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import * as path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';
import { Application } from 'express';

import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import { ClaudeOAuthService } from '../../../src/services/ClaudeOAuthService';
import { LocalAiCredentialsService } from '../../../src/services/LocalAiCredentialsService';

import type { DbAdapter } from '../../../src/db/DbAdapter.js';

describe('API Routes - /api/ai-credentials', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;
  let tmpDir: string;
  let credentials: LocalAiCredentialsService;
  let tokenEndpointCalls: Array<{ url: string; body: string }>;
  let tokenEndpointStatus: number;

  const savedEnvApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    delete process.env.ANTHROPIC_API_KEY;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-creds-routes-'));
    credentials = new LocalAiCredentialsService(new LocalSecretStore({ dataDir: tmpDir }));

    tokenEndpointCalls = [];
    tokenEndpointStatus = 200;
    const claudeOAuthService = new ClaudeOAuthService(credentials, {
      fetchImpl: async (url, init) => {
        tokenEndpointCalls.push({ url, body: String(init?.body) });
        return new Response(
          JSON.stringify({
            token_type: 'Bearer',
            access_token: 'sk-ant-oat01-routes-access',
            expires_in: 28800,
            refresh_token: 'sk-ant-ort01-routes-refresh',
            scope: 'user:inference user:profile',
            account: { uuid: 'acc-1', email_address: 'routes@example.com' },
          }),
          { status: tokenEndpointStatus }
        );
      },
    });

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
      requireAuthHeaderForSession: true,
      claudeOAuthService,
    });
  });

  afterEach(async () => {
    if (savedEnvApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedEnvApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  const authed = () => ({ Authorization: `Bearer ${authToken}` });

  describe('GET /api/ai-credentials/status', () => {
    it('requires auth', async () => {
      const response = await request(app).get('/api/ai-credentials/status');
      expect(response.status).toBe(401);
    });

    it('reports none when nothing is configured', async () => {
      const response = await request(app).get('/api/ai-credentials/status').set(authed());

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        mode: 'none',
        source: 'none',
        hasRefreshToken: false,
      });
    });
  });

  describe('login flow (start → complete → status)', () => {
    it('runs the full phone-driven login and never leaks token values', async () => {
      const start = await request(app).post('/api/ai-credentials/login/start').set(authed());
      expect(start.status).toBe(200);
      const authorizeUrl: string = start.body.authorizeUrl;
      expect(authorizeUrl).toContain('https://claude.ai/oauth/authorize?');
      const state = new URL(authorizeUrl).searchParams.get('state')!;

      const complete = await request(app)
        .post('/api/ai-credentials/login/complete')
        .set(authed())
        .send({ code: `pasted-code#${state}` });
      expect(complete.status).toBe(200);
      expect(complete.body).toEqual({ ok: true, email: 'routes@example.com' });
      expect(tokenEndpointCalls.length).toBe(1);

      const status = await request(app).get('/api/ai-credentials/status').set(authed());
      expect(status.status).toBe(200);
      expect(status.body.mode).toBe('claude-oauth');
      expect(status.body.source).toBe('oauth-record');
      expect(status.body.hasRefreshToken).toBe(true);
      expect(status.body.email).toBe('routes@example.com');
      expect(JSON.stringify(status.body)).not.toContain('sk-ant-');

      // The record + the legacy launcher mirror both landed in the store.
      expect(credentials.getOAuthRecord()?.accessToken).toBe('sk-ant-oat01-routes-access');
      expect(credentials.getClaudeOAuthToken()).toBe('sk-ant-oat01-routes-access');
    });

    it('rejects a missing code with invalid_code', async () => {
      const response = await request(app)
        .post('/api/ai-credentials/login/complete')
        .set(authed())
        .send({});
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_code');
    });

    it('rejects a complete with no pending login', async () => {
      const response = await request(app)
        .post('/api/ai-credentials/login/complete')
        .set(authed())
        .send({ code: 'orphan-code' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('no_pending_login');
    });

    it('maps a failed exchange to 502 exchange_failed', async () => {
      await request(app).post('/api/ai-credentials/login/start').set(authed());
      tokenEndpointStatus = 400;
      const response = await request(app)
        .post('/api/ai-credentials/login/complete')
        .set(authed())
        .send({ code: 'some-code' });
      expect(response.status).toBe(502);
      expect(response.body.code).toBe('exchange_failed');
    });
  });

  describe('POST /api/ai-credentials/token (paste fallback)', () => {
    it('stores an sk-ant-oat… token as claude-oauth', async () => {
      const response = await request(app)
        .post('/api/ai-credentials/token')
        .set(authed())
        .send({ token: 'sk-ant-oat01-pasted' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, mode: 'claude-oauth' });
      expect(credentials.getClaudeOAuthToken()).toBe('sk-ant-oat01-pasted');
    });

    it('stores an sk-ant-api… key as api-key', async () => {
      const response = await request(app)
        .post('/api/ai-credentials/token')
        .set(authed())
        .send({ token: 'sk-ant-api03-pasted' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, mode: 'api-key' });
      expect(credentials.getStoredApiKey()).toBe('sk-ant-api03-pasted');
    });

    it('rejects a non-Anthropic value with invalid_token', async () => {
      const response = await request(app)
        .post('/api/ai-credentials/token')
        .set(authed())
        .send({ token: 'ghp_github_token' });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_token');
    });
  });

  describe('DELETE /api/ai-credentials (sign out)', () => {
    it('clears stored credentials and reports cleared', async () => {
      await request(app)
        .post('/api/ai-credentials/token')
        .set(authed())
        .send({ token: 'sk-ant-oat01-pasted' });

      const response = await request(app).delete('/api/ai-credentials').set(authed());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true, cleared: true });
      expect(credentials.getOAuthRecord()).toBeNull();
      expect(credentials.getClaudeOAuthToken()).toBeNull();

      const again = await request(app).delete('/api/ai-credentials').set(authed());
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ok: true, cleared: false });
    });
  });
});
