/**
 * Repository Routes Integration Tests
 *
 * Tests for GitHub repository proxy endpoints - the largest untested category
 * (~40 routes covering file operations, branches, issues, PRs, workflows, etc.)
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

// Most repo endpoints require GitHub connection, so these tests verify error handling
describe('API Routes - Repository Operations', () => {
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
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/repos/:owner/:repo', () => {
    it('should require GitHub connection', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/tree/*', () => {
    it('should require GitHub connection for tree view', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/tree/main')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/raw/*', () => {
    it('should require GitHub connection for raw files', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/raw/main/README.md')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/contents/*', () => {
    it('should require GitHub connection for contents', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/contents/src/index.ts')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/contents/*', () => {
    it('should require GitHub connection to update file', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/contents/test.txt')
        .send({ content: 'test', message: 'Update file' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/github-contents/*', () => {
    it('should require GitHub connection to update via GitHub API', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/github-contents/test.txt')
        .send({ content: 'test', message: 'Update file' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/file-history/*', () => {
    it('should require GitHub connection for file history', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/file-history/README.md')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/branches', () => {
    it('should require GitHub connection for branches', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/branches')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/collaborators', () => {
    it('should require GitHub connection for collaborators', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/collaborators')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/issues', () => {
    it('should require GitHub connection for issues', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/issues')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/issues/:number', () => {
    it('should require GitHub connection for issue details', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/issues/1')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('POST /api/repos/:owner/:repo/issues/:number/comments', () => {
    it('should require GitHub connection to add comment', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/issues/1/comments')
        .send({ body: 'Test comment' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/repos/:owner/:repo/issues/:number', () => {
    it('should require GitHub connection to update issue', async () => {
      const response = await request(app)
        .patch('/api/repos/testowner/testrepo/issues/1')
        .send({ state: 'closed' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/issues/:number/assignees', () => {
    it('should require GitHub connection to add assignees', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/issues/1/assignees')
        .send({ assignees: ['user1'] })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('DELETE /api/repos/:owner/:repo/issues/:number/assignees', () => {
    it('should require GitHub connection to remove assignees', async () => {
      const response = await request(app)
        .delete('/api/repos/testowner/testrepo/issues/1/assignees')
        .send({ assignees: ['user1'] })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/pulls', () => {
    it('should require GitHub connection for pull requests', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/pulls')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/pulls/:number', () => {
    it('should require GitHub connection for PR details', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/pulls/1')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/commits/:branch', () => {
    it('should require GitHub connection for commits', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/commits/main')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Repository Actions & Workflows', () => {
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
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/repos/:owner/:repo/actions/runs', () => {
    it('should require GitHub connection for workflow runs', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/actions/runs')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/actions/runs/:runId', () => {
    it('should require GitHub connection for run details', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/actions/runs/12345')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/workflows', () => {
    it('should require GitHub connection for workflows list', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/workflows')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/workflows/file', () => {
    it('should require GitHub connection for workflow file', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/workflows/file')
        .query({ path: '.github/workflows/ci.yml' })
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('POST /api/repos/:owner/:repo/workflows/file', () => {
    it('should require GitHub connection to create workflow', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/workflows/file')
        .send({
          path: '.github/workflows/test.yml',
          content: 'name: Test',
          message: 'Add workflow',
        })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/workflows/file', () => {
    it('should require GitHub connection to update workflow', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/workflows/file')
        .send({
          path: '.github/workflows/test.yml',
          content: 'name: Test Updated',
          message: 'Update workflow',
        })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('DELETE /api/repos/:owner/:repo/workflows/file', () => {
    it('should require GitHub connection to delete workflow', async () => {
      const response = await request(app)
        .delete('/api/repos/testowner/testrepo/workflows/file')
        .query({ path: '.github/workflows/test.yml' })
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/workflows/:workflow_id/runs', () => {
    it('should require GitHub connection for workflow runs', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/workflows/12345/runs')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Repository Secrets & Environment', () => {
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
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/repos/:owner/:repo/secrets', () => {
    it('should require GitHub connection to create secrets', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/secrets')
        .send({ name: 'TEST_SECRET', value: 'secret-value' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('POST /api/repos/:owner/:repo/inject-secrets', () => {
    it('should handle inject secrets without local repo', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/inject-secrets')
        .send({ secrets: { KEY: 'value' } })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // Endpoint returns 200 with success:true even without repo (graceful handling)
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });
  });

  describe('GET /api/repos/:owner/:repo/env-files', () => {
    it('should return empty array when repo not cloned', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/env-files')
        .set('Authorization', `Bearer ${authToken}`);

      // Endpoint returns 200 with empty files array when repo not cloned (graceful handling)
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('files');
      expect(Array.isArray(response.body.files)).toBe(true);
      expect(response.body.files.length).toBe(0);
    });
  });
});

describe('API Routes - Repository Git Operations', () => {
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
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/repos/:owner/:repo/clone', () => {
    it('should require GitHub connection to clone', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/clone')
        .send({ branch: 'main' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/git-diff', () => {
    it('should require path parameter', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/git-diff')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/git-status', () => {
    it('should return 404 when the repository is not cloned locally', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/git-status')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Repository not cloned locally');
    });
  });

  describe('GET /api/repos/:owner/:repo/git-status-fetch', () => {
    it('should return 404 when the repository is not cloned locally', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/git-status-fetch')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Repository not cloned locally');
    });
  });
});

describe('API Routes - Repository Quick Actions & Generations', () => {
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
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/repos/:owner/:repo/quick-actions', () => {});

  describe('GET /api/repos/:owner/:repo/generations', () => {
    it('should return generations for repo', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/generations')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('generations');
      expect(Array.isArray(response.body.generations)).toBe(true);
    });
  });

  describe('POST /api/repos/:owner/:repo/view', () => {
    it('should track repository view', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/view')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
});
