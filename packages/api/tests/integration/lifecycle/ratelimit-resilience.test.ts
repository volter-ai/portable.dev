/**
 * Rate-Limit Resilience Tests
 *
 * Verifies that UserHandler and RepoHandler degrade gracefully when GitHub
 * secondary-rate-limit (403) errors occur, instead of surfacing raw errors
 * to the client.
 *
 * REAL SERVICES:
 * - ✅ UserHandler / RepoHandler (direct unit instantiation, no HTTP layer)
 * - ✅ withGitHubRetry / withGitHubTimeout (real utility functions)
 *
 * MOCKED EXTERNAL:
 * - 🔴 Octokit (GitHub API calls replaced by controlled stubs)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { UserHandler } from '../../../src/services/GitHubApiService/handlers/UserHandler.js';
import { RepoHandler } from '../../../src/services/GitHubApiService/handlers/RepoHandler.js';
import { MockReposCacheService } from '../../setup/mocks/MockReposCacheService.js';
import type { HandlerDependencies } from '../../../src/services/GitHubApiService/types.js';
import type { Request, Response } from 'express';

// ---------- helpers --------------------------------------------------------

function makeSecondaryRateLimitError(): any {
  const err: any = new Error('You have exceeded a secondary rate limit');
  err.status = 403;
  err.response = { headers: {}, data: { message: 'secondary rate limit' } };
  return err;
}

function makeReq(
  overrides: { query?: Record<string, string>; session?: Record<string, any> } = {}
): Request {
  return {
    session: { userEmail: 'test@example.com', authToken: 'test-token', ...overrides.session },
    query: overrides.query ?? {},
    params: {},
  } as unknown as Request;
}

interface ResponseCapture {
  res: Response;
  statusCode: number;
  body: any;
}

function makeRes(): ResponseCapture {
  const capture: ResponseCapture = { res: undefined as any, statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    json(data: any) {
      capture.body = data;
      return this;
    },
    locals: {},
  } as unknown as Response;
  capture.res = res;
  return capture;
}

// ---------- TEST 1: tasks query degrades to 200 on GraphQL failure ----------
//
// Tasks are scoped to locally cloned repos via ONE per-repo GraphQL
// query (open issues + open PRs + closed issues are all in it — there is no
// separate closed-today query anymore). When that query fails the handler must
// degrade to a 200 with empty arrays (the mobile client renders the empty state via
// the `error` field), never surface a raw 500.

describe('UserHandler: tasks query degrades to 200 on GraphQL failure', () => {
  let handler: UserHandler;

  beforeEach(() => {
    const mockOctokit = {
      users: {
        getAuthenticated: async () => ({
          data: { login: 'testuser', avatar_url: 'https://example.com/a.jpg' },
        }),
      },
      graphql: async (_query: string, _vars?: any) => {
        // Non-rate-limit error so withGitHubRetry exits immediately; the handler
        // should catch it and return a degraded 200 payload.
        const err: any = new Error('GitHub GraphQL unavailable');
        err.status = 503;
        throw err;
      },
    };

    const deps: HandlerDependencies = {
      getUserOctokit: () => mockOctokit as any,
      getOctokitForUser: async () => mockOctokit as any,
      getCachedToken: () => 'mock-token',
      getGitHubConnectionType: () => 'oauth',
      handleGitHubApiError: () => false,
    };

    handler = new UserHandler(deps, null);
  });

  it('returns 200 with empty arrays (not a 500) when the tasks GraphQL query fails', async () => {
    const req = makeReq({ query: { view: 'my' } });
    // A cloned repo so the handler builds + runs the GraphQL query (which fails).
    (req as any).gitLocalService = {
      getLocalRepositories: async () => [{ full_name: 'octo/repo', localPath: '/x' }],
    };
    const capture = makeRes();

    await handler.handleGetUserTasksRefresh(req, capture.res);

    // Degrades gracefully — 200 with empty arrays, never a raw 500.
    expect(capture.statusCode).toBe(200);
    expect(capture.body).toBeDefined();
    expect(capture.body.open_issues).toHaveLength(0);
    expect(capture.body.closed_today).toHaveLength(0);
    expect(capture.body.prs).toHaveLength(0);
    // The degraded payload carries the error field (clients render the empty state).
    expect(capture.body.error).toBeDefined();
  });
});

// ---------- TEST 2: /stats search calls are serialized ----------------------

describe('UserHandler: /stats search calls are serialized (not concurrent)', () => {
  let handler: UserHandler;
  let maxConcurrentGraphqlCalls: number;
  let activeGraphqlCalls: number;

  beforeEach(() => {
    maxConcurrentGraphqlCalls = 0;
    activeGraphqlCalls = 0;

    const trackingGraphql = async (_query: string, _vars?: any) => {
      activeGraphqlCalls++;
      if (activeGraphqlCalls > maxConcurrentGraphqlCalls) {
        maxConcurrentGraphqlCalls = activeGraphqlCalls;
      }
      // Small async gap so concurrent calls accumulate if fired together
      await new Promise((r) => setTimeout(r, 5));
      activeGraphqlCalls--;
      return { search: { issueCount: 0 } };
    };

    const mockOctokit = {
      users: {
        getAuthenticated: async () => ({
          data: { login: 'testuser', avatar_url: 'https://example.com/a.jpg' },
        }),
      },
      graphql: trackingGraphql,
    };

    const deps: HandlerDependencies = {
      getUserOctokit: () => mockOctokit as any,
      getOctokitForUser: async () => mockOctokit as any,
      getCachedToken: () => 'mock-token',
      getGitHubConnectionType: () => 'oauth',
      handleGitHubApiError: () => false,
    };

    handler = new UserHandler(deps, null);
  });

  it('fires at most 1 concurrent GitHub search call (sequential, not Promise.all)', async () => {
    const req = makeReq();
    const capture = makeRes();

    await handler.handleGetUserTaskStats(req, capture.res);

    expect(capture.statusCode).toBe(200);
    // After fix: max concurrent = 1 (serialized); before fix = 3 (Promise.all)
    expect(maxConcurrentGraphqlCalls).toBe(1);
  });
});

// ---------- TEST 3: RepoHandler search retries on secondary rate-limit ------

describe('RepoHandler: search retries users.getAuthenticated on secondary rate-limit', () => {
  let handler: RepoHandler;
  let getAuthenticatedCallCount: number;

  beforeEach(() => {
    getAuthenticatedCallCount = 0;

    const mockOctokit = {
      users: {
        getAuthenticated: async () => {
          getAuthenticatedCallCount++;
          if (getAuthenticatedCallCount === 1) {
            // First call: transient secondary rate-limit
            throw makeSecondaryRateLimitError();
          }
          // Second call: success
          return { data: { login: 'testuser', avatar_url: 'https://example.com/a.jpg' } };
        },
      },
      orgs: {
        listForAuthenticatedUser: async () => ({ data: [] }),
      },
      search: {
        repos: async () => ({
          data: { items: [], total_count: 0 },
          headers: {},
        }),
      },
    };

    const deps: HandlerDependencies = {
      getUserOctokit: () => mockOctokit as any,
      getOctokitForUser: async () => mockOctokit as any,
      getCachedToken: () => 'mock-token',
      getGitHubConnectionType: () => 'oauth',
      handleGitHubApiError: () => false,
    };

    handler = new RepoHandler(
      new MockReposCacheService() as any,
      null, // repoViewTracker
      null, // chatService
      deps
    );
  });

  it('recovers from a transient secondary rate-limit on getAuthenticated and returns repos', async () => {
    const req = makeReq({ query: { search: 'myrepo' } });
    const capture = makeRes();

    await handler.handleListRepos(req, capture.res);

    // After fix: retries → second call succeeds → 200 with repos array
    // Before fix: no retry → first call fails → 500
    expect(capture.statusCode).toBe(200);
    expect(capture.body).toBeDefined();
    expect(Array.isArray(capture.body.repos)).toBe(true);
    // getAuthenticated should have been called twice (once failing, once succeeding)
    expect(getAuthenticatedCallCount).toBe(2);
  });
});
