/**
 * Source Control Routes Integration Tests (portable.dev#17)
 *
 * Smoke coverage for the isolated /api/source-control factory. The real
 * endpoint behavior (graph, status, diffs, worktrees, write ops) is added and
 * tested in US-004..US-016; this asserts the auth boundary is wired.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import request from 'supertest';
import { createTestServer } from '../../setup/helpers/testServer';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { Application } from 'express';

describe('Source Control Routes', () => {
  let app: Application;

  beforeEach(() => {
    // The 401 boundary is checked before any DB/git access, so a stub adapter
    // is sufficient — no live database needed for this smoke test.
    const dbAdapter = { getAdapterType: () => 'stub' } as unknown as DbAdapter;

    // No authToken / userEmail → no session injected → requireAuth must reject.
    app = createTestServer({ dbAdapter });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/source-control/octocat/hello-world/graph');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized: Please log in');
  });
});
