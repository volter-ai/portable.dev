/**
 * GitHub API Lifecycle Tests - Issue Management Workflow
 *
 * THE STORY: "Project manager organizing sprint work"
 *
 * Scenario Type: Issue tracking and task management
 * User: Sarah (project manager coordinating development team)
 *
 * Sarah is the project manager for a development team. It's Monday morning and
 * she needs to prepare for the sprint planning meeting. She opens her task
 * dashboard to see all the issues and tasks across her projects. She needs to
 * filter by priority labels, check which issues are assigned to whom, and
 * update statuses based on last week's progress.
 *
 * She starts by viewing all her assigned tasks to get an overview. Then she
 * opens a specific high-priority bug that needs to be addressed this sprint.
 * After reviewing the issue details, she assigns it to a developer, updates
 * the milestone, and adds relevant labels. She also creates comments to provide
 * context for the team. Finally, she checks her task statistics to report on
 * team velocity in the sprint planning meeting.
 *
 * REAL SERVICES:
 * - ✅ GitHubApiService - GitHub API operations
 * - ✅ ConnectionsService - GitHub connection management
 * - ✅ ReposCacheService - Repository caching
 * - ✅ DbAdapter - REAL local SQLite database
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

      graphql = mock(async (query: string, variables: any) => {
        // Per-repo tasks query (tasks scoped to locally cloned repos). Must be
        // checked BEFORE the closedIssues/pullRequests branches
        // since the per-repo query contains those field names too.
        if (query.includes('repo0:') || query.includes('TaskIssueFields')) {
          return {
            viewer: { login: 'sarah', avatarUrl: 'https://github.com/sarah.png' },
            repo0: {
              nameWithOwner: 'testorg/payment-service',
              issues: {
                nodes: [
                  {
                    number: 15,
                    title: 'Critical bug in payment gateway',
                    state: 'OPEN',
                    createdAt: new Date(Date.now() - 86400000).toISOString(),
                    updatedAt: new Date().toISOString(),
                    closedAt: null,
                    body: 'Payment gateway issue',
                    url: 'https://github.com/testorg/payment-service/issues/15',
                    comments: { totalCount: 3 },
                    labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
                    assignees: {
                      nodes: [{ login: 'sarah', avatarUrl: 'https://github.com/sarah.png' }],
                    },
                    author: { login: 'reporter', avatarUrl: 'https://github.com/reporter.png' },
                    milestone: null,
                    repository: {
                      nameWithOwner: 'testorg/payment-service',
                      owner: { login: 'testorg', avatarUrl: 'https://github.com/testorg.png' },
                      name: 'payment-service',
                    },
                  },
                ],
              },
              pullRequests: { nodes: [] },
              closedIssues: { nodes: [] },
            },
          };
        }

        // Check if this is closedIssues query
        if (query.includes('closedIssues:')) {
          return {
            viewer: {
              closedIssues: {
                nodes: [],
                totalCount: 0,
              },
            },
          };
        }

        // Check if this is GetUserTasks query (openIssues)
        if (query.includes('openIssues:') || query.includes('pullRequests')) {
          return {
            viewer: {
              login: 'sarah',
              avatarUrl: 'https://github.com/sarah.png',
              openIssues: {
                nodes: [
                  {
                    number: 15,
                    title: 'Critical bug in payment gateway',
                    state: 'OPEN',
                    createdAt: new Date(Date.now() - 86400000).toISOString(),
                    updatedAt: new Date().toISOString(),
                    closedAt: null,
                    body: 'Payment gateway issue',
                    url: 'https://github.com/testorg/payment-service/issues/15',
                    comments: { totalCount: 3 },
                    labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
                    assignees: {
                      nodes: [{ login: 'sarah', avatarUrl: 'https://github.com/sarah.png' }],
                    },
                    author: { login: 'reporter', avatarUrl: 'https://github.com/reporter.png' },
                    milestone: null,
                    repository: {
                      nameWithOwner: 'testorg/payment-service',
                      owner: { login: 'testorg', avatarUrl: 'https://github.com/testorg.png' },
                      name: 'payment-service',
                    },
                  },
                ],
                totalCount: 1,
              },
              pullRequests: {
                nodes: [],
                totalCount: 0,
              },
            },
          };
        }

        // Exact issue-count query (replaces deprecated REST search)
        if (query.includes('CountIssues')) {
          return {
            repository: {
              issues: {
                totalCount: 1,
              },
            },
          };
        }

        // Free-text issue title search (GraphQL search, type: ISSUE)
        if (query.includes('SearchIssues')) {
          return {
            search: {
              issueCount: 1,
              nodes: [
                {
                  number: 15,
                  title: 'Critical bug in payment gateway',
                  state: 'OPEN',
                  createdAt: new Date(Date.now() - 86400000).toISOString(),
                  updatedAt: new Date().toISOString(),
                  closedAt: null,
                  body: 'Payment gateway issue',
                  url: 'https://github.com/testorg/payment-service/issues/15',
                  comments: { totalCount: 3 },
                  labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
                  assignees: { nodes: [] },
                  author: { login: 'reporter', avatarUrl: 'https://github.com/reporter.png' },
                  milestone: null,
                },
              ],
            },
          };
        }

        // Default fallback for other queries
        return {
          viewer: {
            repositories: {
              nodes: [],
            },
          },
        };
      });

      users = {
        getAuthenticated: mock(async () => {
          return {
            data: {
              login: 'sarah',
              id: 123456,
              avatar_url: 'https://github.com/sarah.png',
              name: 'Sarah',
              email: 'sarah@example.com',
            },
          };
        }),
      };

      issues = {
        listForAuthenticatedUser: mock(async (params: any) => {
          return {
            data: [
              {
                id: 1001,
                number: 15,
                title: 'Critical bug in payment gateway',
                state: 'open',
                user: { login: 'reporter', avatar_url: 'https://github.com/reporter.png' },
                labels: [{ name: 'bug' }, { name: 'high-priority' }],
                assignees: [],
                milestone: null,
                created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
                updated_at: new Date().toISOString(),
                html_url: 'https://github.com/testorg/payment-service/issues/15',
                repository: {
                  name: 'payment-service',
                  owner: { login: 'testorg' },
                },
              },
              {
                id: 1002,
                number: 23,
                title: 'Add dark mode support',
                state: 'open',
                user: { login: 'designer', avatar_url: 'https://github.com/designer.png' },
                labels: [{ name: 'enhancement' }, { name: 'ui' }],
                assignees: [{ login: 'sarah', avatar_url: 'https://github.com/sarah.png' }],
                milestone: { title: 'Sprint 12' },
                created_at: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
                updated_at: new Date().toISOString(),
                html_url: 'https://github.com/testorg/frontend/issues/23',
                repository: {
                  name: 'frontend',
                  owner: { login: 'testorg' },
                },
              },
            ],
          };
        }),
        listForRepo: mock(async (params: any) => {
          return {
            data: [
              {
                number: 15,
                title: 'Critical bug in payment gateway',
                state: 'open',
                user: { login: 'reporter', avatar_url: 'https://github.com/reporter.png' },
                labels: [{ name: 'bug' }, { name: 'high-priority' }],
                assignees: [],
                milestone: null,
                created_at: new Date(Date.now() - 86400000).toISOString(),
                updated_at: new Date().toISOString(),
                html_url: 'https://github.com/testorg/payment-service/issues/15',
              },
            ],
          };
        }),
        get: mock(async (params: any) => {
          return {
            data: {
              number: 15,
              title: 'Critical bug in payment gateway',
              state: 'open',
              body: 'Payment gateway returns 500 error when processing refunds over $1000. This is blocking customer service from processing large refunds.',
              user: { login: 'reporter', avatar_url: 'https://github.com/reporter.png' },
              labels: [{ name: 'bug' }, { name: 'high-priority' }],
              assignees: [],
              milestone: null,
              created_at: new Date(Date.now() - 86400000).toISOString(),
              updated_at: new Date().toISOString(),
              html_url: 'https://github.com/testorg/payment-service/issues/15',
            },
          };
        }),
        update: mock(async (params: any) => {
          return {
            data: {
              number: 15,
              title: params.title || 'Critical bug in payment gateway',
              state: params.state || 'open',
              labels: params.labels || [{ name: 'bug' }, { name: 'high-priority' }],
              assignees: [{ login: 'dev-alice', avatar_url: 'https://github.com/alice.png' }],
              milestone: params.milestone ? { title: 'Sprint 12' } : null,
            },
          };
        }),
        addAssignees: mock(async (params: any) => {
          return {
            data: {
              number: 15,
              assignees: params.assignees.map((login: string) => ({
                login,
                avatar_url: `https://github.com/${login}.png`,
              })),
            },
          };
        }),
        removeAssignees: mock(async (params: any) => {
          return {
            data: {
              number: 15,
              assignees: [],
            },
          };
        }),
        createComment: mock(async (params: any) => {
          return {
            data: {
              id: 789456,
              body: params.body,
              user: { login: 'sarah', avatar_url: 'https://github.com/sarah.png' },
              created_at: new Date().toISOString(),
              html_url: 'https://github.com/testorg/payment-service/issues/15#issuecomment-789456',
            },
          };
        }),
        listEventsForTimeline: mock(async (params: any) => {
          return {
            data: [],
          };
        }),
        listComments: mock(async (params: any) => {
          return {
            data: [],
          };
        }),
      };

      rest = {
        issues: {
          listEventsForTimeline: mock(async (params: any) => {
            return {
              data: [],
            };
          }),
        },
      };

      paginate = mock(async (method: any, params: any) => {
        return [];
      });

      search = {
        issuesAndPullRequests: mock(async (params: any) => {
          return {
            data: {
              total_count: 1,
              items: [
                {
                  number: 15,
                  title: 'Critical bug in payment gateway',
                  state: 'open',
                  user: { login: 'reporter', avatar_url: 'https://github.com/reporter.png' },
                  labels: [{ name: 'bug' }, { name: 'high-priority' }],
                  assignees: [],
                  milestone: null,
                  created_at: new Date(Date.now() - 86400000).toISOString(),
                  updated_at: new Date().toISOString(),
                  html_url: 'https://github.com/testorg/payment-service/issues/15',
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

describe.skipIf(isCI)('GitHub API Lifecycle - Issue Management Workflow', () => {
  let gitHubApiService: GitHubApiService;
  let connectionsService: ConnectionsService;
  let reposCacheService: ReposCacheService;
  let dbAdapter: DbAdapter;

  let testUserId: string;
  let authToken: string;

  const TEST_GITHUB_TOKEN = 'ghp_test_token_sarah_123456789';

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
      username: 'sarah',
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

  it("should handle Sarah's sprint planning issue management workflow", async () => {
    /**
     * SCENARIO: Sarah prepares for sprint planning meeting
     * Step 1: View all assigned tasks to get overview
     * Step 2: View repository-specific issues to focus on critical bugs
     * Step 3: Open specific high-priority bug for details
     * Step 4: Update issue with milestone and labels
     * Step 5: Assign issue to developer
     * Step 6: Add comment with context for the team
     * Step 7: Remove assignee if reassigning
     * Step 8: Check task statistics for sprint planning
     */

    /**
     * STEP 1: Sarah views all her assigned tasks across projects
     */
    const mockReq1 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      query: {
        filter: 'assigned',
        state: 'open',
        per_page: '20',
        page: '1',
      },
      // Tasks are scoped to locally cloned repos.
      gitLocalService: {
        getLocalRepositories: async () => [
          { full_name: 'testorg/payment-service', localPath: '/tmp/testorg/payment-service' },
        ],
      },
    } as unknown as Request;

    const mockRes1 = {
      status: mock((code: number) => mockRes1),
      json: mock((data: any) => mockRes1),
      send: mock((data: any) => mockRes1),
    } as unknown as Response;

    await gitHubApiService.handleGetUserTasks(mockReq1, mockRes1);

    /**
     * ASSERTION 1: Tasks should be returned
     */
    expect(mockRes1.json).toHaveBeenCalled();

    const tasksResponse = (mockRes1.json as any).mock.calls[0][0];
    expect(tasksResponse).toBeDefined();
    expect(tasksResponse.open_issues).toBeDefined();
    expect(Array.isArray(tasksResponse.open_issues)).toBe(true);
    expect(tasksResponse.open_issues.length).toBeGreaterThan(0);

    const task = tasksResponse.open_issues[0];
    expect(task).toBeDefined();
    expect(task.number).toBe(15);
    expect(task.title).toBe('Critical bug in payment gateway');

    /**
     * STEP 2: Sarah views issues for payment-service repository
     */
    const mockReq2 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service' },
      query: {
        state: 'open',
        labels: 'bug,high-priority',
        per_page: '20',
        page: '1',
      },
    } as unknown as Request;

    const mockRes2 = {
      status: mock((code: number) => mockRes2),
      json: mock((data: any) => mockRes2),
      send: mock((data: any) => mockRes2),
    } as unknown as Response;

    await gitHubApiService.handleGetIssues(mockReq2, mockRes2);

    /**
     * ASSERTION 2: Repository issues should be returned
     */
    expect(mockRes2.json).toHaveBeenCalled();

    const issuesResponse = (mockRes2.json as any).mock.calls[0][0];
    expect(issuesResponse).toBeDefined();
    expect(issuesResponse.issues).toBeDefined();
    expect(Array.isArray(issuesResponse.issues)).toBe(true);

    const criticalBug = issuesResponse.issues[0];
    expect(criticalBug.number).toBe(15);
    expect(criticalBug.title).toBe('Critical bug in payment gateway');

    /**
     * STEP 3: Sarah opens the specific bug to read details
     */
    const mockReq3 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service', issue_number: '15' },
    } as unknown as Request;

    const mockRes3 = {
      status: mock((code: number) => mockRes3),
      json: mock((data: any) => mockRes3),
      send: mock((data: any) => mockRes3),
    } as unknown as Response;

    await gitHubApiService.handleGetIssue(mockReq3, mockRes3);

    /**
     * ASSERTION 3: Issue details should be returned with timeline
     */
    expect(mockRes3.json).toHaveBeenCalled();

    const issueDetails = (mockRes3.json as any).mock.calls[0][0];
    expect(issueDetails).toBeDefined();
    expect(issueDetails.issue).toBeDefined();
    expect(issueDetails.timeline).toBeDefined();
    expect(issueDetails.issue.number).toBe(15);
    expect(issueDetails.issue.body).toContain('Payment gateway');

    /**
     * STEP 4: Sarah updates the issue with milestone and labels
     */
    const mockReq4 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service', issue_number: '15' },
      body: {
        milestone: 1, // Sprint 12
        labels: ['bug', 'high-priority', 'sprint-12'],
      },
    } as unknown as Request;

    const mockRes4 = {
      status: mock((code: number) => mockRes4),
      json: mock((data: any) => mockRes4),
      send: mock((data: any) => mockRes4),
    } as unknown as Response;

    await gitHubApiService.handleUpdateIssue(mockReq4, mockRes4);

    /**
     * ASSERTION 4: Issue should be updated
     */
    expect(mockRes4.json).toHaveBeenCalled();

    const updatedIssue = (mockRes4.json as any).mock.calls[0][0];
    expect(updatedIssue).toBeDefined();
    expect(updatedIssue.milestone).toBeDefined();

    /**
     * STEP 5: Sarah assigns the issue to a developer
     */
    const mockReq5 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service', issue_number: '15' },
      body: { assignees: ['dev-alice'] },
    } as unknown as Request;

    const mockRes5 = {
      status: mock((code: number) => mockRes5),
      json: mock((data: any) => mockRes5),
      send: mock((data: any) => mockRes5),
    } as unknown as Response;

    await gitHubApiService.handleAddAssignees(mockReq5, mockRes5);

    /**
     * ASSERTION 5: Assignees should be added
     */
    expect(mockRes5.json).toHaveBeenCalled();

    const assigneesResponse = (mockRes5.json as any).mock.calls[0][0];
    expect(assigneesResponse).toBeDefined();
    expect(assigneesResponse.assignees).toBeDefined();
    expect(assigneesResponse.assignees.length).toBeGreaterThan(0);

    /**
     * STEP 6: Sarah adds a comment with context
     */
    const mockReq6 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service', issue_number: '15' },
      body: {
        body: '@dev-alice This is blocking customer service. Please prioritize this for Sprint 12. Let me know if you need any help!',
      },
    } as unknown as Request;

    const mockRes6 = {
      status: mock((code: number) => mockRes6),
      json: mock((data: any) => mockRes6),
      send: mock((data: any) => mockRes6),
    } as unknown as Response;

    await gitHubApiService.handleCreateComment(mockReq6, mockRes6);

    /**
     * ASSERTION 6: Comment should be created
     */
    expect(mockRes6.json).toHaveBeenCalled();

    const commentResponse = (mockRes6.json as any).mock.calls[0][0];
    expect(commentResponse).toBeDefined();
    expect(commentResponse.success).toBe(true);
    expect(commentResponse.comment).toBeDefined();
    expect(commentResponse.comment.body).toContain('@dev-alice');

    /**
     * STEP 7: Sarah can remove assignees if reassigning
     */
    const mockReq7 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'payment-service', issue_number: '15' },
      body: { assignees: ['old-dev'] },
    } as unknown as Request;

    const mockRes7 = {
      status: mock((code: number) => mockRes7),
      json: mock((data: any) => mockRes7),
      send: mock((data: any) => mockRes7),
    } as unknown as Response;

    await gitHubApiService.handleRemoveAssignees(mockReq7, mockRes7);

    /**
     * ASSERTION 7: Assignees should be removed
     */
    expect(mockRes7.json).toHaveBeenCalled();

    /**
     * STEP 8: Sarah checks task statistics for sprint planning (using cached endpoint)
     */
    const mockReq8 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      query: {
        filter: 'all',
      },
      gitLocalService: {
        getLocalRepositories: async () => [
          { full_name: 'testorg/payment-service', localPath: '/tmp/testorg/payment-service' },
        ],
      },
    } as unknown as Request;

    const mockRes8 = {
      status: mock((code: number) => mockRes8),
      json: mock((data: any) => mockRes8),
      send: mock((data: any) => mockRes8),
    } as unknown as Response;

    await gitHubApiService.handleGetUserTasksCached(mockReq8, mockRes8);

    /**
     * ASSERTION 8: Cached tasks should be returned
     */
    expect(mockRes8.json).toHaveBeenCalled();

    /**
     * FINAL VERIFICATION: Sarah successfully organized sprint work
     * ✅ Reviewed all assigned tasks across projects
     * ✅ Filtered repository-specific high-priority issues
     * ✅ Examined critical bug details
     * ✅ Updated issue with sprint milestone and labels
     * ✅ Assigned issue to appropriate developer
     * ✅ Added context comment for the team
     * ✅ Can manage assignees as needed
     * ✅ Checked task statistics for sprint planning
     *
     * Sarah is now ready for the sprint planning meeting with complete task overview!
     */
    console.log("✅ Sarah's sprint planning issue management workflow completed successfully");
    console.log('📊 All issues organized and assigned for Sprint 12');
  });

  it('should handle task refresh and statistics workflows', async () => {
    /**
     * Tests the refresh endpoint and statistics endpoint
     * Coverage: handleGetUserTasksRefresh, handleGetUserTaskStats
     */

    /**
     * Test handleGetUserTasksRefresh
     */
    const mockReq1 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      query: {
        filter: 'assigned',
        state: 'open',
      },
      gitLocalService: {
        getLocalRepositories: async () => [
          { full_name: 'testorg/payment-service', localPath: '/tmp/testorg/payment-service' },
        ],
      },
    } as unknown as Request;

    const mockRes1 = {
      status: mock((code: number) => mockRes1),
      json: mock((data: any) => mockRes1),
      send: mock((data: any) => mockRes1),
    } as unknown as Response;

    await gitHubApiService.handleGetUserTasksRefresh(mockReq1, mockRes1);

    /**
     * ASSERTION: Refreshed tasks should be returned
     */
    expect(mockRes1.json).toHaveBeenCalled();

    /**
     * Test handleGetUserTaskStats
     */
    const mockReq2 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      query: {},
    } as unknown as Request;

    const mockRes2 = {
      status: mock((code: number) => mockRes2),
      json: mock((data: any) => mockRes2),
      send: mock((data: any) => mockRes2),
    } as unknown as Response;

    await gitHubApiService.handleGetUserTaskStats(mockReq2, mockRes2);

    /**
     * ASSERTION: Task statistics should be returned
     */
    expect(mockRes2.json).toHaveBeenCalled();

    console.log('✅ Task refresh and statistics workflows tested successfully');
  });
});
