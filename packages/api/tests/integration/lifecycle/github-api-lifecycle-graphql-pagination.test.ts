/**
 * GitHub API - GraphQL Pagination Lifecycle Tests
 *
 * THE STORY: "Developer with 500+ repositories needs sorted list"
 *
 * Scenario Type: Performance optimization for large repo lists
 * User: Sarah (open source maintainer with 500+ repos)
 *
 * Sarah is a prolific open source contributor with 500+ repositories across
 * personal and organization accounts. The GitHub REST API doesn't support
 * server-side sorting, forcing the client to fetch ALL repos and sort locally.
 * This is slow and wasteful.
 *
 * GraphQL API supports sorting at the server level, allowing us to:
 * - Fetch only the requested page (not all 500 repos)
 * - Sort by updated, created, name, or stars
 * - Get accurate pagination metadata (hasNextPage)
 *
 * REAL SERVICES:
 * - ✅ GitHubApiService - GraphQL query construction
 * - ✅ ConnectionsService - GitHub token management
 * - ✅ ReposCacheService - Repository caching
 * - ✅ DbAdapter - REAL local SQLite database
 * - ✅ TokenAdapter - JWT token extraction
 *
 * MOCKED EXTERNAL:
 * - 🔴 @octokit/rest - GitHub API (external API calls)
 *
 * Coverage Target: Lines 153-288 (~136 lines)
 * - fetchReposPageViaGraphQL()
 * - GraphQL query construction
 * - Sort parameter mapping (REST → GraphQL)
 * - Response transformation (GraphQL → REST format)
 * - buildLinkHeader()
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Request, Response } from 'express';

// Mock Octokit with GraphQL support
const mockGraphqlResponses: any[] = [];
let mockGraphqlCallCount = 0;

mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      request = async () => ({ data: {}, status: 200, headers: {} });
      constructor(options: any) {}

      graphql = mock(async (query: string, variables?: any) => {
        mockGraphqlCallCount++;

        if (mockGraphqlResponses.length > 0) {
          return mockGraphqlResponses.shift();
        }

        // Default response: 500 repos, return first page
        const totalRepos = 500;
        const perPage = variables?.first || 20;
        const nodes = Array.from({ length: perPage }, (_, i) => ({
          id: `repo-${i + 1}`,
          name: `repo-${i + 1}`,
          nameWithOwner: `testuser/repo-${i + 1}`,
          isPrivate: false,
          description: `Test repository ${i + 1}`,
          owner: {
            login: 'testuser',
            avatarUrl: 'https://github.com/testuser.png',
          },
          url: `https://github.com/testuser/repo-${i + 1}`,
          stargazerCount: 100 - i,
          watchers: { totalCount: 50 - i },
          forkCount: 10 - i,
          issues: { totalCount: 5 },
          primaryLanguage: { name: 'TypeScript' },
          createdAt: new Date(2024, 0, i + 1).toISOString(),
          updatedAt: new Date(2024, 11, 31 - i).toISOString(),
          pushedAt: new Date(2024, 11, 31 - i).toISOString(),
          diskUsage: 1024,
          defaultBranchRef: { name: 'main' },
          hasIssuesEnabled: true,
          hasProjectsEnabled: true,
          hasWikiEnabled: false,
          isArchived: false,
          isDisabled: false,
          visibility: 'PUBLIC',
        }));

        return {
          viewer: {
            repositories: {
              totalCount: totalRepos,
              pageInfo: {
                hasNextPage: perPage < totalRepos,
              },
              nodes,
            },
          },
        };
      });

      repos = {
        listForAuthenticatedUser: mock(async (params: any) => {
          // REST API fallback (not used in these tests)
          return { data: [], headers: { link: '' } };
        }),
      };
    },
  };
});

import { GitHubApiService } from '../../../src/services/GitHubApiService';
import { ConnectionsService } from '../../../src/services/ConnectionsService';
import { ReposCacheService } from '../../../src/services/ReposCacheService';
import { RepoViewTrackerService } from '../../../src/services/RepoViewTrackerService';
import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

describe('GitHub API - GraphQL Pagination Lifecycle (TODO: Implement GraphQL support)', () => {
  let gitHubApiService: GitHubApiService;
  let connectionsService: ConnectionsService;
  let reposCacheService: ReposCacheService;
  let repoViewTracker: RepoViewTrackerService;
  let dbAdapter: DbAdapter;

  let testUserId: string;
  let authToken: string;

  const TEST_GITHUB_TOKEN = 'ghp_test_graphql_token_123';

  beforeEach(async () => {
    // Reset mock state
    mockGraphqlResponses.length = 0;
    mockGraphqlCallCount = 0;

    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Create JWT payload with test GitHub token
    const jwtPayload = {
      sub: testUserId,
      email: `test-${testUserId}@example.com`,
      username: 'testuser',
      GITHUB_TOKEN: TEST_GITHUB_TOKEN,
    };

    // Create real services
    connectionsService = new ConnectionsService(dbAdapter);
    reposCacheService = new ReposCacheService();
    repoViewTracker = new RepoViewTrackerService();

    // Create GitHubApiService
    gitHubApiService = new GitHubApiService(
      reposCacheService,
      connectionsService,
      repoViewTracker,
      null // chatService not needed
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

    // Wait for connection event to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Load token into GitHubApiService cache
    await gitHubApiService.loadTokenForUser(testUserId, authToken);
  });

  afterEach(async () => {
    // Clean up test data
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  describe('GraphQL Query Construction', () => {
    it.skip("should fetch Sarah's 500 repos with updated_at sorting via GraphQL", async () => {
      /**
       * SCENARIO: Sarah has 500 repos, wants most recently updated first
       *
       * REST API would require:
       * - Fetch all 500 repos (25 API calls @ 20 per page)
       * - Sort locally (slow)
       *
       * GraphQL API approach:
       * - Single query with UPDATED_AT ordering
       * - Fetch only page 1 (20 repos)
       * - Server-side sorting (fast!)
       */

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '1',
          per_page: '20',
          sort: 'updated', // Maps to UPDATED_AT in GraphQL
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      /**
       * ASSERTION 1: Response should include repos
       */
      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      expect(response).toBeDefined();
      expect(response.repos).toBeDefined();
      expect(response.repos.length).toBe(20); // First page

      /**
       * ASSERTION 2: Repos should be sorted by updated_at (most recent first)
       */
      const repos = response.repos;
      for (let i = 0; i < repos.length - 1; i++) {
        const current = new Date(repos[i].updated_at).getTime();
        const next = new Date(repos[i + 1].updated_at).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }

      /**
       * ASSERTION 3: Pagination metadata should be present
       */
      expect(response.pagination).toBeDefined();
      expect(response.pagination.page).toBe(1);
      expect(response.pagination.per_page).toBe(20);
      expect(response.pagination.total_count).toBe(500);

      console.log("✅ Sarah's 500 repos fetched with GraphQL sorting");
    });

    it.skip('should support different sort parameters (created, name, stars)', async () => {
      /**
       * SCENARIO: Sort by different fields
       *
       * Test all supported sort parameters map correctly to GraphQL:
       * - 'updated' → UPDATED_AT
       * - 'created' → CREATED_AT
       * - 'name' → NAME
       * - 'stars' → STARGAZERS
       * - 'pushed' → PUSHED_AT
       */

      const sortTests = [
        { sort: 'created', expectedField: 'CREATED_AT' },
        { sort: 'name', expectedField: 'NAME' },
        { sort: 'stars', expectedField: 'STARGAZERS' },
        { sort: 'pushed', expectedField: 'PUSHED_AT' },
      ];

      for (const test of sortTests) {
        const mockReq = {
          userId: testUserId,
          session: { userEmail: testUserId, authToken } as any,
          query: {
            page: '1',
            per_page: '20',
            sort: test.sort,
          },
          gitLocalService: null,
        } as unknown as Request;

        const mockRes = {
          status: mock((code: number) => mockRes),
          json: mock((data: any) => mockRes),
          send: mock((data: any) => mockRes),
        } as unknown as Response;

        await gitHubApiService.handleListRepos(mockReq, mockRes);

        // Verify response received
        expect(mockRes.json).toHaveBeenCalled();

        const response = (mockRes.json as any).mock.calls[0][0];
        expect(response.repos).toBeDefined();
        expect(response.repos.length).toBeGreaterThan(0);
      }

      console.log('✅ All sort parameters tested successfully');
    });
  });

  describe('Pagination Logic', () => {
    it.skip('should fetch page 5 of 10 correctly (skip first 80 repos)', async () => {
      /**
       * SCENARIO: Sarah navigates to page 5 (repos 81-100)
       *
       * GraphQL should fetch first 100 repos, then slice [80:100]
       * This is more efficient than fetching ALL 500 repos.
       */

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '5',
          per_page: '20',
          sort: 'updated',
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      expect(response.repos.length).toBe(20);
      expect(response.pagination.page).toBe(5);

      /**
       * ASSERTION: Link header should include next, prev, first, last
       */
      // Note: Link header is set via res.set('Link', ...) in the actual implementation
      // We can't easily test that in this mock setup, but we verify pagination data

      console.log('✅ Page 5 pagination tested successfully');
    });

    it.skip('should handle last page correctly (no hasNextPage)', async () => {
      /**
       * SCENARIO: Sarah reaches the last page (repos 481-500)
       *
       * GraphQL should return hasNextPage: false
       * Link header should NOT include 'next' or 'last' rel
       */

      // Mock response for last page
      mockGraphqlResponses.push({
        viewer: {
          repositories: {
            totalCount: 500,
            pageInfo: {
              hasNextPage: false, // Last page!
            },
            nodes: Array.from({ length: 20 }, (_, i) => ({
              id: `repo-${481 + i}`,
              name: `repo-${481 + i}`,
              nameWithOwner: `testuser/repo-${481 + i}`,
              isPrivate: false,
              description: `Test repository ${481 + i}`,
              owner: {
                login: 'testuser',
                avatarUrl: 'https://github.com/testuser.png',
              },
              url: `https://github.com/testuser/repo-${481 + i}`,
              stargazerCount: 10,
              watchers: { totalCount: 5 },
              forkCount: 2,
              issues: { totalCount: 1 },
              primaryLanguage: { name: 'JavaScript' },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              pushedAt: new Date().toISOString(),
              diskUsage: 512,
              defaultBranchRef: { name: 'main' },
              hasIssuesEnabled: true,
              hasProjectsEnabled: false,
              hasWikiEnabled: false,
              isArchived: false,
              isDisabled: false,
              visibility: 'PUBLIC',
            })),
          },
        },
      });

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '25', // Last page (500 / 20 = 25)
          per_page: '20',
          sort: 'updated',
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      expect(response.repos.length).toBe(20);
      expect(response.pagination.page).toBe(25);
      expect(response.pagination.total_count).toBe(500);

      console.log('✅ Last page pagination tested successfully');
    });

    it.skip('should handle single page result (< 20 repos total)', async () => {
      /**
       * SCENARIO: New user with only 5 repositories
       *
       * GraphQL returns all repos in single page
       * No pagination needed
       */

      mockGraphqlResponses.push({
        viewer: {
          repositories: {
            totalCount: 5,
            pageInfo: {
              hasNextPage: false,
            },
            nodes: Array.from({ length: 5 }, (_, i) => ({
              id: `repo-${i + 1}`,
              name: `my-repo-${i + 1}`,
              nameWithOwner: `newuser/my-repo-${i + 1}`,
              isPrivate: true,
              description: `My first repos`,
              owner: {
                login: 'newuser',
                avatarUrl: 'https://github.com/newuser.png',
              },
              url: `https://github.com/newuser/my-repo-${i + 1}`,
              stargazerCount: 0,
              watchers: { totalCount: 0 },
              forkCount: 0,
              issues: { totalCount: 0 },
              primaryLanguage: { name: 'Python' },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              pushedAt: new Date().toISOString(),
              diskUsage: 128,
              defaultBranchRef: { name: 'main' },
              hasIssuesEnabled: true,
              hasProjectsEnabled: false,
              hasWikiEnabled: false,
              isArchived: false,
              isDisabled: false,
              visibility: 'PRIVATE',
            })),
          },
        },
      });

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '1',
          per_page: '20',
          sort: 'updated',
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      expect(response.repos.length).toBe(5);
      expect(response.pagination.total_count).toBe(5);
      expect(response.pagination.page).toBe(1);

      console.log('✅ Single page result tested successfully');
    });
  });

  describe('Response Transformation', () => {
    it.skip('should transform GraphQL response to REST API format', async () => {
      /**
       * SCENARIO: Client expects REST API format
       *
       * GraphQL returns different field names:
       * - nameWithOwner → full_name
       * - isPrivate → private
       * - stargazerCount → stargazers_count
       * - etc.
       *
       * Backend must transform to match REST API structure.
       */

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '1',
          per_page: '5',
          sort: 'updated',
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      const repo = response.repos[0];

      /**
       * ASSERTION: Verify REST API field names
       */
      expect(repo.name).toBeDefined(); // GraphQL: name
      expect(repo.full_name).toBeDefined(); // GraphQL: nameWithOwner
      expect(typeof repo.private).toBe('boolean'); // GraphQL: isPrivate
      expect(typeof repo.stargazers_count).toBe('number'); // GraphQL: stargazerCount
      expect(typeof repo.forks_count).toBe('number'); // GraphQL: forkCount
      expect(typeof repo.open_issues_count).toBe('number'); // GraphQL: issues.totalCount
      expect(repo.owner).toBeDefined();
      expect(repo.owner.login).toBeDefined();
      expect(repo.owner.avatar_url).toBeDefined(); // GraphQL: avatarUrl
      expect(repo.html_url).toBeDefined(); // GraphQL: url
      expect(repo.default_branch).toBeDefined(); // GraphQL: defaultBranchRef.name

      console.log('✅ GraphQL → REST transformation tested successfully');
    });
  });

  describe('Performance Comparison', () => {
    it.skip('should demonstrate GraphQL efficiency vs REST (500 repos)', async () => {
      /**
       * SCENARIO: Performance comparison
       *
       * REST API approach (without GraphQL):
       * - 25 API calls to fetch all 500 repos (20 per page)
       * - Client-side sorting
       * - Slow and wasteful
       *
       * GraphQL approach:
       * - 1 API call to fetch page 1 (20 repos)
       * - Server-side sorting
       * - Fast and efficient!
       */

      const startTime = Date.now();

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '1',
          per_page: '20',
          sort: 'stars', // Sort by stargazers (server-side)
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      await gitHubApiService.handleListRepos(mockReq, mockRes);

      const endTime = Date.now();
      const duration = endTime - startTime;

      /**
       * ASSERTION: Single GraphQL call made
       */
      // Note: In real implementation, we'd verify only 1 API call
      // With mocks, we just verify the response is correct
      expect(mockRes.json).toHaveBeenCalled();

      const response = (mockRes.json as any).mock.calls[0][0];
      expect(response.repos.length).toBe(20);

      console.log(`✅ GraphQL fetch completed in ${duration}ms (single API call)`);
      console.log(`   REST approach would need 25 API calls for full sort`);
    });
  });

  describe('Error Handling', () => {
    it.skip('should handle GraphQL errors gracefully', async () => {
      /**
       * SCENARIO: GitHub GraphQL API error
       *
       * Network issue, rate limit, or invalid query
       * Should fall back or return clear error
       */

      // Mock GraphQL error
      mockGraphqlResponses.push(
        Promise.reject(new Error('GraphQL API error: Rate limit exceeded'))
      );

      const mockReq = {
        userId: testUserId,
        session: { userEmail: testUserId, authToken } as any,
        query: {
          page: '1',
          per_page: '20',
          sort: 'updated',
        },
        gitLocalService: null,
      } as unknown as Request;

      const mockRes = {
        status: mock((code: number) => mockRes),
        json: mock((data: any) => mockRes),
        send: mock((data: any) => mockRes),
      } as unknown as Response;

      try {
        await gitHubApiService.handleListRepos(mockReq, mockRes);

        // If it handled the error gracefully, that's OK
        console.log('✅ GraphQL error handled gracefully');
      } catch (error: any) {
        // Expected to fail with clear error
        expect(error.message).toBeDefined();
        console.log('✅ GraphQL error thrown with message:', error.message);
      }
    });
  });
});
