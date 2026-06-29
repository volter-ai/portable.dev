/**
 * GitHub API Lifecycle Tests - Workflow Management
 *
 * THE STORY: "DevOps engineer automating CI/CD workflow setup"
 *
 * Scenario Type: GitHub Actions workflow file management
 * User: Mike (DevOps engineer setting up automated deployments)
 *
 * Mike is the DevOps engineer responsible for setting up CI/CD pipelines for
 * new projects. He receives a request to add automated deployments for a new
 * microservice. He needs to create a GitHub Actions workflow file, configure
 * secrets for deployment credentials, test the workflow by triggering it
 * manually, and then iterate on the configuration based on test results.
 *
 * He starts by listing existing workflows to understand the current setup.
 * Then he creates a new workflow file for the deployment pipeline. After
 * creating the file, he needs to add deployment secrets to the repository.
 * He triggers the workflow manually to test it, reviews the results, and
 * updates the workflow file with optimizations. Finally, if needed, he can
 * delete old/unused workflow files to keep the repository clean.
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

      graphql = mock(async () => {
        return {
          viewer: {
            repositories: {
              nodes: [],
            },
          },
        };
      });

      request = mock(async (route: string, options?: any) => {
        if (route === 'GET /user') {
          return {
            data: {
              login: 'mike',
              id: 123456,
              avatar_url: 'https://github.com/mike.png',
            },
            headers: {
              'x-oauth-scopes': 'repo, workflow, admin:repo_hook',
            },
          };
        }
        return { data: {}, headers: {} };
      });

      actions = {
        listRepoWorkflows: mock(async (params: any) => {
          return {
            data: {
              total_count: 3,
              workflows: [
                {
                  id: 1234567,
                  name: 'CI/CD Pipeline',
                  path: '.github/workflows/ci-cd.yml',
                  state: 'active',
                  created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
                  updated_at: new Date().toISOString(),
                  badge_url:
                    'https://github.com/testorg/microservice/workflows/CI%2FCD%20Pipeline/badge.svg',
                },
                {
                  id: 2345678,
                  name: 'Deploy to Production',
                  path: '.github/workflows/deploy.yml',
                  state: 'active',
                  created_at: new Date(Date.now() - 14 * 86400000).toISOString(),
                  updated_at: new Date(Date.now() - 86400000).toISOString(),
                  badge_url:
                    'https://github.com/testorg/microservice/workflows/Deploy%20to%20Production/badge.svg',
                },
                {
                  id: 3456789,
                  name: 'Old Workflow',
                  path: '.github/workflows/old-workflow.yml',
                  state: 'disabled_manually',
                  created_at: new Date(Date.now() - 180 * 86400000).toISOString(),
                  updated_at: new Date(Date.now() - 90 * 86400000).toISOString(),
                  badge_url:
                    'https://github.com/testorg/microservice/workflows/Old%20Workflow/badge.svg',
                },
              ],
            },
          };
        }),
        createWorkflowDispatch: mock(async (params: any) => {
          // Workflow dispatch doesn't return data, just 204 No Content
          return { status: 204 };
        }),
        getRepoPublicKey: mock(async (params: any) => {
          // Return a mock public key for secret encryption
          // Generate a valid libsodium keypair and return the public key
          const sodium = await import('sodium-native');
          const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
          const secretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
          sodium.crypto_box_keypair(publicKey, secretKey);

          return {
            data: {
              key_id: 'key-id-12345',
              key: publicKey.toString('base64'), // Valid libsodium public key
            },
          };
        }),
        createOrUpdateRepoSecret: mock(async (params: any) => {
          // Create/update secret (no return data)
          return { status: 201 };
        }),
        listWorkflowRuns: mock(async (params: any) => {
          return {
            data: {
              total_count: 25,
              workflow_runs: [
                {
                  id: 9876543210,
                  name: 'Deploy to Staging',
                  head_branch: 'main',
                  head_sha: 'abc123def456',
                  run_number: 42,
                  event: 'push',
                  status: 'completed',
                  conclusion: 'success',
                  workflow_id: params.workflow_id,
                  created_at: new Date(Date.now() - 3600000).toISOString(),
                  updated_at: new Date(Date.now() - 3500000).toISOString(),
                  run_started_at: new Date(Date.now() - 3600000).toISOString(),
                  html_url: `https://github.com/${params.owner}/${params.repo}/actions/runs/9876543210`,
                  actor: {
                    login: 'mike',
                    avatar_url: 'https://github.com/mike.png',
                  },
                },
                {
                  id: 9876543209,
                  name: 'Deploy to Staging',
                  head_branch: 'develop',
                  head_sha: 'def789ghi012',
                  run_number: 41,
                  event: 'workflow_dispatch',
                  status: 'completed',
                  conclusion: 'failure',
                  workflow_id: params.workflow_id,
                  created_at: new Date(Date.now() - 7200000).toISOString(),
                  updated_at: new Date(Date.now() - 7100000).toISOString(),
                  run_started_at: new Date(Date.now() - 7200000).toISOString(),
                  html_url: `https://github.com/${params.owner}/${params.repo}/actions/runs/9876543209`,
                  actor: {
                    login: 'mike',
                    avatar_url: 'https://github.com/mike.png',
                  },
                },
              ],
            },
          };
        }),
      };

      repos = {
        getContent: mock(async (params: any) => {
          const path = params.path;

          if (path === '.github/workflows/deploy.yml') {
            return {
              data: {
                type: 'file',
                encoding: 'base64',
                size: 1234,
                name: 'deploy.yml',
                path: '.github/workflows/deploy.yml',
                content: Buffer.from(
                  `name: Deploy to Production
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to production
        env:
          DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
        run: |
          echo "Deploying to production..."
          ./scripts/deploy.sh
`
                ).toString('base64'),
                sha: 'abc123def456',
                url: 'https://api.github.com/repos/testorg/microservice/contents/.github/workflows/deploy.yml',
                html_url:
                  'https://github.com/testorg/microservice/blob/main/.github/workflows/deploy.yml',
              },
            };
          }

          // Handle .github/workflows directory check (used by ensureWorkflowDirectory)
          if (path === '.github/workflows') {
            // Simulate 404 - directory doesn't exist yet (will be created automatically)
            const error: any = new Error('Not Found');
            error.status = 404;
            throw error;
          }

          // Default mock for file not found
          const error: any = new Error('Not Found');
          error.status = 404;
          throw error;
        }),
        createOrUpdateFileContents: mock(async (params: any) => {
          return {
            data: {
              content: {
                name: params.path.split('/').pop(),
                path: params.path,
                sha: 'new-sha-' + Date.now(),
                size: Buffer.from(params.content, 'base64').length,
                type: 'file',
              },
              commit: {
                sha: 'commit-sha-' + Date.now(),
                message: params.message,
                author: {
                  name: 'Mike',
                  email: 'mike@example.com',
                  date: new Date().toISOString(),
                },
              },
            },
          };
        }),
        deleteFile: mock(async (params: any) => {
          return {
            data: {
              commit: {
                sha: 'delete-commit-' + Date.now(),
                message: params.message,
                author: {
                  name: 'Mike',
                  email: 'mike@example.com',
                  date: new Date().toISOString(),
                },
              },
            },
          };
        }),
        get: mock(async (params: any) => {
          return {
            data: {
              id: 123456,
              name: 'microservice',
              full_name: 'testorg/microservice',
              owner: { login: 'testorg' },
              private: true,
              description: 'A microservice for payment processing',
              html_url: 'https://github.com/testorg/microservice',
              default_branch: 'main',
              size: 1024, // Non-zero size means repository has commits
              permissions: {
                admin: true,
                push: true,
                pull: true,
              },
            },
          };
        }),
        getPublicKey: mock(async (params: any) => {
          // Return a mock public key for secret encryption
          return {
            data: {
              key_id: 'key-id-12345',
              key: 'mock-public-key-base64-encoded',
            },
          };
        }),
      };

      actions_addRepositorySecret = mock(async (params: any) => {
        // Create/update secret (no return data)
        return { status: 201 };
      });
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

describe.skipIf(isCI)('GitHub API Lifecycle - Workflow Management', () => {
  let gitHubApiService: GitHubApiService;
  let connectionsService: ConnectionsService;
  let reposCacheService: ReposCacheService;
  let dbAdapter: DbAdapter;

  let testUserId: string;
  let authToken: string;

  const TEST_GITHUB_TOKEN = 'ghp_test_token_mike_123456789';

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
      username: 'mike',
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
        scopes: ['repo', 'workflow', 'admin:repo_hook'],
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

  it("should handle Mike's CI/CD workflow setup workflow", async () => {
    /**
     * SCENARIO: Mike sets up automated deployment for new microservice
     * Step 1: List existing workflows to understand current setup
     * Step 2: Get existing workflow file content as template
     * Step 3: Create new workflow file for deployment pipeline
     * Step 4: Add deployment secrets to repository
     * Step 5: Trigger workflow manually to test
     * Step 6: Update workflow file with optimizations
     * Step 7: Delete old unused workflow file
     */

    /**
     * STEP 1: Mike lists existing workflows to understand current setup
     */
    const mockReq1 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      query: {},
    } as unknown as Request;

    const mockRes1 = {
      status: mock((code: number) => mockRes1),
      json: mock((data: any) => mockRes1),
      send: mock((data: any) => mockRes1),
    } as unknown as Response;

    await gitHubApiService.listWorkflows(mockReq1, mockRes1);

    /**
     * ASSERTION 1: Workflows list should be returned
     */
    expect(mockRes1.json).toHaveBeenCalled();

    const workflowsResponse = (mockRes1.json as any).mock.calls[0][0];
    expect(workflowsResponse).toBeDefined();
    expect(workflowsResponse.workflows).toBeDefined();
    expect(Array.isArray(workflowsResponse.workflows)).toBe(true);
    expect(workflowsResponse.workflows.length).toBe(3);

    const activeWorkflow = workflowsResponse.workflows.find(
      (w: any) => w.name === 'CI/CD Pipeline'
    );
    expect(activeWorkflow).toBeDefined();
    expect(activeWorkflow.state).toBe('active');

    /**
     * STEP 2: Mike gets existing workflow file content to use as template
     */
    const mockReq2 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      query: { path: '.github/workflows/deploy.yml' },
    } as unknown as Request;

    const mockRes2 = {
      status: mock((code: number) => mockRes2),
      json: mock((data: any) => mockRes2),
      send: mock((data: any) => mockRes2),
    } as unknown as Response;

    await gitHubApiService.getWorkflowFile(mockReq2, mockRes2);

    /**
     * ASSERTION 2: Workflow file content should be returned
     */
    expect(mockRes2.json).toHaveBeenCalled();

    const workflowFileResponse = (mockRes2.json as any).mock.calls[0][0];
    expect(workflowFileResponse).toBeDefined();
    expect(workflowFileResponse.content).toBeDefined();
    expect(workflowFileResponse.content).toContain('Deploy to Production');
    expect(workflowFileResponse.content).toContain('workflow_dispatch');
    expect(workflowFileResponse.sha).toBeDefined();

    /**
     * STEP 3: Mike creates new workflow file for automated deployment
     */
    const newWorkflowContent = `name: Deploy to Staging
on:
  push:
    branches: [develop]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        default: 'staging'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to staging
        env:
          DEPLOY_KEY: \${{ secrets.STAGING_DEPLOY_KEY }}
          AWS_ACCESS_KEY: \${{ secrets.AWS_ACCESS_KEY }}
        run: |
          echo "Deploying to staging environment..."
          ./scripts/deploy-staging.sh
`;

    const mockReq3 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      body: {
        path: '.github/workflows/deploy-staging.yml',
        content: newWorkflowContent,
        message: 'Add automated staging deployment workflow',
        branch: 'main',
      },
    } as unknown as Request;

    const mockRes3 = {
      status: mock((code: number) => mockRes3),
      json: mock((data: any) => mockRes3),
      send: mock((data: any) => mockRes3),
    } as unknown as Response;

    await gitHubApiService.createWorkflowFile(mockReq3, mockRes3);

    /**
     * ASSERTION 3: Workflow file should be created
     */
    expect(mockRes3.json).toHaveBeenCalled();

    const createResponse = (mockRes3.json as any).mock.calls[0][0];
    expect(createResponse).toBeDefined();
    expect(createResponse.content).toBeDefined();
    expect(createResponse.content.path).toBe('.github/workflows/deploy-staging.yml');
    expect(createResponse.commit).toBeDefined();
    expect(createResponse.commit.message).toContain('automated staging deployment');

    /**
     * STEP 4: Mike adds deployment secrets to repository
     */
    const mockReq4 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      body: {
        secret_name: 'STAGING_DEPLOY_KEY',
        secret_value: 'super-secret-deploy-key-12345',
      },
    } as unknown as Request;

    const mockRes4 = {
      status: mock((code: number) => mockRes4),
      json: mock((data: any) => mockRes4),
      send: mock((data: any) => mockRes4),
    } as unknown as Response;

    await gitHubApiService.createOrUpdateRepoSecret(mockReq4, mockRes4);

    /**
     * ASSERTION 4: Secret should be created
     */
    expect(mockRes4.json).toHaveBeenCalled();

    const secretResponse = (mockRes4.json as any).mock.calls[0][0];
    expect(secretResponse).toBeDefined();
    expect(secretResponse.success).toBe(true);
    expect(secretResponse.message).toContain('Secret STAGING_DEPLOY_KEY');

    // Add AWS secret as well
    const mockReq4b = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      body: {
        secret_name: 'AWS_ACCESS_KEY',
        secret_value: 'aws-access-key-67890',
      },
    } as unknown as Request;

    const mockRes4b = {
      status: mock((code: number) => mockRes4b),
      json: mock((data: any) => mockRes4b),
      send: mock((data: any) => mockRes4b),
    } as unknown as Response;

    await gitHubApiService.createOrUpdateRepoSecret(mockReq4b, mockRes4b);

    expect(mockRes4b.json).toHaveBeenCalled();

    /**
     * STEP 5: Mike triggers the workflow manually to test it
     */
    const mockReq5 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice', workflow_id: 'deploy-staging.yml' },
      body: {
        ref: 'main',
        inputs: {
          environment: 'staging',
        },
      },
    } as unknown as Request;

    const mockRes5 = {
      status: mock((code: number) => mockRes5),
      json: mock((data: any) => mockRes5),
      send: mock((data: any) => mockRes5),
    } as unknown as Response;

    await gitHubApiService.triggerWorkflowDispatch(mockReq5, mockRes5);

    /**
     * ASSERTION 5: Workflow should be triggered
     */
    expect(mockRes5.json).toHaveBeenCalled();

    const triggerResponse = (mockRes5.json as any).mock.calls[0][0];
    expect(triggerResponse).toBeDefined();
    expect(triggerResponse.success).toBe(true);
    expect(triggerResponse.message).toContain('Workflow triggered');

    /**
     * STEP 5.5: Mike checks workflow runs to verify the workflow started
     */
    const mockReq5b = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: {
        owner: 'testorg',
        repo: 'microservice',
        workflow_id: 'deploy-staging.yml',
      },
      query: { per_page: '10', page: '1' },
    } as unknown as Request;

    const mockRes5b = {
      status: mock((code: number) => mockRes5b),
      json: mock((data: any) => mockRes5b),
      send: mock((data: any) => mockRes5b),
    } as unknown as Response;

    await gitHubApiService.listWorkflowRuns(mockReq5b, mockRes5b);

    /**
     * ASSERTION 5.5: Workflow runs should be listed
     */
    expect(mockRes5b.json).toHaveBeenCalled();

    const runsResponse = (mockRes5b.json as any).mock.calls[0][0];
    expect(runsResponse).toBeDefined();
    expect(runsResponse.total_count).toBe(25);
    expect(runsResponse.workflow_runs).toBeDefined();
    expect(Array.isArray(runsResponse.workflow_runs)).toBe(true);

    // Verify run structure shows workflow execution history
    const latestRun = runsResponse.workflow_runs[0];
    expect(latestRun.name).toBe('Deploy to Staging');
    expect(latestRun.status).toBe('completed');

    /**
     * STEP 6: Mike updates workflow file with optimizations based on test results
     */
    const optimizedWorkflowContent = `name: Deploy to Staging
on:
  push:
    branches: [develop]
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy to'
        required: true
        default: 'staging'

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'
      - name: Deploy to staging
        env:
          DEPLOY_KEY: \${{ secrets.STAGING_DEPLOY_KEY }}
          AWS_ACCESS_KEY: \${{ secrets.AWS_ACCESS_KEY }}
        run: |
          echo "Deploying to staging environment..."
          npm run build
          ./scripts/deploy-staging.sh
`;

    const mockReq6 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      body: {
        path: '.github/workflows/deploy-staging.yml',
        content: optimizedWorkflowContent,
        message: 'Optimize staging deployment workflow with caching and timeout',
        branch: 'main',
        sha: 'previous-file-sha',
      },
    } as unknown as Request;

    const mockRes6 = {
      status: mock((code: number) => mockRes6),
      json: mock((data: any) => mockRes6),
      send: mock((data: any) => mockRes6),
    } as unknown as Response;

    await gitHubApiService.updateWorkflowFile(mockReq6, mockRes6);

    /**
     * ASSERTION 6: Workflow file should be updated
     */
    expect(mockRes6.json).toHaveBeenCalled();

    const updateResponse = (mockRes6.json as any).mock.calls[0][0];
    expect(updateResponse).toBeDefined();
    expect(updateResponse.content).toBeDefined();
    expect(updateResponse.commit).toBeDefined();
    expect(updateResponse.commit.message).toContain('Optimize');

    /**
     * STEP 7: Mike deletes old unused workflow file to clean up
     */
    const mockReq7 = {
      userId: testUserId,
      session: { userEmail: testUserId, authToken } as any,
      params: { owner: 'testorg', repo: 'microservice' },
      body: {
        path: '.github/workflows/old-workflow.yml',
        message: 'Remove deprecated workflow file',
        branch: 'main',
        sha: 'old-file-sha',
      },
    } as unknown as Request;

    const mockRes7 = {
      status: mock((code: number) => mockRes7),
      json: mock((data: any) => mockRes7),
      send: mock((data: any) => mockRes7),
    } as unknown as Response;

    await gitHubApiService.deleteWorkflowFile(mockReq7, mockRes7);

    /**
     * ASSERTION 7: Workflow file should be deleted
     */
    expect(mockRes7.json).toHaveBeenCalled();

    const deleteResponse = (mockRes7.json as any).mock.calls[0][0];
    expect(deleteResponse).toBeDefined();
    expect(deleteResponse.commit).toBeDefined();
    expect(deleteResponse.commit.message).toContain('deprecated workflow');

    /**
     * FINAL VERIFICATION: Mike successfully set up automated deployment
     * ✅ Listed existing workflows to understand current setup
     * ✅ Got workflow file content to use as template
     * ✅ Created new staging deployment workflow
     * ✅ Added deployment secrets to repository
     * ✅ Triggered workflow manually to test
     * ✅ Updated workflow with optimizations
     * ✅ Cleaned up old unused workflow files
     *
     * The automated staging deployment pipeline is now fully operational!
     */
    console.log("✅ Mike's CI/CD workflow setup completed successfully");
    console.log('🚀 Automated staging deployment pipeline is operational');
    console.log('🔐 Deployment secrets configured securely');
  });
});
