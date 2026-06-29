/**
 * GitHub Search Migration Unit Tests
 *
 * Verifies that issue/PR listing no longer uses the deprecated
 * `search.issuesAndPullRequests` endpoint on the hot path, and that the
 * rate-limit backoff helper retries correctly.
 *
 * Handlers are exercised directly with an injected mock Octokit — no database.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Request, Response } from 'express';

import { IssueHandler } from '../../../src/services/GitHubApiService/handlers/IssueHandler';
import { PullRequestHandler } from '../../../src/services/GitHubApiService/handlers/PullRequestHandler';
import {
  isRateLimitError,
  withGitHubRetry,
} from '../../../src/services/GitHubApiService/utils/GitHubUtils';

function buildRes(): Response & { _json: any } {
  const res: any = {
    _json: undefined,
    status: mock(() => res),
    send: mock(() => res),
    json: mock((data: any) => {
      res._json = data;
      return res;
    }),
  };
  return res;
}

function buildReq(query: Record<string, any>): Request {
  return {
    session: { userEmail: 'user@example.com', authToken: 'jwt' },
    params: { owner: 'octo', repo: 'demo' },
    query,
  } as unknown as Request;
}

describe('GitHub search migration', () => {
  let searchSpy: ReturnType<typeof mock>;
  let listForRepoSpy: ReturnType<typeof mock>;
  let listLabelsSpy: ReturnType<typeof mock>;
  let graphqlSpy: ReturnType<typeof mock>;
  let pullsListSpy: ReturnType<typeof mock>;
  let octokit: any;
  let deps: any;

  beforeEach(() => {
    searchSpy = mock(async () => ({ data: { total_count: 0, items: [] } }));
    listForRepoSpy = mock(async () => ({
      // listForRepo returns issues AND pull requests; the PR must be filtered out.
      data: [
        { number: 10, title: 'A real issue', state: 'open' },
        {
          number: 11,
          title: 'A PR masquerading as an issue',
          state: 'open',
          pull_request: { url: 'x' },
        },
      ],
    }));
    graphqlSpy = mock(async (query: string) => {
      if (query.includes('CountIssues')) {
        return { repository: { issues: { totalCount: 42 } } };
      }
      if (query.includes('CountPulls')) {
        return { repository: { pullRequests: { totalCount: 7 } } };
      }
      if (query.includes('SearchIssues')) {
        return {
          search: {
            issueCount: 3,
            nodes: [
              {
                number: 99,
                title: 'searched issue',
                state: 'OPEN',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-02T00:00:00Z',
                closedAt: null,
                body: 'body',
                url: 'https://github.com/octo/demo/issues/99',
                comments: { totalCount: 1 },
                labels: { nodes: [{ name: 'bug', color: 'red' }] },
                assignees: { nodes: [] },
                author: { login: 'octocat', avatarUrl: 'a.png' },
                milestone: null,
              },
            ],
          },
        };
      }
      return {};
    });
    pullsListSpy = mock(async () => ({
      data: [{ number: 5, title: 'PR', state: 'open', head: { ref: 'feat' } }],
    }));

    listLabelsSpy = mock(async () => ({
      data: [
        { id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working" },
        { id: 2, name: 'enhancement', color: 'a2eeef', description: null },
      ],
    }));

    octokit = {
      issues: { listForRepo: listForRepoSpy, listLabelsForRepo: listLabelsSpy },
      pulls: { list: pullsListSpy },
      repos: { get: mock(async () => ({ data: { default_branch: 'main' } })) },
      search: { issuesAndPullRequests: searchSpy },
      graphql: graphqlSpy,
    };

    deps = {
      getUserOctokit: () => octokit,
      getOctokitForUser: async () => octokit,
      getCachedToken: () => 'tok',
      getGitHubConnectionType: () => 'oauth',
      handleGitHubApiError: () => false,
    };
  });

  it('default issue list uses listForRepo + GraphQL count, never the deprecated search', async () => {
    const handler = new IssueHandler(deps);
    const res = buildRes();

    await handler.handleGetIssues(buildReq({ state: 'open', per_page: '10', page: '1' }), res);

    expect(listForRepoSpy).toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    // PR is filtered out, only the real issue remains
    expect(res._json.issues).toHaveLength(1);
    expect(res._json.issues[0].number).toBe(10);
    // Exact count comes from the GraphQL query
    expect(res._json.total_count).toBe(42);
  });

  it('free-text issue search uses GraphQL search, never the deprecated search', async () => {
    const handler = new IssueHandler(deps);
    const res = buildRes();

    await handler.handleGetIssues(
      buildReq({ state: 'open', text: 'crash', per_page: '10', page: '1' }),
      res
    );

    expect(searchSpy).not.toHaveBeenCalled();
    expect(res._json.total_count).toBe(3);
    expect(res._json.issues[0].number).toBe(99);
    expect(res._json.issues[0].state).toBe('open'); // mapped/lowercased
  });

  it('lists repo labels via issues.listLabelsForRepo, mapped to {id,name,color,description}', async () => {
    const handler = new IssueHandler(deps);
    const res = buildRes();

    await handler.handleGetLabels(buildReq({}), res);

    expect(listLabelsSpy).toHaveBeenCalled();
    const callArg = (listLabelsSpy.mock.calls[0] as any[])[0];
    expect(callArg).toMatchObject({ owner: 'octo', repo: 'demo', per_page: 100 });
    expect(res._json.labels).toEqual([
      { id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working" },
      { id: 2, name: 'enhancement', color: 'a2eeef', description: null },
    ]);
  });

  it('PR list count uses GraphQL, never the deprecated search', async () => {
    const handler = new PullRequestHandler(deps);
    const res = buildRes();

    await handler.handleGetPulls(buildReq({ state: 'open', per_page: '10', page: '1' }), res);

    expect(pullsListSpy).toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(res._json.totalCount).toBe(7);
  });
});

describe('withGitHubRetry / isRateLimitError', () => {
  it('detects 403 secondary rate-limit and 429 as rate-limit errors', () => {
    expect(
      isRateLimitError({ status: 403, message: 'You have exceeded a secondary rate limit' })
    ).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ status: 404 })).toBe(false);
    expect(isRateLimitError({ status: 403, message: 'Insufficient scopes' })).toBe(false);
  });

  it('retries on rate-limit then resolves', async () => {
    let calls = 0;
    const result = await withGitHubRetry(
      async () => {
        calls += 1;
        if (calls < 2) {
          const err: any = new Error('secondary rate limit');
          err.status = 403;
          throw err;
        }
        return 'ok';
      },
      { baseDelayMs: 1, retries: 3 }
    );

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry non-rate-limit errors', async () => {
    let calls = 0;
    await expect(
      withGitHubRetry(
        async () => {
          calls += 1;
          const err: any = new Error('not found');
          err.status = 404;
          throw err;
        },
        { baseDelayMs: 1, retries: 3 }
      )
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });
});
