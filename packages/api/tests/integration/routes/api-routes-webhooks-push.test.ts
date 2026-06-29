/**
 * Push Notifications Integration Tests
 *
 * Tests for push notification endpoints. (The external-webhook routes were
 * removed with the webhook feature.)
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

describe('API Routes - Push Notifications', () => {
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

  describe('GET /api/push/vapid-public-key', () => {});

  describe('POST /api/push/subscribe', () => {
    it('should require subscription data', async () => {
      const response = await request(app)
        .post('/api/push/subscribe')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });
  });

  describe('POST /api/push/unsubscribe', () => {
    it('should require endpoint', async () => {
      const response = await request(app)
        .post('/api/push/unsubscribe')
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${authToken}`);

      expect([400, 500]).toContain(response.status);
    });
  });
});
