/**
 * UserHandler tasks — locally-cloned-repo scoping
 *
 * The Task tab used to scan the user's WHOLE GitHub account
 * (`viewer.issues`/`viewer.pullRequests`), the slow first-open spinner. It now
 * scopes to the repositories the user has CLONED into their sandbox workspace
 * (a fast filesystem scan via GitLocalService), via ONE per-repo GraphQL query.
 *
 * These are DB-free unit tests: `UserHandler` is constructed directly with a
 * fake `HandlerDependencies` + a stub Octokit, and `req.gitLocalService` stands
 * in for the api-routes middleware that attaches GitLocalService in production.
 */

import { describe, it, expect } from 'bun:test';
import type { Request, Response } from 'express';

import { UserHandler } from '../../src/services/GitHubApiService/handlers/UserHandler.js';
import type { HandlerDependencies } from '../../src/services/GitHubApiService/types.js';

const LOGIN = 'octocat';
const AVATAR = 'https://avatars.example.com/octocat';
const HELLO_REPO = {
  nameWithOwner: 'octocat/hello-world',
  owner: { login: 'octocat', avatarUrl: 'https://avatars.example.com/octocat' },
  name: 'hello-world',
};
const SPEC_REPO = {
  nameWithOwner: 'octocat/spec',
  owner: { login: 'octocat', avatarUrl: 'https://avatars.example.com/octocat' },
  name: 'spec',
};

function isoNow(): string {
  return new Date().toISOString();
}

function issueNode(overrides: Record<string, any> = {}): any {
  return {
    number: 1,
    title: 'An issue',
    state: 'OPEN',
    createdAt: isoNow(),
    updatedAt: isoNow(),
    closedAt: null,
    body: '',
    url: 'https://github.com/octocat/hello-world/issues/1',
    comments: { totalCount: 0 },
    labels: { nodes: [] },
    assignees: { nodes: [{ login: LOGIN, avatarUrl: AVATAR }] },
    author: { login: 'reporter', avatarUrl: 'https://avatars.example.com/reporter' },
    milestone: null,
    repository: HELLO_REPO,
    ...overrides,
  };
}

function prNode(overrides: Record<string, any> = {}): any {
  return {
    number: 100,
    title: 'A pull request',
    state: 'OPEN',
    isDraft: false,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    closedAt: null,
    mergedAt: null,
    body: '',
    url: 'https://github.com/octocat/hello-world/pull/100',
    additions: 1,
    deletions: 0,
    comments: { totalCount: 0 },
    reviews: { totalCount: 0 },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { totalCount: 1 },
    labels: { nodes: [] },
    author: { login: LOGIN, avatarUrl: AVATAR },
    assignees: { nodes: [] },
    headRefName: 'feature',
    baseRefName: 'main',
    repository: HELLO_REPO,
    ...overrides,
  };
}

interface HandlerCalls {
  graphqlQueries: string[];
  getAuthenticated: number;
  localReposFor: string[];
}

function makeHandler(opts: {
  localRepos: Array<{ full_name: string; localPath: string }> | undefined;
  graphqlImpl?: (query: string, vars?: any) => any;
}): { handler: UserHandler; calls: HandlerCalls } {
  const calls: HandlerCalls = { graphqlQueries: [], getAuthenticated: 0, localReposFor: [] };

  const mockOctokit = {
    users: {
      getAuthenticated: async () => {
        calls.getAuthenticated++;
        return { data: { login: LOGIN, avatar_url: AVATAR } };
      },
    },
    graphql: async (query: string, vars?: any) => {
      calls.graphqlQueries.push(query);
      return opts.graphqlImpl
        ? opts.graphqlImpl(query, vars)
        : { viewer: { login: LOGIN, avatarUrl: AVATAR } };
    },
  };

  const deps: HandlerDependencies = {
    getUserOctokit: () => mockOctokit as any,
    getOctokitForUser: async () => mockOctokit as any,
    getCachedToken: () => 'mock-token',
    getGitHubConnectionType: () => 'oauth',
    handleGitHubApiError: () => false,
  };

  const handler = new UserHandler(deps, null);

  // Attach the gitLocalService the way the api-routes middleware does in prod.
  (handler as any).__gitLocalService =
    opts.localRepos === undefined
      ? undefined
      : {
          getLocalRepositories: async (userId: string) => {
            calls.localReposFor.push(userId);
            return opts.localRepos;
          },
        };

  return { handler, calls };
}

function makeReq(handler: UserHandler, view: string): Request {
  return {
    session: { userEmail: 'octocat@example.com', authToken: 'mock-token' },
    query: { view },
    params: {},
    gitLocalService: (handler as any).__gitLocalService,
  } as unknown as Request;
}

