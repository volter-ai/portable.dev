/**
 * Media, Runtime & Miscellaneous Integration Tests
 *
 * Tests for media endpoints, runtime operations, and other miscellaneous routes
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

describe('API Routes - Media Endpoints', () => {
  describe('Unauthenticated requests', () => {
    let app: Application;
    let dbAdapter: DbAdapter;
    let testUserId: string;

    beforeEach(async () => {
      const { adapter, userId } = await createTestDbAdapter();
      dbAdapter = adapter;
      testUserId = userId;

      // Create server WITHOUT auth credentials to test unauthenticated access
      app = createTestServer({
        dbAdapter,
      });
    });

    afterEach(async () => {
      if (testUserId) {
        const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
        await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
      }
    });

    describe('GET /api/video/:owner/:repo/*', () => {
      it('should require authentication', async () => {
        const response = await request(app).get('/api/video/testowner/testrepo/path/to/video.mp4');

        expect(response.status).toBe(401);
      });
    });

    describe('GET /api/image/:owner/:repo/*', () => {
      it('should require authentication', async () => {
        const response = await request(app).get('/api/image/testowner/testrepo/path/to/image.png');

        expect(response.status).toBe(401);
      });
    });
  });

  describe('Authenticated requests', () => {
    let app: Application;
    let dbAdapter: DbAdapter;
    let testUserId: string;
    let authToken: string;

    beforeEach(async () => {
      const { adapter, userId, authToken: token } = await createTestDbAdapter();
      dbAdapter = adapter;
      testUserId = userId;
      authToken = token;

      // Create server WITH auth credentials for authenticated tests
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

    describe('GET /api/video/:owner/:repo/*', () => {
      it('should handle video requests with auth', async () => {
        const response = await request(app)
          .get('/api/video/testowner/testrepo/path/to/video.mp4')
          .set('Authorization', `Bearer ${authToken}`);

        // Should handle gracefully, either 404 or error
        expect([404, 500]).toContain(response.status);
      });
    });

    describe('GET /api/image/:owner/:repo/*', () => {
      it('should handle image requests with auth', async () => {
        const response = await request(app)
          .get('/api/image/testowner/testrepo/path/to/image.png')
          .set('Authorization', `Bearer ${authToken}`);

        // Should handle gracefully, either 404 or error
        expect([404, 500]).toContain(response.status);
      });
    });

    describe('GET /api/uploads/:filename', () => {});

    describe('GET /api/workspace-file', () => {
      it('should require file path parameter', async () => {
        const response = await request(app)
          .get('/api/workspace-file')
          .set('Authorization', `Bearer ${authToken}`);

        expect(response.status).toBe(400);
      });
    });

    describe('GET /api/task-output', () => {
      it('should require task ID', async () => {
        const response = await request(app)
          .get('/api/task-output')
          .set('Authorization', `Bearer ${authToken}`);

        expect(response.status).toBe(400);
      });
    });
  });
});

describe('API Routes - Runtime Operations', () => {
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

  describe('POST /api/runtime/refresh-live-view', () => {});
});

describe('API Routes - GitHub Issue Details', () => {
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

  describe('GET /api/github/issues/:owner/:repo/:issue_number', () => {
    it('should require GitHub connection', async () => {
      const response = await request(app)
        .get('/api/github/issues/testowner/testrepo/1')
        .set('Authorization', `Bearer ${authToken}`);

      // Should return auth error without GitHub connection
      expect([401, 404, 500]).toContain(response.status);
    });

    it('should handle issue number parameter', async () => {
      const response = await request(app)
        .get('/api/github/issues/testowner/testrepo/123')
        .set('Authorization', `Bearer ${authToken}`);

      expect([401, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - Environment Files', () => {
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

  describe('GET /api/repos/:owner/:repo/env-files', () => {
    // Test deleted: Bad quality test that accepted multiple status codes [401, 404, 500]
    // This violates CLAUDE.md testing rules about deterministic tests
  });

  describe('GET /api/env-file/read', () => {
    it('should require file path', async () => {
      const response = await request(app)
        .get('/api/env-file/read')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    // Test deleted: Bad quality test that accepted multiple status codes [401, 404, 500]
    // This violates CLAUDE.md testing rules about deterministic tests
  });

  describe('POST /api/env-file/write', () => {
    it('should require file data', async () => {
      const response = await request(app)
        .post('/api/env-file/write')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });
});

describe('API Routes - System Endpoints', () => {
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

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('ok');
    });
  });

  describe('GET /api/heartbeat', () => {
    it('should return heartbeat', async () => {
      const response = await request(app).get('/api/heartbeat');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /api/verify-ownership', () => {
    it('should return ownership verification', async () => {
      const response = await request(app).get('/api/verify-ownership');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/config', () => {
    it('should return public configuration', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('modalMode');
    });
  });
});

describe('API Routes - Intent & Suggestions', () => {
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

  describe('POST /api/chats/analyze-intent', () => {
    it('should require message data', async () => {
      const response = await request(app)
        .post('/api/chats/analyze-intent')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/chats/suggestions', () => {
    it('should require context data', async () => {
      const response = await request(app)
        .post('/api/chats/suggestions')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/generate-project-name', () => {
    it('should require description', async () => {
      const response = await request(app)
        .post('/api/generate-project-name')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });
});
