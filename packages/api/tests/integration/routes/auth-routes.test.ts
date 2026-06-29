/**
 * Auth Routes Integration Tests
 *
 * Tests authentication endpoints using supertest with scenario-based tests.
 * Each scenario tests a complete user flow through multiple endpoints.
 *
 * Philosophy: Test realistic user journeys, not individual endpoints in isolation
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);
import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { generateAuthToken } from '@vgit2/shared/jwt';
import { Application } from 'express';
import { ConnectionsService } from '../../../src/services/ConnectionsService';
import { WORKSPACE_DIR } from '@vgit2/shared/constants';

describe('Auth Routes - Complete OAuth Flow Scenarios', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;
  let testEmail: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    testEmail = testUserId;
    connectionsService = new ConnectionsService(dbAdapter, WORKSPACE_DIR);

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

  it('Scenario: User initiates OAuth, completes it, checks permissions, and logs out', async () => {
    // Step 1: User clicks "Connect GitHub" - should redirect to GitHub OAuth
    const githubLoginResponse = await request(app).get('/auth/github');
    expect(githubLoginResponse.status).toBe(302);
    expect(githubLoginResponse.headers.location).toContain('github.com/login/oauth');

    // Step 2: User clicks "Connect Google Drive" - should redirect to Google OAuth
    const googleLoginResponse = await request(app).get('/auth/google');
    expect(googleLoginResponse.status).toBe(302);
    expect(googleLoginResponse.headers.location).toContain('accounts.google.com');

    // Step 3: Google Drive alias also works
    const googleDriveResponse = await request(app).get('/auth/google-drive');
    expect(googleDriveResponse.status).toBe(302);
    expect(googleDriveResponse.headers.location).toContain('accounts.google.com');

    // Step 4: Gmail alias also works
    const gmailResponse = await request(app).get('/auth/gmail');
    expect(gmailResponse.status).toBe(302);
    expect(gmailResponse.headers.location).toContain('accounts.google.com');

    // Step 5: User clicks "Connect Slack" - should redirect to Slack OAuth
    const slackLoginResponse = await request(app).get('/auth/slack');
    expect(slackLoginResponse.status).toBe(302);
    expect(slackLoginResponse.headers.location).toContain('slack.com/oauth');

    // Step 6: Check GitHub permissions before connecting - should show no permissions
    const permissionsBeforeResponse = await request(app).get('/auth/check-github-permissions');
    expect(permissionsBeforeResponse.status).toBe(200);
    expect(permissionsBeforeResponse.body.hasPermissions).toBe(false);
    expect(permissionsBeforeResponse.body.authType).toBe('none');
    expect(permissionsBeforeResponse.body.needsUpgrade).toBe(true);

    // Step 7: Check scopes - should return current scope status
    const scopesResponse = await request(app).get('/auth/check-scopes');
    expect(scopesResponse.status).toBe(200);
    expect(scopesResponse.body).toHaveProperty('currentScopes');

    // Step 8: User logs out via session logout
    const logoutResponse = await request(app).get('/auth/logout');
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body.success).toBe(true);
    expect(logoutResponse.body.redirectUrl).toBeDefined();
  });

  it('Scenario: User completes GitHub OAuth callback with valid and invalid codes', async () => {
    // Step 1: GitHub callback without code - should fail
    const noCodeResponse = await request(app).get('/auth/github/callback');
    expect(noCodeResponse.status).toBe(400);

    // Step 2: GitHub callback with invalid code - should fail
    const invalidCodeResponse = await request(app).get('/auth/github/callback?code=invalid-code');
    expect(invalidCodeResponse.status).toBe(400);

    // Step 3: GitHub callback with error from OAuth provider - should fail
    const errorResponse = await request(app).get(
      '/auth/github/callback?error=access_denied&error_description=User+denied+access'
    );
    expect(errorResponse.status).toBe(400);

    // Step 4: Google callback without code - should fail
    const googleNoCodeResponse = await request(app).get('/auth/google/callback');
    expect(googleNoCodeResponse.status).toBe(400);

    // Step 5: Google callback with invalid code - should fail
    const googleInvalidResponse = await request(app).get('/auth/google/callback?code=invalid-code');
    expect(googleInvalidResponse.status).toBe(400);

    // Step 6: Slack callback without code - should fail (returns 500 from service)
    const slackNoCodeResponse = await request(app).get('/auth/slack/callback');
    expect(slackNoCodeResponse.status).toBe(500);
  });
});

describe('Auth Routes - GitHub connect flushes the active-connection cache', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;
  let testEmail: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    testEmail = testUserId;
    connectionsService = new ConnectionsService(dbAdapter, WORKSPACE_DIR);

    // Wire the SAME connectionsService into the route so we can observe the flush
    // it performs (the route mounts whatever is passed in services).
    app = createTestServer({
      dbAdapter,
      authToken,
      userEmail: testEmail,
      services: { connectionsService },
    });
  });

  afterEach(async () => {
    if (testUserId) {
      const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
      await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    }
  });

  it('invalidates the stale negative cache entry when GitHub OAuth is initiated', async () => {
    // Prime the cache with a NEGATIVE result — exactly the state a pre-connect
    // permission check leaves behind (no connection yet). With an authToken
    // present this is cached for 45s, which is what made the post-connect
    // re-check return "no connection" until the TTL expired.
    const before = await connectionsService.getActiveGitHubConnection(testEmail, authToken);
    expect(before.type).toBe('none');

    const invalidateSpy = spyOn(connectionsService, 'invalidateActiveGitHubConnection');

    // User taps "Connect GitHub" — the sandbox /auth/github route runs.
    const githubLoginResponse = await request(app).get('/auth/github');
    expect(githubLoginResponse.status).toBe(302);
    expect(githubLoginResponse.headers.location).toContain('github.com/login/oauth');

    // The route flushed THIS user's cache entry (keyed by session email) before
    // delegating to OAuth, so the gateway-stored connection is picked up on the
    // very next /auth/check-github-permissions instead of after the 45s TTL.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith(testEmail);

    invalidateSpy.mockRestore();
  });
});

describe('Auth Routes - GitHub App Installation Flow', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;
  let testEmail: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    testEmail = testUserId;
    connectionsService = new ConnectionsService(dbAdapter, WORKSPACE_DIR);

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

  it('Scenario: Check existing GitHub App installations', async () => {
    // NOTE: GET /auth/github-app/callback and POST /auth/github-app/complete
    // have been removed — installation callback is now handled by the gateway.

    // Check for existing GitHub App installations (none yet)
    const checkExistingResponse = await request(app).get('/auth/github-app/check-existing');
    expect(checkExistingResponse.status).toBe(200);
    expect(checkExistingResponse.body.found).toBe(false);
  });

  it('Scenario: GitHub connection activation - handles edge cases', async () => {
    // Missing connectionId in activate endpoint
    const noConnectionIdResponse = await request(app)
      .post('/auth/github/activate')
      .send({})
      .set('Content-Type', 'application/json');
    expect(noConnectionIdResponse.status).toBe(400);

    // Empty connectionId in activate endpoint
    const emptyConnectionIdResponse = await request(app)
      .post('/auth/github/activate')
      .send({ connectionId: '' })
      .set('Content-Type', 'application/json');
    expect(emptyConnectionIdResponse.status).toBe(400);

    // Non-existent connectionId
    const nonExistentResponse = await request(app)
      .post('/auth/github/activate')
      .send({ connectionId: 'non-existent-connection' })
      .set('Content-Type', 'application/json');
    expect(nonExistentResponse.status).toBe(500);
  });
});

describe('Auth Routes - Token Management Flow', () => {
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

  it('Scenario: User updates JWT token and logs out via JWT endpoint', async () => {
    // Step 1: Update token with new user info
    const newToken = generateAuthToken({
      userId: testUserId,
      username: 'updated-user',
      email: testEmail,
      avatarUrl: 'https://example.com/new-avatar.jpg',
    });

    const updateResponse = await request(app)
      .post('/auth/update-token')
      .send({ token: newToken })
      .set('Content-Type', 'application/json');
    expect(updateResponse.status).toBe(200);
    expect(updateResponse.body.success).toBe(true);
    expect(updateResponse.body.message).toBe('Token updated successfully');

    // Step 2: Update token again with a second valid token
    const secondValidToken = generateAuthToken({
      userId: testUserId,
      username: 'testuser',
      email: testEmail,
    });

    const secondUpdateResponse = await request(app)
      .post('/auth/update-token')
      .send({ token: secondValidToken })
      .set('Content-Type', 'application/json');
    expect(secondUpdateResponse.status).toBe(200);
    expect(secondUpdateResponse.body.success).toBe(true);

    // Step 3: Try to update with invalid token - should fail
    const invalidResponse = await request(app)
      .post('/auth/update-token')
      .send({ token: 'invalid-token' })
      .set('Content-Type', 'application/json');
    expect(invalidResponse.status).toBe(401);

    // Step 4: Try to update with missing token - should fail
    const missingResponse = await request(app)
      .post('/auth/update-token')
      .send({})
      .set('Content-Type', 'application/json');
    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body.error).toBe('Missing token');

    // Step 5: Try to update with empty token - should fail
    const emptyResponse = await request(app)
      .post('/auth/update-token')
      .send({ token: '' })
      .set('Content-Type', 'application/json');
    expect(emptyResponse.status).toBe(400);

    // Step 6: JWT logout without token - should fail
    const noTokenLogoutResponse = await request(app)
      .post('/auth/jwt-logout')
      .set('Content-Type', 'application/json');
    expect(noTokenLogoutResponse.status).toBe(400);

    // Step 7: JWT logout with valid token - should succeed
    const jwtLogoutResponse = await request(app)
      .post('/auth/jwt-logout')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json');
    expect(jwtLogoutResponse.status).toBe(200);
    expect(jwtLogoutResponse.body.success).toBe(true);
    expect(jwtLogoutResponse.body.redirectUrl).toBeDefined();
  });
});

describe('Auth Routes - Clerk Integration Flow', () => {
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

  it('Scenario: User exchanges Clerk session for JWT', async () => {
    // Step 1: Exchange without sessionId - should fail
    const noSessionIdResponse = await request(app)
      .post('/auth/clerk/exchange')
      .send({})
      .set('Content-Type', 'application/json');
    expect(noSessionIdResponse.status).toBe(400);
    expect(noSessionIdResponse.body.error).toContain('required');

    // Step 2: Exchange without sessionToken - should fail
    const noSessionTokenResponse = await request(app)
      .post('/auth/clerk/exchange')
      .send({ sessionId: 'test-session' })
      .set('Content-Type', 'application/json');
    expect(noSessionTokenResponse.status).toBe(400);
    expect(noSessionTokenResponse.body.error).toContain('required');

    // Step 3: Exchange with invalid session - should fail
    const invalidSessionResponse = await request(app)
      .post('/auth/clerk/exchange')
      .send({
        sessionId: 'invalid-session',
        sessionToken: 'some-token',
      })
      .set('Content-Type', 'application/json');
    expect(invalidSessionResponse.status).toBe(401);

    // Step 4: Exchange with valid session - should succeed
    const validExchangeResponse = await request(app)
      .post('/auth/clerk/exchange')
      .send({
        sessionId: 'valid-session-123',
        sessionToken: 'valid-token-abc',
      })
      .set('Content-Type', 'application/json');
    expect(validExchangeResponse.status).toBe(200);
    expect(validExchangeResponse.body).toHaveProperty('token');
    expect(validExchangeResponse.body).toHaveProperty('user');
    expect(validExchangeResponse.body.user.email).toBe('test@example.com');
  });
});

describe('Auth Routes - Connection Disconnect Flow', () => {
  let app: Application;
  let dbAdapter: DbAdapter;
  let connectionsService: ConnectionsService;
  let testUserId: string;
  let authToken: string;
  let testEmail: string;

  beforeEach(async () => {
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    testEmail = testUserId;
    connectionsService = new ConnectionsService(dbAdapter, WORKSPACE_DIR);

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

  it('Scenario: User disconnects Google and Slack connections', async () => {
    // Step 1: Disconnect Google when no connection exists - should handle gracefully
    const googleDisconnectResponse = await request(app)
      .post('/auth/google/disconnect')
      .set('Content-Type', 'application/json');
    expect(googleDisconnectResponse.status).toBe(200);

    // Step 2: Disconnect Slack when no connection exists - should handle gracefully
    const slackDisconnectResponse = await request(app)
      .post('/auth/slack/disconnect')
      .set('Content-Type', 'application/json');
    expect(slackDisconnectResponse.status).toBe(200);

    // Step 3: Refresh JWT without GitHub connection - should return 404
    const refreshResponse = await request(app)
      .post('/auth/refresh-jwt-with-github')
      .set('Content-Type', 'application/json');
    expect(refreshResponse.status).toBe(404);
  });
});
