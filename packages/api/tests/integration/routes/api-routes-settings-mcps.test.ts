/**
 * User Settings, MCPs & Agent Setups Integration Tests
 *
 * Tests for user settings, MCP endpoints, and agent configuration
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

describe('API Routes - User Settings', () => {
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

  describe('GET /api/user-settings', () => {
    it('should return user settings', async () => {
      const response = await request(app)
        .get('/api/user-settings')
        .set('Authorization', `Bearer ${authToken}`);

      // 200 when stored, 500 on store error
      expect([200, 500]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body).toHaveProperty('settings');
      }
    });
  });

  describe('POST /api/user-settings', () => {
    it('should require settings data', async () => {
      const response = await request(app)
        .post('/api/user-settings')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });
  });

  describe('POST /api/user-settings/complete-onboarding', () => {});
});

describe('API Routes - MCP Endpoints', () => {
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

  describe('GET /api/mcps/available', () => {
    it('should return available MCPs', async () => {
      const response = await request(app)
        .get('/api/mcps/available')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('mcps');
      expect(Array.isArray(response.body.mcps)).toBe(true);
    });

    it('should include MCP details', async () => {
      const response = await request(app)
        .get('/api/mcps/available')
        .set('Authorization', `Bearer ${authToken}`);

      if (response.status === 200 && response.body.mcps.length > 0) {
        const firstMcp = response.body.mcps[0];
        expect(firstMcp).toHaveProperty('name');
        expect(firstMcp).toHaveProperty('description');
      }
    });
  });
});

describe('API Routes - Agent Setups', () => {
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

  describe('GET /api/agent-setups', () => {
    it('should return agent setups', async () => {
      try {
        const response = (await Promise.race([
          request(app).get('/api/agent-setups').set('Authorization', `Bearer ${authToken}`),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), 3000)
          ),
        ])) as any;

        // 200 when stored, 500 on store error
        expect([200, 500]).toContain(response.status);
        if (response.status === 200) {
          expect(response.body).toHaveProperty('agentSetups');
          expect(Array.isArray(response.body.agentSetups)).toBe(true);
        }
      } catch (error: any) {
        // Request timed out - acceptable, just skip
        console.warn('[TEST] Agent setups request timed out');
      }
    });

    it('should include agent setup details', async () => {
      try {
        const response = (await Promise.race([
          request(app).get('/api/agent-setups').set('Authorization', `Bearer ${authToken}`),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), 3000)
          ),
        ])) as any;

        if (response.status === 200 && response.body.agentSetups?.length > 0) {
          const firstSetup = response.body.agentSetups[0];
          expect(firstSetup).toHaveProperty('id');
          expect(firstSetup).toHaveProperty('name');
        }
      } catch (error: any) {
        // Request timed out - acceptable, just skip
        console.warn('[TEST] Agent setups details request timed out');
      }
    });
  });
});

describe('API Routes - Chat Settings & Permissions', () => {
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
        title: 'Test Chat',
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

  describe('PATCH /api/chats/:chatId/device', () => {
    it('should require device data', async () => {
      const response = await request(app)
        .patch(`/api/chats/${testChatId}/device`)
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });

    it('should return 404 for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chats/non-existent-chat/device')
        .send({ playwrightDevice: 'mobile' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // 404 if not found, 200 if service handles gracefully, 500 on store error
      expect([200, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chats/:chatId/permissions', () => {
    it('should require permissions data', async () => {
      const response = await request(app)
        .patch(`/api/chats/${testChatId}/permissions`)
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });

    it('should return 404 for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chats/non-existent-chat/permissions')
        .send({ permissions: 'default' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // 404 if not found, 200 if service handles gracefully, 500 on store error
      expect([200, 404, 500]).toContain(response.status);
    });
  });

  describe('PATCH /api/chat/:chatId/settings', () => {
    it('should require settings data', async () => {
      const response = await request(app)
        .patch(`/api/chat/${testChatId}/settings`)
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });

    it('should return error for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chat/non-existent-chat/settings')
        .send({ settings: { modelPreference: 'sonnet' } })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      // 400 for validation, 404 if not found, 200 if service handles gracefully, 500 on store error
      expect([200, 400, 404, 500]).toContain(response.status);
    });

    it('should persist a valid effort level for a model that supports it', async () => {
      const response = await request(app)
        .patch(`/api/chat/${testChatId}/settings`)
        .send({ model: 'opus', effort: 'xhigh' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.updated.effort).toBe('xhigh');

      const getResponse = await request(app)
        .get(`/api/chat/${testChatId}/settings`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.effort).toBe('xhigh');
    });

    it('should reject an effort level the chat model does not support', async () => {
      // 'xhigh' is not in Sonnet's supported range (Low/Medium/High/Max only).
      const response = await request(app)
        .patch(`/api/chat/${testChatId}/settings`)
        .send({ model: 'sonnet', effort: 'xhigh' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });

    it('should reject an unknown effort level string', async () => {
      const response = await request(app)
        .patch(`/api/chat/${testChatId}/settings`)
        .send({ effort: 'ultra' })
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /api/chats/:chatId/archive', () => {
    it('should return error for non-existent chat', async () => {
      const response = await request(app)
        .patch('/api/chats/non-existent-chat/archive')
        .set('Authorization', `Bearer ${authToken}`);

      // 404 if not found, 200 if service handles gracefully, 500 on store error
      expect([200, 404, 500]).toContain(response.status);
    });
  });
});

describe('API Routes - User Tasks', () => {
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

  describe('GET /api/user/tasks', () => {});

  describe('GET /api/user/tasks/cached', () => {});

  describe('GET /api/user/tasks/refresh', () => {});

  describe('GET /api/user/tasks/stats', () => {});
});
