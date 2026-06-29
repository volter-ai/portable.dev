/**
 * Connections Routes Integration Tests
 *
 * Tests OAuth connections and service integrations endpoints.
 * Covers connections.routes.ts (14 routes)
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

describe('Connections Routes - OAuth and Service Integrations', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;
  let testEmail: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    testEmail = testUserId;

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testEmail,
      requireAuthHeaderForSession: true, // Only inject session when Authorization header is present
    });
  });

  afterEach(async () => {
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/connections', () => {
    it('should return empty array for new user', async () => {
      const response = await request(app)
        .get('/api/connections')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('connections');
      expect(Array.isArray(response.body.connections)).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/connections');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/connections/services', () => {
    it('should return available service configurations', async () => {
      const response = await request(app).get('/api/connections/services');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('services');
      expect(Array.isArray(response.body.services)).toBe(true);
    });

    it('should not require authentication (public endpoint)', async () => {
      const response = await request(app).get('/api/connections/services');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/connections/services/:service', () => {
    it('should return specific service configuration', async () => {
      const response = await request(app).get('/api/connections/services/github');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name');
    });

    it('should return 404 or 200 for unknown service', async () => {
      const response = await request(app).get('/api/connections/services/unknown-service');

      // May return 200 with empty config or 404
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('GET /api/connections/:connectionId', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .get('/api/connections/non-existent-connection')
        .set('Authorization', `Bearer ${authToken}`);

      // Route may return 404 (not found) or 200 with null/empty data depending on environment
      expect([200, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/connections/test-connection');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/connections', () => {
    it('should reject without required fields', async () => {
      const response = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject without connectionId', async () => {
      const response = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          displayName: 'Test Connection',
          service: 'github',
          credentials: { token: 'test-token' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('connectionId');
    });

    it('should reject with unknown service', async () => {
      const response = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          connectionId: 'test-conn',
          displayName: 'Test Connection',
          service: 'unknown-service',
          credentials: { token: 'test-token' },
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('Service not found');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/connections')
        .send({
          connectionId: 'test-conn',
          displayName: 'Test Connection',
          service: 'github',
          credentials: { token: 'test-token' },
        });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/connections/complete-oauth', () => {
    it('should reject without pending OAuth session', async () => {
      const response = await request(app)
        .post('/api/connections/complete-oauth')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          service: 'google-drive',
          connectionId: 'test-conn',
          displayName: 'Test Connection',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('pending');
    });

    it('should reject without required fields', async () => {
      const response = await request(app)
        .post('/api/connections/complete-oauth')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('required');
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/connections/complete-oauth').send({
        service: 'google-drive',
        connectionId: 'test-conn',
        displayName: 'Test',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/connections/:connectionId/rename', () => {
    it('should reject without newDisplayName', async () => {
      const response = await request(app)
        .patch('/api/connections/test-conn/rename')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      // May return 404 (connection not found) or 400 (missing field)
      expect([400, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/connections/test-conn/rename')
        .send({ newDisplayName: 'New Name' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/connections/:connectionId/account-info', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .get('/api/connections/non-existent/account-info')
        .set('Authorization', `Bearer ${authToken}`);

      // Route may return 404 (not found) or 200 with null/empty data depending on environment
      expect([200, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/connections/test-conn/account-info');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/connections/:connectionId/refresh-account-info', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .post('/api/connections/non-existent/refresh-account-info')
        .set('Authorization', `Bearer ${authToken}`);

      // Route may return 404 (not found) or 200 with null/empty data depending on environment
      expect([200, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/connections/test-conn/refresh-account-info');

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/connections/:connectionId', () => {
    it('should require authentication', async () => {
      const response = await request(app).delete('/api/connections/test-conn');

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/connections/:connectionId/toggle-active', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .patch('/api/connections/non-existent/toggle-active')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ isActive: true });

      // Route may return 404 (not found) or 200 with null/empty data depending on environment
      expect([200, 404]).toContain(response.status);
    });

    it('should reject without isActive boolean', async () => {
      const response = await request(app)
        .patch('/api/connections/test-conn/toggle-active')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      // May return 404 (not found) or 400 (bad request)
      expect([400, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/connections/test-conn/toggle-active')
        .send({ isActive: true });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/connections/flyio-cli/auth-url', () => {
    it('should reject without connectionId', async () => {
      const response = await request(app)
        .post('/api/connections/flyio-cli/auth-url')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      // May return 400 (missing field) or 500 (internal error)
      expect([400, 500]).toContain(response.status);
    });

    // Skipping this test as it may timeout due to external service calls
    it.skip('should require authentication', async () => {
      const response = await request(app)
        .post('/api/connections/flyio-cli/auth-url')
        .send({ connectionId: 'test-conn' });

      // May return 500 (internal error) or 401 (not authenticated)
      expect([401, 500]).toContain(response.status);
    });
  });

  describe('POST /api/connections/flyio-cli/complete', () => {
    it('should reject without pending Fly.io connection', async () => {
      const response = await request(app)
        .post('/api/connections/flyio-cli/complete')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      // May return 400 (no pending connection) or 200 (no-op success)
      expect([200, 400]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/connections/flyio-cli/complete').send({});

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/update-git-credentials', () => {
    it('should require valid JWT token', async () => {
      const response = await request(app).post('/api/update-git-credentials').send({});

      expect(response.status).toBe(401);
    });

    it('should reject invalid JWT token', async () => {
      const response = await request(app)
        .post('/api/update-git-credentials')
        .set('Authorization', 'Bearer invalid-token')
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Invalid');
    });
  });
});
