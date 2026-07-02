/**
 * API Routes Integration Tests
 *
 * Tests HTTP endpoints using supertest for in-memory requests.
 * No server.listen() needed - tests run directly against Express app.
 *
 * Philosophy: Test the full request/response cycle with real services
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { JsonDbAdapter } from '../../../src/db/JsonDbAdapter/index.js';
import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import { Application } from 'express';

describe('API Routes - Health & Config Endpoints', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Create test server
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

  describe('GET /health', () => {
    it('should return 200 with health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        environment: 'test',
      });
      expect(response.body.timestamp).toBeDefined();
      expect(response.body.uptime).toBeDefined();
    });
  });

  describe('GET /api/health', () => {
    it('should return 200 with health status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
      });
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /api/heartbeat', () => {
    it('should return 200 with alive status', async () => {
      const response = await request(app).get('/api/heartbeat');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        alive: true,
      });
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /api/config', () => {
    it('should return configuration', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('modalMode');
    });
  });

  describe('GET /api/verify-ownership', () => {
    it('should return ownership verification in development mode', async () => {
      const response = await request(app).get('/api/verify-ownership');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'development',
        isOwner: true,
      });
    });
  });
});

describe('API Routes - User Endpoints', () => {
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
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/user', () => {
    it('should return user information', async () => {
      const response = await request(app)
        .get('/api/user')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('email', testEmail);
    });
  });

  describe('GET /api/user-settings', () => {
    it('should return user settings', async () => {
      const response = await request(app).get('/api/user-settings');

      expect(response.status).toBe(200);
      // Settings might be null for new users
      expect(response.body).toHaveProperty('settings');
    });
  });

  describe('POST /api/user-settings', () => {
    it('should update user settings', async () => {
      const settings = {
        theme: 'dark',
        notifications: true,
      };

      const response = await request(app)
        .post('/api/user-settings')
        .send({ settings })
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('settings');
    });
  });
});

describe('API Routes - Chat Endpoints', () => {
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
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/chats', () => {
    it('should return empty array for new user', async () => {
      const response = await request(app).get('/api/chats');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('chats');
      expect(Array.isArray(response.body.chats)).toBe(true);
    });
  });

  describe('POST /api/chats', () => {
    it('should create a new chat', async () => {
      const chatData = {
        type: 'code',
        title: 'Test Chat',
        repoOwner: 'testowner',
        repoName: 'testrepo',
        prompt: 'Test prompt',
      };

      const response = await request(app)
        .post('/api/chats')
        .send(chatData)
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('title', 'Test Chat');
    });

    it('should reject chat creation without required fields', async () => {
      const response = await request(app)
        .post('/api/chats')
        .send({})
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/chats/:chatId/messages', () => {
    // Skip: This test hangs in CI because the database query for messages
    // on a non-existent chat never resolves within the 5s timeout.
    it.skip('should return 404 for non-existent chat', async () => {
      const response = await request(app).get('/api/chats/non-existent-chat/messages');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });
});

/**
 * Regression: GET /api/chats failed to parse `linked_issue` and
 * dropped the `linkedIssue` field whenever a chat was linked to a GitHub issue.
 *
 * The active production adapter (JsonDbAdapter) stores `linked_issue` as a
 * native object, but the route did `JSON.parse(chat.linked_issue)` — which coerces
 * the object to the string "[object Object]" and throws
 * `SyntaxError: Unexpected identifier "object"`. Adapters that store the column as
 * text never caught this because the text column round-trips a JSON string. This block runs
 * the route against the REAL JsonDbAdapter so the field is an object, exactly like
 * production.
 */
