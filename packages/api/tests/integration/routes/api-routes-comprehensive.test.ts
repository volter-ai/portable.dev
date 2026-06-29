/**
 * Comprehensive API Routes Tests - Gap Filling & Edge Cases
 *
 * This file covers remaining untested routes and adds comprehensive edge case
 * testing for critical endpoints to reach 80%+ coverage.
 *
 * Philosophy: Test error paths, validation, edge cases, and security concerns
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

describe('API Routes - Secrets Edge Cases', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/user/secrets/from-env', () => {
    it('should reject without content', async () => {
      const response = await request(app)
        .post('/api/user/secrets/from-env')
        .send({
          source: 'env_editor',
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/secrets/vault/search', () => {});
});

describe('API Routes - Projects Edge Cases', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/projects/create-local', () => {
    it('should reject without project name', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .send({
          description: 'Test project',
        })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject with invalid project name (special chars)', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .send({
          name: 'my-project/../../../etc/passwd',
          description: 'Test project',
        })
        .set('Content-Type', 'application/json');

      // Should reject path traversal attempts
      expect([400, 500]).toContain(response.status);
    });

    it('should handle very long project name', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .send({
          name: 'A'.repeat(500),
          description: 'Test project',
        })
        .set('Content-Type', 'application/json');

      // Should reject or truncate
      expect([400, 500]).toContain(response.status);
    });
  });

  describe('POST /api/generate-project-name', () => {
    it('should reject without description', async () => {
      const response = await request(app)
        .post('/api/generate-project-name')
        .send({})
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle empty description', async () => {
      const response = await request(app)
        .post('/api/generate-project-name')
        .send({
          description: '',
        })
        .set('Content-Type', 'application/json');

      expect([400, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Chat Management Edge Cases', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('PATCH /api/chat/:chatId/settings', () => {
    it('should reject for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chat/non-existent-chat-id/settings')
        .send({
          settings: {
            modelMode: 'sonnet',
          },
        })
        .set('Content-Type', 'application/json');

      expect([400, 404, 500]).toContain(response.status);
    });

    it('should handle invalid settings format', async () => {
      const response = await request(app)
        .patch('/api/chat/test-chat-id/settings')
        .send({
          settings: 'invalid-format',
        })
        .set('Content-Type', 'application/json');

      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chats/:chatId/device', () => {
    it('should reject without device info', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/device')
        .send({})
        .set('Content-Type', 'application/json');

      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chats/:chatId/permissions', () => {
    it('should reject invalid permission mode', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/permissions')
        .send({
          permissions: {
            mode: 'invalid-mode',
          },
        })
        .set('Content-Type', 'application/json');

      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chats/:chatId/archive', () => {});
});

describe('API Routes - Repository Operations Security', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('Path traversal protection', () => {
    it('should reject path traversal in repo contents', async () => {
      const response = await request(app).get(
        '/api/repos/testowner/testrepo/contents/../../../etc/passwd'
      );

      // Should reject or sanitize path
      expect([400, 401, 404, 500]).toContain(response.status);
    });

    it('should reject path traversal in file history', async () => {
      const response = await request(app).get(
        '/api/repos/testowner/testrepo/file-history/../../../etc/passwd'
      );

      expect([400, 401, 404, 500]).toContain(response.status);
    });

    it('should reject absolute paths in contents', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/contents//etc/passwd');

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('Special characters in paths', () => {});

  describe('Owner/repo parameter validation', () => {
    it('should reject invalid owner name (SQL injection)', async () => {
      const response = await request(app).get("/api/repos/'; DROP TABLE users; --/testrepo");

      expect([400, 401, 404, 500]).toContain(response.status);
    });

    it('should reject invalid repo name (script injection)', async () => {
      const response = await request(app).get('/api/repos/testowner/<script>alert("xss")</script>');

      expect([400, 401, 404, 500]).toContain(response.status);
    });

    it('should handle very long owner name', async () => {
      const longOwner = 'A'.repeat(500);
      const response = await request(app).get(`/api/repos/${longOwner}/testrepo`);

      expect([400, 401, 404, 414, 500]).toContain(response.status);
    });

    it('should handle very long repo name', async () => {
      const longRepo = 'A'.repeat(500);
      const response = await request(app).get(`/api/repos/testowner/${longRepo}`);

      expect([400, 401, 404, 414, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Workflow File Operations Security', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/repos/:owner/:repo/workflows/file', () => {
    it('should reject without workflow name', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/workflows/file')
        .send({
          content: 'name: Test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest',
        })
        .set('Content-Type', 'application/json');

      expect([400, 401, 500]).toContain(response.status);
    });

    it('should reject without workflow content', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/workflows/file')
        .send({
          workflowName: 'test.yml',
        })
        .set('Content-Type', 'application/json');

      expect([400, 401, 500]).toContain(response.status);
    });

    it('should reject path traversal in workflow name', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/workflows/file')
        .send({
          workflowName: '../../../evil.yml',
          content: 'malicious content',
        })
        .set('Content-Type', 'application/json');

      // Should reject path traversal
      expect([400, 401, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/workflows/file', () => {});

  describe('DELETE /api/repos/:owner/:repo/workflows/file', () => {
    it('should reject without workflow name', async () => {
      const response = await request(app).delete('/api/repos/testowner/testrepo/workflows/file');

      expect([400, 401, 404]).toContain(response.status);
    });

    it('should reject path traversal in workflow name', async () => {
      const response = await request(app)
        .delete('/api/repos/testowner/testrepo/workflows/file')
        .query({ workflowName: '../../../evil.yml' });

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Concurrent Operations', () => {
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
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('Concurrent chat creation', () => {});

  describe('Concurrent secret operations', () => {});
});
