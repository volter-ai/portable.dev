/**
 * Advanced API Routes Integration Tests
 *
 * Tests for routines, uploads, transcription, and other advanced features
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
import path from 'path';

describe('API Routes - Routines Management', () => {
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

  // Routines Management tests removed - the client uses the GitHub API
  // (/api/repos/:owner/:repo/workflows), not /api/routines endpoints.
});

describe('API Routes - Upload & Media Processing', () => {
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

  describe('POST /api/upload', () => {
    it('should require file upload', async () => {
      const response = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${authToken}`);

      // Will fail without multipart/form-data
      expect([400, 500]).toContain(response.status);
    });
  });

  // POST /api/upload/audio - Route doesn't exist, not used by the client

  describe('POST /api/transcribe', () => {
    it('should require audio file or path', async () => {
      const response = await request(app)
        .post('/api/transcribe')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });
  });

  // POST /api/transcribe/url - Route doesn't exist, not used by the client
});

describe('API Routes - Generations & AI Media', () => {
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

  // All generation routes don't exist and aren't used by the client
  // - GET /api/generations
  // - GET /api/generations/:generationId
  // - DELETE /api/generations/:generationId
  // - POST /api/generations/image
  // - POST /api/generations/video
});

describe('API Routes - Project Management', () => {
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

  describe('POST /api/projects/create', () => {
    it('should require project data', async () => {
      const response = await request(app)
        .post('/api/projects/create')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });
});

describe('API Routes - Runtime & Process Management', () => {
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

  // All runtime REST API routes don't exist - the client uses SocketIO (userRuntimeState)
  // - GET /api/runtime/state
  // - POST /api/runtime/process/start
  // - POST /api/runtime/process/stop
  // - GET /api/runtime/processes
});

describe('API Routes - Misc Advanced Features', () => {
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

  // These endpoints don't exist and aren't used by the client:
  // - GET /api/workspace-info
  // - GET /api/models (the client imports from @vgit2/shared/models)
  // - POST /api/chat/stop (chat control via SocketIO)
});
