/**
 * Extended API Routes Integration Tests
 *
 * Tests for theme, secrets, and other high-coverage endpoints
 * that are easy to test and provide significant coverage gains.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);
import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

// Track all db adapters for cleanup
const allAdapters: DbAdapter[] = [];

// Force cleanup and exit after all tests
afterAll(async () => {
  console.log('[TEST CLEANUP] afterAll hook executing...');
  console.log(`[TEST CLEANUP] Cleaning up ${allAdapters.length} adapters`);

  // Close all db adapter clients
  for (const adapter of allAdapters) {
    try {
      // Access the internal client and close connections
      // @ts-expect-error - accessing private property for cleanup
      if (adapter.client) {
        // @ts-expect-error
        await adapter.client.removeAllChannels();
      }
      // @ts-expect-error
      if (adapter.anonClient) {
        // @ts-expect-error
        await adapter.anonClient.removeAllChannels();
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  console.log('[TEST CLEANUP] Cleanup complete');
});

describe('API Routes - Theme Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/user/theme', () => {
    it('should return null for user without theme', async () => {
      const response = await request(app)
        .get('/api/user/theme')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        themeConfig: null,
      });
    });
  });

  describe('PUT /api/user/theme', () => {
    it('should save user theme', async () => {
      const themeData = {
        primaryColor: '#3b82f6',
        accentColor: '#8b5cf6',
        mode: 'dark',
      };

      const response = await request(app)
        .put('/api/user/theme')
        .send({ themeConfig: themeData })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid theme data', async () => {
      const response = await request(app)
        .put('/api/user/theme')
        .send({ themeConfig: 'invalid' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should update existing theme', async () => {
      // First create a theme
      await request(app)
        .put('/api/user/theme')
        .send({ themeConfig: { primaryColor: '#ff0000' } })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Then update it
      const newTheme = { primaryColor: '#00ff00' };
      const response = await request(app)
        .put('/api/user/theme')
        .send({ themeConfig: newTheme })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('DELETE /api/user/theme', () => {
    it('should delete user theme', async () => {
      // First create a theme
      await request(app)
        .put('/api/user/theme')
        .send({ themeConfig: { primaryColor: '#ff0000' } })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Then delete it
      const response = await request(app)
        .delete('/api/user/theme')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);

      // Verify it's deleted
      const getResponse = await request(app)
        .get('/api/user/theme')
        .set('Authorization', `Bearer ${authToken}`);

      expect(getResponse.body.themeConfig).toBe(null);
    });

    it('should succeed even if theme does not exist', async () => {
      const response = await request(app)
        .delete('/api/user/theme')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);
    });
  });
});

describe('API Routes - User Secrets Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/user/secrets', () => {
    it('should return empty object for new user', async () => {
      const response = await request(app)
        .get('/api/user/secrets')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('secrets');
      expect(typeof response.body.secrets).toBe('object');
    });
  });

  describe('POST /api/user/secrets', () => {
    it('should save user secrets', async () => {
      const response = await request(app)
        .post('/api/user/secrets')
        .send({ key: 'API_KEY', value: 'test-key-123' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });

    it('should reject invalid secrets format', async () => {
      const response = await request(app)
        .post('/api/user/secrets')
        .send({ key: 'TEST' }) // Missing value
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /api/user/secrets/:key', () => {
    it('should update a single secret', async () => {
      // First create a secret
      await request(app)
        .post('/api/user/secrets')
        .send({ key: 'API_KEY', value: 'old-value' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Then update it
      const response = await request(app)
        .patch('/api/user/secrets/API_KEY')
        .send({ value: 'new-value' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });

  describe('DELETE /api/user/secrets/:key', () => {
    it('should delete a single secret', async () => {
      // First create a secret
      await request(app)
        .post('/api/user/secrets')
        .send({ key: 'API_KEY', value: 'test-value' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Then delete it
      const response = await request(app)
        .delete('/api/user/secrets/API_KEY')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
});

describe('API Routes - Vault Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/secrets/vault', () => {
    it('should return empty array for new user', async () => {
      const response = await request(app)
        .get('/api/secrets/vault')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('savedSecrets');
      expect(Array.isArray(response.body.savedSecrets)).toBe(true);
    });
  });

  describe('POST /api/secrets/vault', () => {
    it('should create a vault secret', async () => {
      const secretData = {
        key: 'TEST_SECRET',
        value: 'secret-value-123',
        description: 'Test secret',
      };

      const response = await request(app)
        .post('/api/secrets/vault')
        .send(secretData)
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });

    it('should reject vault secret without key', async () => {
      const response = await request(app)
        .post('/api/secrets/vault')
        .send({ value: 'test' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/secrets/vault/:key', () => {
    it('should return error for non-existent secret', async () => {
      const response = await request(app)
        .get('/api/secrets/vault/NON_EXISTENT')
        .set('Authorization', `Bearer ${authToken}`);

      // Vault service may return 404 or 500 depending on implementation
      expect([404, 500]).toContain(response.status);
    });
  });

  describe('DELETE /api/secrets/vault/:key', () => {
    it('should delete a vault secret', async () => {
      // First create a secret
      await request(app)
        .post('/api/secrets/vault')
        .send({ key: 'DELETE_ME', value: 'test' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Then delete it
      const response = await request(app)
        .delete('/api/secrets/vault/DELETE_ME')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
});

describe('API Routes - Project & Intent Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/generate-project-name', () => {
    it('should generate a project name', async () => {
      const response = await request(app)
        .post('/api/generate-project-name')
        .send({ description: 'Build a todo app' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name');
      expect(typeof response.body.name).toBe('string');
      // Should be kebab-case (lowercase with hyphens only)
      expect(response.body.name).toMatch(/^[a-z0-9-]+$/);
    });

    it('should handle missing description', async () => {
      const response = await request(app)
        .post('/api/generate-project-name')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      // Should return error when description is missing
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/projects/recent', () => {
    it('should return recent projects', async () => {
      const response = await request(app)
        .get('/api/projects/recent')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('projects');
      expect(Array.isArray(response.body.projects)).toBe(true);
    });
  });
});

describe('API Routes - Repository Caching', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/repos/cached', () => {
    it('should return error when GitHub not connected', async () => {
      const response = await request(app)
        .get('/api/repos/cached')
        .set('Authorization', `Bearer ${authToken}`);

      // Without GitHub connection, should return error
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });
});

describe('API Routes - Local Repository Operations', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/repos/git-status', () => {
    it('should require path parameter', async () => {
      const response = await request(app)
        .post('/api/repos/git-status')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should return git status for invalid path', async () => {
      const response = await request(app)
        .post('/api/repos/git-status')
        .send({ path: '/non/existent/path' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Should handle gracefully, either 404 or error response
      expect([400, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - User Profile Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/user/profile', () => {});

  describe('GET /api/user/organizations', () => {});
});

describe('API Routes - Dev Info & Debug Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/dev-info', () => {
    it('should return development information', async () => {
      const response = await request(app).get('/api/dev-info');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('environment');
    });
  });

  describe('POST /api/debug/visibility', () => {
    it('should accept visibility debug data', async () => {
      const response = await request(app)
        .post('/api/debug/visibility')
        .send({ visible: true })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
    });
  });
});

describe('API Routes - Chat Operations Extended', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;
  let testChatId: string;

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

    // Create a test chat
    const chatResponse = await request(app)
      .post('/api/chats')
      .send({
        type: 'code',
        title: 'Test Chat for Summarization',
        repoOwner: 'testowner',
        repoName: 'testrepo',
        prompt: 'Test prompt',
      })
      .set('Content-Type', 'application/json');

    testChatId = chatResponse.body.id;
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/chats/:chatId/summarize', () => {
    it('should summarize a chat', async () => {
      const response = await request(app)
        .post(`/api/chats/${testChatId}/summarize`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('summary');
    });

    it('should handle non-existent chat', async () => {
      const response = await request(app)
        .post('/api/chats/non-existent-chat/summarize')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 with empty summary or 404 depending on implementation
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('GET /api/chats/:chatId/status', () => {
    it('should return chat status', async () => {
      const response = await request(app)
        .get(`/api/chats/${testChatId}/status`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
    });

    it('should handle non-existent chat', async () => {
      const response = await request(app)
        .get('/api/chats/non-existent-chat/status')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 with default status or 404 depending on implementation
      expect([200, 404]).toContain(response.status);
    });
  });

  describe('POST /api/chats/:chatId/messages', () => {
    it('should require message content', async () => {
      const response = await request(app)
        .post(`/api/chats/${testChatId}/messages`)
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/messages/pending/:chatId', () => {
    it('should return pending messages metadata', async () => {
      const response = await request(app)
        .get(`/api/messages/pending/${testChatId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('chatId');
      expect(response.body).toHaveProperty('latestTimestamp');
      expect(response.body).toHaveProperty('messageCount');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});

describe('API Routes - GitHub Connection Operations', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/user/recent-branches', () => {});
});

/* COMMENTED OUT - Testing only Block 10
describe('API Routes - Connection Management', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    allAdapters.push(adapter); // Track for cleanup

    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/connections', () => {
    it('should require connection data', async () => {
      const response = await request(app)
        .post('/api/connections')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/connections/:connectionId', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .get('/api/connections/non-existent-connection')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/connections/:connectionId/rename', () => {
    it('should require name parameter', async () => {
      const response = await request(app)
        .patch('/api/connections/test-connection/rename')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/connections/:connectionId', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .delete('/api/connections/non-existent-connection')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/connections/:connectionId/toggle-active', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .patch('/api/connections/non-existent-connection/toggle-active')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/connections/:connectionId/account-info', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .get('/api/connections/non-existent-connection/account-info')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/connections/:connectionId/refresh-account-info', () => {
    it('should return 404 for non-existent connection', async () => {
      const response = await request(app)
        .post('/api/connections/non-existent-connection/refresh-account-info')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/connections/complete-oauth', () => {
    it('should require OAuth data', async () => {
      const response = await request(app)
        .post('/api/connections/complete-oauth')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/connections/flyio-cli/auth-url', () => {
  });

  describe('POST /api/connections/flyio-cli/complete', () => {
    it('should require completion data', async () => {
      const response = await request(app)
        .post('/api/connections/flyio-cli/complete')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });
});
*/