function makeRes(): { res: Response; statusCode: number; body: any } {
  const capture = { res: undefined as any, statusCode: 200, body: undefined as any };
  capture.res = {
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
  return capture;
}

describe('UserHandler tasks — local-repo scoping', () => {
  it('my view: scopes to cloned repos, keeps assigned issues + only authored PRs', async () => {
    const { handler, calls } = makeHandler({
      localRepos: [
        { full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' },
        { full_name: 'octocat/spec', localPath: '/ws/octocat/spec' },
      ],
      graphqlImpl: () => ({
        viewer: { login: LOGIN, avatarUrl: AVATAR },
        repo0: {
          nameWithOwner: 'octocat/hello-world',
          issues: { nodes: [issueNode({ number: 1, title: 'Hello bug' })] },
          pullRequests: {
            nodes: [
              prNode({ number: 10, author: { login: LOGIN, avatarUrl: AVATAR } }),
              prNode({ number: 11, author: { login: 'someone-else', avatarUrl: '' } }),
            ],
          },
          closedIssues: { nodes: [] },
        },
        repo1: {
          nameWithOwner: 'octocat/spec',
          issues: {
            nodes: [issueNode({ number: 2, title: 'Spec issue', repository: SPEC_REPO })],
          },
          pullRequests: { nodes: [] },
          closedIssues: { nodes: [] },
        },
      }),
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.view).toBe('my');
    expect(capture.body.noLocalRepos).toBe(false);
    expect(capture.body.error).toBeUndefined();

    // Issues from BOTH cloned repos.
    expect(capture.body.open_issues.map((i: any) => i.number).sort()).toEqual([1, 2]);
    // PRs: only the one authored by the viewer (#10); #11 (someone-else) dropped.
    expect(capture.body.prs.map((p: any) => p.number)).toEqual([10]);
    expect(capture.body.total_open).toBe(2);
    expect(capture.body.total_prs).toBe(1);
    expect(capture.body.user).toEqual({ login: LOGIN, avatar_url: AVATAR });

    // The GraphQL query is scoped per-repo (NOT the full-account viewer query)
    // and assignee-filters the OPEN issues for the `my` view.
    const query = calls.graphqlQueries[0];
    expect(query).toContain('repository(owner: "octocat", name: "hello-world")');
    expect(query).toContain('repository(owner: "octocat", name: "spec")');
    expect(query).toContain(
      'states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, filterBy: {assignee: $login}'
    );
    expect(query).not.toContain('openIssues:');
    // The filesystem scan ran for this user.
    expect(calls.localReposFor).toEqual(['octocat@example.com']);
  });

  it('all view: returns every open issue + PR (no author filter, no assignee filter)', async () => {
    const { handler, calls } = makeHandler({
      localRepos: [{ full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' }],
      graphqlImpl: () => ({
        viewer: { login: LOGIN, avatarUrl: AVATAR },
        repo0: {
          nameWithOwner: 'octocat/hello-world',
          issues: {
            nodes: [
              // Not assigned to the viewer — `all` still includes it.
              issueNode({ number: 3, assignees: { nodes: [{ login: 'other', avatarUrl: '' }] } }),
            ],
          },
          pullRequests: {
            nodes: [
              prNode({ number: 20, author: { login: LOGIN, avatarUrl: AVATAR } }),
              prNode({ number: 21, author: { login: 'someone-else', avatarUrl: '' } }),
            ],
          },
          closedIssues: { nodes: [] },
        },
      }),
    });

    const req = makeReq(handler, 'all');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.view).toBe('all');
    expect(capture.body.noLocalRepos).toBe(false);
    expect(capture.body.open_issues.map((i: any) => i.number)).toEqual([3]);
    // Both PRs — `all` does NOT filter by author.
    expect(capture.body.prs.map((p: any) => p.number).sort()).toEqual([20, 21]);

    const query = calls.graphqlQueries[0];
    // `all` open issues have NO assignee filter; only closedIssues are assignee-filtered.
    expect(query).not.toContain(
      'states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, filterBy: {assignee: $login}'
    );
    expect(query).toContain('states: CLOSED, filterBy: {assignee: $login}');
  });

  it('Done Today: keeps closed-today issues, drops older closed issues', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const { handler } = makeHandler({
      localRepos: [{ full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' }],
      graphqlImpl: () => ({
        viewer: { login: LOGIN, avatarUrl: AVATAR },
        repo0: {
          nameWithOwner: 'octocat/hello-world',
          issues: { nodes: [] },
          pullRequests: { nodes: [] },
          closedIssues: {
            nodes: [
              issueNode({ number: 50, state: 'CLOSED', closedAt: isoNow() }),
              issueNode({ number: 51, state: 'CLOSED', closedAt: twoDaysAgo }),
            ],
          },
        },
      }),
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.body.closed_today.map((i: any) => i.number)).toEqual([50]);
    expect(capture.body.total_closed_today).toBe(1);
  });

  it('no cloned repos: returns noLocalRepos:true and never queries GitHub', async () => {
    const { handler, calls } = makeHandler({ localRepos: [] });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.noLocalRepos).toBe(true);
    expect(capture.body.open_issues).toEqual([]);
    expect(capture.body.closed_today).toEqual([]);
    expect(capture.body.prs).toEqual([]);
    expect(capture.body.total_open).toBe(0);
    expect(capture.body.user).toEqual({ login: LOGIN, avatar_url: AVATAR });
    // The expensive cross-account GraphQL query is NEVER issued.
    expect(calls.graphqlQueries.length).toBe(0);
    // getAuthenticated still ran (cheap; needed for the user ref).
    expect(calls.getAuthenticated).toBe(1);
  });

  it('missing gitLocalService (defensive): degrades to noLocalRepos:true', async () => {
    const { handler, calls } = makeHandler({ localRepos: undefined });

    const req = makeReq(handler, 'my'); // gitLocalService is undefined
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.noLocalRepos).toBe(true);
    expect(calls.graphqlQueries.length).toBe(0);
  });

  // --- locally-created (local/*) projects + partial GraphQL data ---

  it('excludes locally-created (local/*) projects from the GraphQL query', async () => {
    const { handler, calls } = makeHandler({
      localRepos: [
        { full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' },
        // A project made in-sandbox (`createLocalFolder` → owner `local`, no GitHub remote).
        { full_name: 'local/greeting', localPath: '/ws/local/greeting' },
      ],
      graphqlImpl: () => ({
        viewer: { login: LOGIN, avatarUrl: AVATAR },
        repo0: {
          nameWithOwner: 'octocat/hello-world',
          issues: { nodes: [issueNode({ number: 1, title: 'Hello bug' })] },
          pullRequests: { nodes: [] },
          closedIssues: { nodes: [] },
        },
      }),
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.error).toBeUndefined();
    expect(capture.body.noLocalRepos).toBe(false);
    expect(capture.body.open_issues.map((i: any) => i.number)).toEqual([1]);

    // The non-GitHub `local/*` project is NEVER sent to GitHub GraphQL — otherwise
    // GitHub answers "Could not resolve to a Repository" and fails the whole query.
    const query = calls.graphqlQueries[0];
    expect(query).toContain('repository(owner: "octocat", name: "hello-world")');
    expect(query).not.toContain('owner: "local"');
    expect(query).not.toContain('greeting');
  });

  it('only locally-created projects: returns noLocalRepos:true and never queries GitHub', async () => {
    const { handler, calls } = makeHandler({
      localRepos: [{ full_name: 'local/greeting', localPath: '/ws/local/greeting' }],
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.noLocalRepos).toBe(true);
    expect(capture.body.open_issues).toEqual([]);
    // No GitHub query is issued — the only cloned repo was a local project.
    expect(calls.graphqlQueries.length).toBe(0);
  });

  it('partial GraphQL data: returns tasks from resolved repos when some aliases fail', async () => {
    const { handler } = makeHandler({
      localRepos: [
        { full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' },
        { full_name: 'octocat/deleted-on-github', localPath: '/ws/octocat/deleted-on-github' },
      ],
      graphqlImpl: () => {
        // GitHub returns partial data + a top-level errors array; Octokit throws a
        // GraphqlResponseError that STILL carries `.data` for the resolved aliases.
        const err: any = new Error(
          "Request failed due to following response errors:\n - Could not resolve to a Repository with the name 'octocat/deleted-on-github'."
        );
        err.data = {
          viewer: { login: LOGIN, avatarUrl: AVATAR },
          repo0: {
            nameWithOwner: 'octocat/hello-world',
            issues: { nodes: [issueNode({ number: 7, title: 'Still here' })] },
            pullRequests: { nodes: [] },
            closedIssues: { nodes: [] },
          },
          repo1: null, // the unresolvable repo
        };
        throw err;
      },
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    // The resolved repo's tasks survive; the whole Tasks page is NOT blanked.
    expect(capture.body.open_issues.map((i: any) => i.number)).toEqual([7]);
    expect(capture.body.noLocalRepos).toBe(false);
    // No error surfaced to the client — we used the partial data.
    expect(capture.body.error).toBeUndefined();
  });

  it('total GraphQL failure (no partial data): returns empty arrays + error', async () => {
    const { handler } = makeHandler({
      localRepos: [{ full_name: 'octocat/hello-world', localPath: '/ws/octocat/hello-world' }],
      graphqlImpl: () => {
        throw new Error('network exploded');
      },
    });

    const req = makeReq(handler, 'my');
    const capture = makeRes();
    await handler.handleGetUserTasksRefresh(req, capture.res);

    expect(capture.statusCode).toBe(200);
    expect(capture.body.open_issues).toEqual([]);
    expect(capture.body.prs).toEqual([]);
    expect(capture.body.error).toBe('network exploded');
  });
});
