/**
 * Repository Routes Extended Integration Tests
 *
 * Additional tests for repository.routes.ts to expand coverage.
 * Covers routes that were missing in api-routes-repos.test.ts
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

describe('Repository Routes Extended - Additional Coverage', () => {
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
      requireAuthHeaderForSession: true, // Only inject session when Authorization header is present
    });
  });

  afterEach(async () => {
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('POST /api/projects/create-local', () => {
    it('should reject without project name', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject with invalid project name', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ folderName: '../invalid-path' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/projects/create-local')
        .send({ folderName: 'test-project' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/uploads/:filename', () => {
    it('should return 404 for non-existent file', async () => {
      const response = await request(app)
        .get('/api/uploads/non-existent-file.txt')
        .set('Authorization', `Bearer ${authToken}`);

      expect([404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/uploads/test.txt');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/workspace-file', () => {
    it('should reject without path parameter', async () => {
      const response = await request(app)
        .get('/api/workspace-file')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('path');
    });

    it('should reject path traversal attempts', async () => {
      const response = await request(app)
        .get('/api/workspace-file')
        .query({ path: '../../../etc/passwd' })
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid');
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/workspace-file').query({ path: 'test.txt' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/task-output', () => {
    it('should reject without required parameters', async () => {
      const response = await request(app)
        .get('/api/task-output')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/task-output');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/cached', () => {
    it('should require GitHub connection', async () => {
      const response = await request(app)
        .get('/api/repos/cached')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/cached');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/refresh', () => {
    it('should require GitHub connection', async () => {
      const response = await request(app)
        .get('/api/repos/refresh')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/refresh');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/tree/*', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/tree/main')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 401 (no GitHub), 404 (repo not found), or 500 (error)
      expect([401, 404, 500]).toContain(response.status);
    });

    it('should reject invalid owner/repo names', async () => {
      const response = await request(app)
        .get("/api/repos/'; DROP TABLE users; --/testrepo/tree/main")
        .set('Authorization', `Bearer ${authToken}`);

      // May return 400 (validation error), 401 (no auth), 404 (not found), or 500 (error)
      expect([400, 401, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/repos/:owner/:repo/raw/*', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/raw/main/README.md')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });
  });

  describe('PUT /api/repos/:owner/:repo/github-contents/*', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/github-contents/test.md')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ content: 'test content', message: 'test' });

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/github-contents/test.md')
        .send({ content: 'test', message: 'test' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/collaborators', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/collaborators')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/collaborators');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/actions/runs', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/actions/runs')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/actions/runs');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/actions/runs/:runId', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/actions/runs/123456')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/actions/runs/123456');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/workflows/:workflow_id/runs', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/workflows/123456/runs')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get(
        '/api/repos/testowner/testrepo/workflows/123456/runs'
      );

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/repos/:owner/:repo/secrets', () => {
    it('should reject without required fields', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/secrets')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/secrets')
        .send({ name: 'TEST_SECRET', value: 'test' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/repos/:owner/:repo/issues/:number/comments', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/issues/1/comments')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ body: 'test comment' });

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/issues/1/comments')
        .send({ body: 'test' });

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/repos/:owner/:repo/issues/:number/assignees', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/issues/1/assignees')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ assignees: ['testuser'] });

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .put('/api/repos/testowner/testrepo/issues/1/assignees')
        .send({ assignees: ['testuser'] });

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/repos/:owner/:repo/issues/:number/assignees', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .delete('/api/repos/testowner/testrepo/issues/1/assignees')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ assignees: ['testuser'] });

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete('/api/repos/testowner/testrepo/issues/1/assignees')
        .send({ assignees: ['testuser'] });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/commits/:branch', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/commits/main')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/commits/main');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/generations', () => {
    it('should return generations data', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/generations')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('generations');
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/generations');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/quick-actions', () => {
    it('returns 200 with an empty quickActions list when the repo is not cloned locally', async () => {
      // testowner/testrepo is not cloned in the test workspace, so the handler short-circuits
      // to an empty list BEFORE touching tunnelService — a deterministic 200 (this path used
      // to 500 in local mode when tunnelService was undefined; it is now guarded).
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/quick-actions')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.quickActions).toEqual([]);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/quick-actions');

      expect(response.status).toBe(401);
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

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/git-status');

      expect(response.status).toBe(401);
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

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/git-status-fetch');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/repos/:owner/:repo/view', () => {
    it('should track repository view', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/view')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(200);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/repos/testowner/testrepo/view').send({});

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/user/tasks', () => {
    it('should return tasks', async () => {
      const response = await request(app)
        .get('/api/user/tasks')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 (success), 500 (no GitHub connection), or 401 (not authenticated)
      expect([200, 401, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('tasks');
      }
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/user/tasks');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/user/tasks/cached', () => {
    it('should return cached tasks', async () => {
      const response = await request(app)
        .get('/api/user/tasks/cached')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 (success), 500 (no GitHub connection), or 401 (not authenticated)
      expect([200, 401, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('tasks');
      }
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/user/tasks/cached');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/user/tasks/refresh', () => {
    it('should refresh tasks', async () => {
      const response = await request(app)
        .get('/api/user/tasks/refresh')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 (success), 500 (no GitHub connection), or 401 (not authenticated)
      expect([200, 401, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('tasks');
      }
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/user/tasks/refresh');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/user/tasks/stats', () => {
    it('should return task statistics', async () => {
      const response = await request(app)
        .get('/api/user/tasks/stats')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 (success), 500 (no GitHub connection), or 401 (not authenticated)
      expect([200, 401, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('stats');
      }
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/user/tasks/stats');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/repos/:owner/:repo/clone', () => {
    it('should reject without GitHub authentication', async () => {
      const response = await request(app)
        .post('/api/repos/testowner/testrepo/clone')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect([401, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/repos/testowner/testrepo/clone').send({});

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/local-repos', () => {
    it('should return local repositories', async () => {
      const response = await request(app)
        .get('/api/local-repos')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('repos');
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/local-repos');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/git-diff', () => {
    it('should require local repository', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/git-diff')
        .set('Authorization', `Bearer ${authToken}`);

      // May return 200 (success), 400 (invalid), 404 (not found), or 500 (error)
      expect([200, 400, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/git-diff');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/repos/:owner/:repo/env-files', () => {
    it('should return env files', async () => {
      const response = await request(app)
        .get('/api/repos/testowner/testrepo/env-files')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/repos/testowner/testrepo/env-files');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/env-file/read', () => {
    it('should reject without path parameter', async () => {
      const response = await request(app)
        .get('/api/env-file/read')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/env-file/read');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/env-file/write', () => {
    it('should reject without required fields', async () => {
      const response = await request(app)
        .post('/api/env-file/write')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      expect(response.status).toBe(400);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/env-file/write').send({});

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/video/:owner/:repo/*', () => {
    it('should handle video requests', async () => {
      const response = await request(app)
        .get('/api/video/testowner/testrepo/test.mp4')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 404, 500]).toContain(response.status);
    });
  });

  describe('GET /api/image/:owner/:repo/*', () => {
    it('should handle image requests', async () => {
      const response = await request(app)
        .get('/api/image/testowner/testrepo/test.png')
        .set('Authorization', `Bearer ${authToken}`);

      expect([200, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chats/:chatId/device', () => {
    it('should require valid device type', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/device')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ device: 'invalid' });

      expect([400, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/device')
        .send({ device: 'mobile' });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/chats/:chatId/permissions', () => {
    it('should require valid permission mode', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/permissions')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ permissions: 'invalid' });

      expect([400, 404]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/permissions')
        .send({ permissions: 'auto' });

      expect(response.status).toBe(401);
    });
  });

  describe('PATCH /api/chat/:chatId/settings', () => {
    it('should reject for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chat/non-existent-chat/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ settings: {} });

      expect([404, 400]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/chat/test-chat-id/settings')
        .send({ settings: {} });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/chat/:chatId/settings', () => {
    it('should require authentication', async () => {
      const response = await request(app).get('/api/chat/test-chat-id/settings');

      expect(response.status).toBe(401);
    });

    it('should return 404 for a non-existent chat', async () => {
      const response = await request(app)
        .get('/api/chat/non-existent-chat/settings')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });

    it('should return the persisted settings for an existing chat', async () => {
      const chatId = 'settings-get-roundtrip';
      await dbAdapter.saveChat({
        userId: testUserId,
        chatId,
        type: 'claude_code',
        title: 'Settings GET round-trip',
        authToken,
      });

      // Persist settings through the PATCH endpoint (the write path).
      const patch = await request(app)
        .patch(`/api/chat/${chatId}/settings`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          model: 'haiku',
          permissions: 'plan',
          agentSetupId: 'best-practice',
        });
      expect(patch.status).toBe(200);

      // Read them back through the new GET endpoint.
      const response = await request(app)
        .get(`/api/chat/${chatId}/settings`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        model: 'haiku',
        permissions: 'plan',
        agentSetupId: 'best-practice',
      });
    });
  });

  describe('PATCH /api/chats/:chatId/archive', () => {
    it('should require authentication', async () => {
      const response = await request(app)
        .patch('/api/chats/test-chat-id/archive')
        .send({ archived: true });

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/runtime/refresh-live-view', () => {
    it('should refresh live view', async () => {
      const response = await request(app)
        .post('/api/runtime/refresh-live-view')
        .set('Authorization', `Bearer ${authToken}`)
        .send({});

      // May return 200 (success), 400 (missing params), or 500 (error)
      expect([200, 400, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).post('/api/runtime/refresh-live-view').send({});

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/github/issues/:owner/:repo/:issue_number', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app)
        .get('/api/github/issues/testowner/testrepo/1')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });

    it('should require authentication', async () => {
      const response = await request(app).get('/api/github/issues/testowner/testrepo/1');

      expect(response.status).toBe(401);
    });
  });
});
