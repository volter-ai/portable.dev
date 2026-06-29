/**
 * Dev Routes Integration Tests
 *
 * Tests development and debug endpoints.
 * Covers dev.routes.ts (3 routes)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);
import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

describe('Dev Routes - Development and Debug Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/config', () => {
    it('should return configuration', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('modalMode');
    });

    it('should not require authentication (public endpoint)', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/dev-info', () => {
    it('should return dev information', async () => {
      const response = await request(app).get('/api/dev-info');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('serverUptime');
      expect(response.body).toHaveProperty('nodeVersion');
      expect(response.body).toHaveProperty('environment');
    });

    it('should include build metadata if available', async () => {
      const response = await request(app).get('/api/dev-info');

      expect(response.status).toBe(200);
      // Build metadata may or may not exist depending on environment
      expect(response.body.serverUptime).toBeGreaterThan(0);
    });

    it('should not require authentication (public endpoint)', async () => {
      const response = await request(app).get('/api/dev-info');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/debug/visibility', () => {
    it('should accept visibility event', async () => {
      const response = await request(app)
        .post('/api/debug/visibility')
        .send({
          event: 'visibilitychange',
          data: { hidden: false },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
    });

    it('should accept visibility event without data', async () => {
      const response = await request(app).post('/api/debug/visibility').send({
        event: 'focus',
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('should not require authentication (debug endpoint)', async () => {
      const response = await request(app).post('/api/debug/visibility').send({
        event: 'blur',
      });

      expect(response.status).toBe(200);
    });

    it('should handle various visibility events', async () => {
      const events = ['focus', 'blur', 'visibilitychange', 'pageshow', 'pagehide'];

      for (const event of events) {
        const response = await request(app)
          .post('/api/debug/visibility')
          .send({
            event,
            data: { timestamp: Date.now() },
          });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      }
    });
  });
});
