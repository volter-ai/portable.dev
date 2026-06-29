/**
 * GitHub API Lifecycle Tests - Code Review Workflow
 *
 * THE STORY: "Senior engineer reviewing critical hotfix PR"
 *
 * Scenario Type: Code review and pull request management
 * User: Maria (senior engineer on-call for production support)
 *
 * Maria is the senior engineer on her team. During lunch, she gets a Slack
 * notification that a critical hotfix PR needs her review before it can be
 * deployed to production. The PR fixes a payment processing bug that's causing
 * failed transactions. She needs to quickly review the changes, check the files
 * modified, verify the fix is correct, and approve it so the team can deploy.
 *
 * She opens the platform on her phone, navigates to the repository, sees the
 * open PRs, and opens the specific hotfix PR. She reviews the file changes
 * (examining the diff), checks the commits to understand what changed, and
 * after verifying the logic is correct and tests are included, she adds
 * reviewers and comments to approve the PR for deployment.
 *
 * REAL SERVICES:
 * - ✅ GitHubApiService - GitHub API operations
 * - ✅ ConnectionsService - GitHub connection management
 * - ✅ ReposCacheService - Repository caching
 * - ✅ DbAdapter - REAL PostgreSQL with RLS
 * - ✅ TokenAdapter - JWT token extraction
 *
 * MOCKED EXTERNAL:
 * - 🔴 @octokit/rest - GitHub API (external API calls)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Request, Response } from 'express';

// Mock Octokit (GitHub API client) BEFORE importing services
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      request = async () => ({ data: {}, status: 200, headers: {} });
      constructor(options: any) {
        // Store options for inspection if needed
      }

      graphql = mock(async (query: string) => {
        // Exact PR-count query (replaces deprecated REST search)
        if (typeof query === 'string' && query.includes('CountPulls')) {
          return {
            repository: {
              pullRequests: {
                totalCount: 1,
              },
            },
          };
        }

        return {
          viewer: {
            repositories: {
              nodes: [],
            },
          },
        };
      });

      pulls = {
        list: mock(async (params: any) => {
          return {
            data: [
              {
                number: 42,
                title: 'Fix payment processing bug',
                state: 'open',
                user: { login: 'devuser', avatar_url: 'https://github.com/avatar.png' },
                html_url: 'https://github.com/testuser/test-repo/pull/42',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                draft: false,
                head: { ref: 'hotfix/payment-bug', sha: 'abc123' },
                base: { ref: 'main', sha: 'def456' },
                labels: [{ name: 'hotfix' }, { name: 'high-priority' }],
              },
            ],
          };
        }),
        get: mock(async (params: any) => {
          return {
            data: {
              number: 42,
              title: 'Fix payment processing bug',
              state: 'open',
              body: 'This PR fixes the payment processing bug by adding null checks.',
              user: { login: 'devuser', avatar_url: 'https://github.com/avatar.png' },
              html_url: 'https://github.com/testuser/test-repo/pull/42',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              merged_at: null,
              draft: false,
              head: { ref: 'hotfix/payment-bug', sha: 'abc123' },
              base: { ref: 'main', sha: 'def456' },
              additions: 15,
              deletions: 3,
              changed_files: 2,
              labels: [{ name: 'hotfix' }, { name: 'high-priority' }],
            },
          };
        }),
        listCommits: mock(async (params: any) => {
          return {
            data: [
              {
                sha: 'abc123',
                commit: {
                  message: 'Add null checks to payment processor',
                  author: {
                    name: 'devuser',
                    email: 'dev@example.com',
                    date: new Date().toISOString(),
                  },
                },
                author: { login: 'devuser', avatar_url: 'https://github.com/avatar.png' },
                html_url: 'https://github.com/testuser/test-repo/commit/abc123',
              },
            ],
          };
        }),
        requestReviewers: mock(async (params: any) => {
          return {
            data: {
              number: 42,
              requested_reviewers: [{ login: 'maria', avatar_url: 'https://github.com/maria.png' }],
            },
          };
        }),
        removeRequestedReviewers: mock(async (params: any) => {
          return {
            data: {
              number: 42,
              requested_reviewers: [],
            },
          };
        }),
        listReviewComments: mock(async (params: any) => {
          return {
            data: [
              {
                id: 789,
                body: 'Great fix! LGTM',
                user: { login: 'reviewer1', avatar_url: 'https://github.com/reviewer1.png' },
                created_at: new Date().toISOString(),
                path: 'src/payment.ts',
                line: 42,
              },
            ],
          };
        }),
        listFiles: mock(async (params: any) => {
          return {
            data: [
              {
                filename: 'src/payment.ts',
                status: 'modified',
                additions: 15,
                deletions: 3,
                changes: 18,
                patch: '@@ -10,3 +10,15 @@ function processPayment() {',
              },
              {
                filename: 'tests/payment.test.ts',
                status: 'added',
                additions: 20,
                deletions: 0,
                changes: 20,
              },
            ],
          };
        }),
      };

      issues = {
        createComment: mock(async (params: any) => {
          return {
            data: {
              id: 123456,
              body: params.body,
              user: { login: 'maria', avatar_url: 'https://github.com/maria.png' },
              created_at: new Date().toISOString(),
              html_url: 'https://github.com/testuser/test-repo/pull/42#issuecomment-123456',
            },
          };
        }),
        listComments: mock(async (params: any) => {
          return {
            data: [
              {
                id: 456,
                body: 'Initial review comment',
                user: { login: 'reviewer2', avatar_url: 'https://github.com/reviewer2.png' },
                created_at: new Date().toISOString(),
                html_url: 'https://github.com/testuser/test-repo/pull/42#issuecomment-456',
              },
            ],
          };
        }),
      };

      repos = {
        listCommits: mock(async (params: any) => {
          return {
            data: [
              {
                sha: 'abc123',
                commit: {
                  message: 'Add null checks to payment processor',
                  author: {
                    name: 'devuser',
                    email: 'dev@example.com',
                    date: new Date().toISOString(),
                  },
                },
                author: { login: 'devuser', avatar_url: 'https://github.com/avatar.png' },
                html_url: 'https://github.com/testuser/test-repo/commit/abc123',
              },
            ],
          };
        }),
        get: mock(async (params: any) => {
          return {
            data: {
              id: 123456,
              name: 'test-repo',
              full_name: 'testuser/test-repo',
              owner: { login: 'testuser' },
              private: false,
              description: 'A test repository',
              html_url: 'https://github.com/testuser/test-repo',
              default_branch: 'main',
            },
          };
        }),
      };

      search = {
        issuesAndPullRequests: mock(async (params: any) => {
          return {
            data: {
              items: [
                {
                  number: 42,
                  title: 'Fix payment processing bug',
                  state: 'open',
                  user: { login: 'devuser', avatar_url: 'https://github.com/avatar.png' },
                  html_url: 'https://github.com/testuser/test-repo/pull/42',
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  draft: false,
                  pull_request: {},
                  labels: [{ name: 'hotfix' }, { name: 'high-priority' }],
                },
              ],
            },
          };
        }),
      };
    },
  };
});

import { GitHubApiService } from '../../../src/services/GitHubApiService';
import { ConnectionsService } from '../../../src/services/ConnectionsService';
import { ReposCacheService } from '../../../src/services/ReposCacheService';
import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

// Skip in CI - Octokit module mocking is flaky in CI environment
const isCI = process.env.CI === '1' || process.env.CI === 'true';

describe.skipIf(isCI)('GitHub API Lifecycle - Code Review Workflow', () => {
  let gitHubApiService: GitHubApiService;
  let connectionsService: ConnectionsService;
  let reposCacheService: ReposCacheService;
  let dbAdapter: DbAdapter;

  let testUserId: string;
  let authToken: string;

  const TEST_GITHUB_TOKEN = 'ghp_test_token_maria_123456789';

  beforeEach(async () => {
    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Create JWT payload with test GitHub token
    const jwtPayload = {
      sub: testUserId,
      email: `test-${testUserId}@example.com`,
      username: 'maria',
      GITHUB_TOKEN: TEST_GITHUB_TOKEN,
    };

    // Create real services
    connectionsService = new ConnectionsService(dbAdapter);
    reposCacheService = new ReposCacheService();

    // Create GitHubApiService with real dependencies
    gitHubApiService = new GitHubApiService(
      reposCacheService,
      connectionsService,
      undefined, // repoViewTracker not needed
      undefined // chatService not needed
    );

    // Store GitHub connection in database
    await connectionsService.storeConnection({
      userId: testUserId,
      connectionId: 'github',
      displayName: 'GitHub',
      service: 'github',
      serviceType: 'sdk',
      credentials: {
        token: TEST_GITHUB_TOKEN,
        scopes: ['repo', 'read:org', 'read:user'],
      },
      authToken,
    });

    // Wait for event listener to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Load token into GitHubApiService cache
    await gitHubApiService.loadTokenForUser(testUserId, authToken);
  });

  afterEach(async () => {
    // Clean up test data from REAL database
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  it("should handle Maria's urgent hotfix PR review workflow", async () => {
    /**
     * SCENARIO: Maria reviews critical hotfix PR during lunch break
     * Step 1: List open pull requests to find the hotfix PR
     * Step 2: Open the specific hotfix PR to review details
     * Step 3: Check commits to understand what changed
     * Step 4: Add approval comment
     * Step 5: Request additional reviewers
     * Step 6: Remove reviewers if needed
     */

    /**
     * STEP 1: Maria lists open PRs to find the hotfix
     */
    const mockReq1 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo' },
      query: { state: 'open', per_page: '20', page: '1' },
    } as unknown as Request;

    const mockRes1 = {
      status: mock((code: number) => mockRes1),
      json: mock((data: any) => mockRes1),
      send: mock((data: any) => mockRes1),
    } as unknown as Response;

    await gitHubApiService.handleGetPulls(mockReq1, mockRes1);

    /**
     * ASSERTION 1: PRs list should be returned
     */
    expect(mockRes1.json).toHaveBeenCalled();

    const prsResponse = (mockRes1.json as any).mock.calls[0][0];
    expect(prsResponse).toBeDefined();
    expect(prsResponse.pulls).toBeDefined();
    expect(Array.isArray(prsResponse.pulls)).toBe(true);
    expect(prsResponse.pulls.length).toBeGreaterThan(0);

    const hotfixPR = prsResponse.pulls[0];
    expect(hotfixPR.number).toBe(42);
    expect(hotfixPR.title).toBe('Fix payment processing bug');
    expect(hotfixPR.state).toBe('open');

    /**
     * STEP 2: Maria opens the specific PR to see full details
     */
    const mockReq2 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo', pull_number: '42' },
    } as unknown as Request;

    const mockRes2 = {
      status: mock((code: number) => mockRes2),
      json: mock((data: any) => mockRes2),
      send: mock((data: any) => mockRes2),
    } as unknown as Response;

    await gitHubApiService.handleGetPull(mockReq2, mockRes2);

    /**
     * ASSERTION 2: PR details should be returned
     */
    expect(mockRes2.json).toHaveBeenCalled();

    const prResponse = (mockRes2.json as any).mock.calls[0][0];
    expect(prResponse).toBeDefined();
    expect(prResponse.pr).toBeDefined();
    expect(prResponse.pr.number).toBe(42);
    expect(prResponse.pr.title).toBe('Fix payment processing bug');
    expect(prResponse.pr.body).toContain('null checks');
    expect(prResponse.pr.changed_files).toBe(2);
    expect(prResponse.timeline).toBeDefined();
    expect(prResponse.files).toBeDefined();

    /**
     * STEP 3: Maria checks the commits to understand what changed
     */
    const mockReq3 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo' },
      query: { sha: 'hotfix/payment-bug', per_page: '30', page: '1' },
    } as unknown as Request;

    const mockRes3 = {
      status: mock((code: number) => mockRes3),
      json: mock((data: any) => mockRes3),
      send: mock((data: any) => mockRes3),
    } as unknown as Response;

    await gitHubApiService.handleGetCommits(mockReq3, mockRes3);

    /**
     * ASSERTION 3: Commits should be returned
     */
    expect(mockRes3.json).toHaveBeenCalled();

    const commitsResponse = (mockRes3.json as any).mock.calls[0][0];
    expect(commitsResponse).toBeDefined();
    expect(Array.isArray(commitsResponse)).toBe(true);
    expect(commitsResponse[0].commit.message).toContain('null checks');

    /**
     * STEP 4: Maria adds an approval comment
     */
    const mockReq4 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo', issue_number: '42' },
      body: { body: 'LGTM! ✅ The null checks look good. Approved for production deployment.' },
    } as unknown as Request;

    const mockRes4 = {
      status: mock((code: number) => mockRes4),
      json: mock((data: any) => mockRes4),
      send: mock((data: any) => mockRes4),
    } as unknown as Response;

    await gitHubApiService.handleCreateComment(mockReq4, mockRes4);

    /**
     * ASSERTION 4: Comment should be created
     */
    expect(mockRes4.json).toHaveBeenCalled();

    const commentResponse = (mockRes4.json as any).mock.calls[0][0];
    expect(commentResponse).toBeDefined();
    expect(commentResponse.success).toBe(true);
    expect(commentResponse.comment).toBeDefined();
    expect(commentResponse.comment.body).toContain('LGTM');

    /**
     * STEP 5: Maria requests additional reviewers for double-check
     */
    const mockReq5 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo', pull_number: '42' },
      body: { reviewers: ['senior-dev'] },
    } as unknown as Request;

    const mockRes5 = {
      status: mock((code: number) => mockRes5),
      json: mock((data: any) => mockRes5),
      send: mock((data: any) => mockRes5),
    } as unknown as Response;

    await gitHubApiService.handleRequestReviewers(mockReq5, mockRes5);

    /**
     * ASSERTION 5: Reviewers should be added
     */
    expect(mockRes5.json).toHaveBeenCalled();

    const reviewersResponse = (mockRes5.json as any).mock.calls[0][0];
    expect(reviewersResponse).toBeDefined();
    expect(reviewersResponse.requested_reviewers).toBeDefined();

    /**
     * STEP 6: Maria removes stale reviewer requests if needed
     */
    const mockReq6 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testuser', repo: 'test-repo', pull_number: '42' },
      body: { reviewers: ['old-reviewer'] },
    } as unknown as Request;

    const mockRes6 = {
      status: mock((code: number) => mockRes6),
      json: mock((data: any) => mockRes6),
      send: mock((data: any) => mockRes6),
    } as unknown as Response;

    await gitHubApiService.handleRemoveRequestedReviewers(mockReq6, mockRes6);

    /**
     * ASSERTION 6: Reviewers should be removed
     */
    expect(mockRes6.json).toHaveBeenCalled();

    /**
     * FINAL VERIFICATION: Maria successfully reviewed and approved the hotfix PR
     * ✅ Found the urgent hotfix PR in the open PRs list
     * ✅ Reviewed the PR details and understood the changes
     * ✅ Checked the commits to verify the fix
     * ✅ Added approval comment for deployment
     * ✅ Requested additional reviewers for safety
     * ✅ Managed reviewer requests appropriately
     *
     * The PR is now ready for merge and production deployment!
     */
    console.log("✅ Maria's urgent hotfix PR review workflow completed successfully");
    console.log('🚀 PR #42 approved and ready for production deployment');
  });
});