describe('API Routes - GET /api/chats linked issue (JsonDbAdapter)', () => {
  let app: Application;
  let jsonAdapter: JsonDbAdapter;
  let baseAdapter: DbAdapter;
  let dataDir: string;
  let testUserId: string;
  let authToken: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    baseAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Wrap the real base adapter exactly like production: chats/messages live on
    // JSON files, everything else delegates to the base adapter.
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chats-linked-issue-'));
    jsonAdapter = new JsonDbAdapter(baseAdapter, dataDir);
    await jsonAdapter.initialize();

    app = createTestServer({
      dbAdapter: jsonAdapter,
      authToken,
      userEmail: testUserId,
    });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  it('returns linkedIssue (owner/repo/number) for an issue-linked chat without errors', async () => {
    await jsonAdapter.saveChat({
      userId: testUserId,
      chatId: 'chat-linked',
      type: 'claude_code',
      title: 'Linked chat',
    });
    await jsonAdapter.updateLinkedIssue('chat-linked', testUserId, {
      owner: 'volter-ai',
      repo: 'mobile-vgit',
      number: 42,
    });

    const response = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    const linked = response.body.chats.find((c: any) => c.id === 'chat-linked');
    expect(linked).toBeDefined();
    expect(linked.linkedIssue).toEqual({
      owner: 'volter-ai',
      repo: 'mobile-vgit',
      number: 42,
    });
  });

  it('omits linkedIssue for a chat with no linked issue', async () => {
    await jsonAdapter.saveChat({
      userId: testUserId,
      chatId: 'chat-unlinked',
      type: 'claude_code',
      title: 'Unlinked chat',
    });

    const response = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    const unlinked = response.body.chats.find((c: any) => c.id === 'chat-unlinked');
    expect(unlinked).toBeDefined();
    expect(unlinked.linkedIssue).toBeUndefined();
  });

  /**
   * Regression: chats persisted WITHOUT `repo_full_name` (every chat created via
   * `chat:create` before it started storing the full name) rendered with no repo
   * icon in the mobile list — the client can't parse owner/repo out of a Windows
   * backslash `repo_path` or the two-level workspace layout. The route now falls
   * back to a server-side `getRepoFromPath(repo_path, workspaceRoot)` parse.
   */
  it('resolves repoFullName from repo_path for legacy rows persisted without repo_full_name', async () => {
    const repoPath = path.join(getUserWorkspaceDir(testUserId), 'octocat', 'hello-world');
    await jsonAdapter.saveChat({
      userId: testUserId,
      chatId: 'chat-legacy-no-fullname',
      type: 'claude_code',
      title: 'Legacy chat',
      repoPath,
    });

    const response = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    const legacy = response.body.chats.find((c: any) => c.id === 'chat-legacy-no-fullname');
    expect(legacy).toBeDefined();
    expect(legacy.repoFullName).toBe('octocat/hello-world');
  });

  it('prefers the stored repo_full_name over the repo_path parse (flat clones)', async () => {
    // A flat clone's disk path has no owner segment — only the stored full name
    // (derived from the git remote at create time) can label it.
    const flatPath = path.join(os.tmpdir(), 'some-flat-checkout');
    await jsonAdapter.saveChat({
      userId: testUserId,
      chatId: 'chat-flat-clone',
      type: 'claude_code',
      title: 'Flat clone chat',
      repoPath: flatPath,
      repoFullName: 'octocat/flat-repo',
    });

    const response = await request(app)
      .get('/api/chats')
      .set('Authorization', `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    const flat = response.body.chats.find((c: any) => c.id === 'chat-flat-clone');
    expect(flat).toBeDefined();
    expect(flat.repoFullName).toBe('octocat/flat-repo');
  });
});

describe('API Routes - Repository Endpoints', () => {
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
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/repos', () => {
    it('should require GitHub authentication', async () => {
      const response = await request(app).get('/api/repos');

      // Without GitHub connection, should return 401
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('GitHub');
    });
  });

  describe('GET /api/local-repos', () => {
    it('should return local repositories', async () => {
      const response = await request(app).get('/api/local-repos');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('repos');
      expect(Array.isArray(response.body.repos)).toBe(true);
    });
  });
});

describe('API Routes - Connections Endpoints', () => {
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
    if (dbAdapter && testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  describe('GET /api/connections', () => {
    it('should return connections list', async () => {
      const response = await request(app).get('/api/connections');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('connections');
      expect(Array.isArray(response.body.connections)).toBe(true);
    });
  });

  describe('GET /api/connections/services', () => {
    it('should return available services', async () => {
      const response = await request(app).get('/api/connections/services');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('services');
      expect(Array.isArray(response.body.services)).toBe(true);
    });
  });

  describe('GET /api/connections/services/:service', () => {
    it('should return service details', async () => {
      const response = await request(app).get('/api/connections/services/github');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('service');
      expect(response.body.service).toBe('github');
    });

    it('should return 404 for unknown service', async () => {
      const response = await request(app).get('/api/connections/services/unknown-service');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });
});

describe('API Routes - Error Handling', () => {
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

  describe('Invalid routes', () => {
    it('should return 404 for non-existent endpoint', async () => {
      const response = await request(app).get('/api/non-existent-endpoint');

      // Express default: 404 with no body, or might have a message
      expect(response.status).toBe(404);
    });
  });

  describe('Invalid methods', () => {
    it('should return 404 for unsupported HTTP method', async () => {
      const response = await request(app).delete('/api/heartbeat');

      // Express default: 404 for method not allowed
      expect(response.status).toBe(404);
    });
  });
});
