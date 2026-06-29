/**
 * Tunnel Routes Integration Tests
 *
 * Tests internal tunnel management endpoints using supertest.
 * Covers Cloudflare tunnel creation, destruction, and status.
 *
 * Philosophy: Test the full request/response cycle with mock TunnelService
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

describe('Tunnel Routes - Tunnel Creation', () => {
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
    // Cleanup: delete test user data from REAL database
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /internal/tunnel/create', () => {
    it('should create tunnel with valid userId and port', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('url');
      expect(response.body).toHaveProperty('port', 3000);
      expect(response.body).toHaveProperty('createdAt');
      expect(typeof response.body.url).toBe('string');
      expect(response.body.url.startsWith('https://')).toBe(true);
    });

    it('should reject request without userId', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('userId');
    });

    it('should reject request without port', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('port');
    });

    it('should reject invalid port (too low)', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: -1,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid port');
    });

    it('should reject invalid port (too high)', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 70000,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid port');
    });

    it('should reject non-numeric port', async () => {
      const response = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 'not-a-number',
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle multiple tunnels for same user', async () => {
      // Create first tunnel
      const response1 = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(response1.status).toBe(200);
      expect(response1.body).toHaveProperty('url');

      // Create second tunnel (different port)
      const response2 = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 4000,
        })
        .set('Content-Type', 'application/json');

      expect(response2.status).toBe(200);
      expect(response2.body).toHaveProperty('url');
      expect(response2.body.port).toBe(4000);

      // URLs should be different
      expect(response1.body.url).not.toBe(response2.body.url);
    });
  });
});

describe('Tunnel Routes - Tunnel Destruction', () => {
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
    // Cleanup: delete test user data from REAL database
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /internal/tunnel/destroy', () => {
    it('should destroy existing tunnel', async () => {
      // First create a tunnel
      const createResponse = await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(createResponse.status).toBe(200);

      // Then destroy it
      const destroyResponse = await request(app)
        .post('/internal/tunnel/destroy')
        .send({
          userId: testUserId,
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(destroyResponse.status).toBe(200);
      expect(destroyResponse.body).toHaveProperty('success', true);
    });

    it('should handle destroy for non-existent tunnel gracefully', async () => {
      const response = await request(app)
        .post('/internal/tunnel/destroy')
        .send({
          userId: testUserId,
          port: 9999,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });

    it('should reject destroy without userId', async () => {
      const response = await request(app)
        .post('/internal/tunnel/destroy')
        .send({
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('userId');
    });

    it('should reject destroy without port', async () => {
      const response = await request(app)
        .post('/internal/tunnel/destroy')
        .send({
          userId: testUserId,
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('port');
    });
  });
});

describe('Tunnel Routes - Tunnel Status', () => {
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
    // Cleanup: delete test user data from REAL database
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /internal/tunnel/status', () => {
    it('should return empty array for user with no tunnels', async () => {
      const response = await request(app)
        .get('/internal/tunnel/status')
        .query({ userId: testUserId });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('tunnels');
      expect(Array.isArray(response.body.tunnels)).toBe(true);
      expect(response.body.tunnels.length).toBe(0);
    });

    it('should return tunnels for user with active tunnels', async () => {
      // Create a tunnel first
      await request(app)
        .post('/internal/tunnel/create')
        .send({
          userId: testUserId,
          port: 3000,
        })
        .set('Content-Type', 'application/json');

      // Get status
      const response = await request(app)
        .get('/internal/tunnel/status')
        .query({ userId: testUserId });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('tunnels');
      expect(Array.isArray(response.body.tunnels)).toBe(true);
      expect(response.body.tunnels.length).toBeGreaterThan(0);

      // Verify tunnel structure
      const tunnel = response.body.tunnels[0];
      expect(tunnel).toHaveProperty('id');
      expect(tunnel).toHaveProperty('url');
      expect(tunnel).toHaveProperty('port', 3000);
      expect(tunnel).toHaveProperty('createdAt');
    });

    it('should return multiple tunnels for user', async () => {
      // Create multiple tunnels
      await request(app)
        .post('/internal/tunnel/create')
        .send({ userId: testUserId, port: 3000 })
        .set('Content-Type', 'application/json');

      await request(app)
        .post('/internal/tunnel/create')
        .send({ userId: testUserId, port: 4000 })
        .set('Content-Type', 'application/json');

      // Get status
      const response = await request(app)
        .get('/internal/tunnel/status')
        .query({ userId: testUserId });

      expect(response.status).toBe(200);
      expect(response.body.tunnels.length).toBe(2);

      // Verify ports
      const ports = response.body.tunnels.map((t: any) => t.port);
      expect(ports).toContain(3000);
      expect(ports).toContain(4000);
    });

    it('should reject status request without userId', async () => {
      const response = await request(app).get('/internal/tunnel/status');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('userId');
    });

    it('should return empty tunnels for non-existent user', async () => {
      const response = await request(app)
        .get('/internal/tunnel/status')
        .query({ userId: 'non-existent-user@example.com' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('tunnels');
      expect(response.body.tunnels).toEqual([]);
    });
  });
});

describe('Tunnel Routes - End-to-End Workflow', () => {
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
    // Cleanup: delete test user data from REAL database
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  it('should handle complete tunnel lifecycle', async () => {
    // 1. Check initial status (no tunnels)
    const statusBefore = await request(app)
      .get('/internal/tunnel/status')
      .query({ userId: testUserId });
    expect(statusBefore.body.tunnels.length).toBe(0);

    // 2. Create tunnel
    const createResponse = await request(app)
      .post('/internal/tunnel/create')
      .send({ userId: testUserId, port: 3000 })
      .set('Content-Type', 'application/json');
    expect(createResponse.status).toBe(200);
    const tunnelUrl = createResponse.body.url;

    // 3. Verify tunnel exists in status
    const statusDuring = await request(app)
      .get('/internal/tunnel/status')
      .query({ userId: testUserId });
    expect(statusDuring.body.tunnels.length).toBe(1);
    expect(statusDuring.body.tunnels[0].url).toBe(tunnelUrl);

    // 4. Destroy tunnel
    const destroyResponse = await request(app)
      .post('/internal/tunnel/destroy')
      .send({ userId: testUserId, port: 3000 })
      .set('Content-Type', 'application/json');
    expect(destroyResponse.status).toBe(200);
    expect(destroyResponse.body.success).toBe(true);

    // 5. Verify tunnel no longer exists
    const statusAfter = await request(app)
      .get('/internal/tunnel/status')
      .query({ userId: testUserId });
    expect(statusAfter.body.tunnels.length).toBe(0);
  });
});
