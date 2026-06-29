# GitHubApiService Lifecycle Testing Guide

This guide explains how to add lifecycle tests for GitHubApiService, following the same patterns used for ChatService.

## Key Principles

### 1. Tell a Real Story

**DON'T** just list technical steps:

```typescript
// ❌ BAD - No context or motivation
/**
 * THE STORY: "Developer checking repository information"
 * User checks repositories, views details, reads files.
 */
```

**DO** explain WHY and provide context:

```typescript
// ✅ GOOD - Real scenario with motivation
/**
 * THE STORY: "Joining a team project mid-sprint"
 *
 * Alex just got assigned to help a team that's mid-sprint on an urgent bug fix.
 * They need to quickly get oriented with the team's repositories. After connecting
 * their GitHub account to the platform, they pull up their repository list to find
 * the project they've been assigned to...
 */
```

### 2. Test Complete User Flows

Lifecycle tests simulate **complete user journeys**, not individual functions:

- ✅ "Onboarding to a new codebase"
- ✅ "Responding to a production incident"
- ✅ "Code review workflow"
- ❌ "Test getUserOctokit() returns Octokit instance"

### 3. Mock External APIs Only

**REAL Services** (use actual implementations):

- ✅ GitHubApiService
- ✅ ConnectionsService
- ✅ ReposCacheService
- ✅ RepoViewTrackerService
- ✅ SqliteDbAdapter (real local SQLite)
- ✅ TokenAdapter

**MOCKED** (external dependencies only):

- 🔴 @octokit/rest (GitHub API - costs money, rate limits)

## Test Structure

### 1. File Naming

Follow the pattern: `<service>-lifecycle-<scenario>.test.ts`

Examples:

- `github-api-lifecycle-happy-path.test.ts` - Basic success scenarios
- `github-api-lifecycle-error-handling.test.ts` - Error cases
- `github-api-lifecycle-caching.test.ts` - Cache behavior

### 2. Mock Setup

Mock Octokit **BEFORE** importing services:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Mock FIRST, before any imports that use Octokit
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      repos = {
        listForAuthenticatedUser: mock(async (params: any) => ({
          data: [
            /* mock repo data */
          ],
        })),
        get: mock(async (params: any) => ({
          data: {
            /* mock repo details */
          },
        })),
      };

      git = {
        getTree: mock(async (params: any) => ({
          data: {
            tree: [
              /* mock tree */
            ],
          },
        })),
      };
    },
  };
});

// NOW import services
import { GitHubApiService } from '../../../src/services/GitHubApiService';
```

### 3. Test Setup (beforeEach)

```typescript
let gitHubApiService: GitHubApiService;
let connectionsService: ConnectionsService;
let reposCacheService: ReposCacheService;
let repoViewTracker: RepoViewTrackerService;
let dbAdapter: SqliteDbAdapter;
let tokenAdapter: TokenAdapter;

let testUserId: string;
let authToken: string;

const TEST_GITHUB_TOKEN = 'ghp_test_token_123456789';

beforeEach(async () => {
  // 1. Create unique test user
  const { adapter, userId, authToken: token } = await createTestDbAdapter();
  dbAdapter = adapter;
  testUserId = userId;
  authToken = token;

  // 2. Create JWT with GitHub token
  const jwtPayload = {
    sub: testUserId,
    email: `test-${testUserId}@example.com`,
    username: 'testuser',
    GITHUB_TOKEN: TEST_GITHUB_TOKEN,
  };
  tokenAdapter = new TokenAdapter(JSON.stringify(jwtPayload));

  // 3. Create real services
  connectionsService = new ConnectionsService(dbAdapter);
  reposCacheService = new ReposCacheService();
  repoViewTracker = new RepoViewTrackerService(dbAdapter);

  gitHubApiService = new GitHubApiService(
    reposCacheService,
    tokenAdapter,
    connectionsService,
    repoViewTracker
  );

  // 4. Store GitHub connection
  await connectionsService.saveConnection(
    testUserId,
    'github',
    TEST_GITHUB_TOKEN,
    { scopes: ['repo', 'read:org'] },
    authToken
  );

  // 5. Load token into service cache
  await gitHubApiService.loadTokenForUser(testUserId, authToken);
});
```

### 4. Test Cleanup (afterEach)

```typescript
afterEach(async () => {
  // Clean up test data from REAL database
  await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
});
```

### 5. Writing Test Cases

Structure each test as a **story with steps**:

```typescript
it("should handle Alex's team project onboarding workflow", async () => {
  /**
   * SCENARIO: Alex joins team mid-sprint and needs to get oriented
   * Step 1: Fetch repository list to find assigned project
   * Step 2: Open "payment-service" repo to check recent activity
   * Step 3: Explore file tree to understand codebase structure
   * Step 4: Verify repo view tracking for quick access later
   */

  /**
   * STEP 1: Alex fetches repository list to find their assigned project
   */
  const mockReq1 = {
    userId: testUserId,
    query: { page: '1', per_page: '20' },
  } as unknown as Request;

  const mockRes1 = {
    status: mock((code: number) => mockRes1),
    json: mock((data: any) => mockRes1),
  } as unknown as Response;

  await gitHubApiService.handleListRepos(mockReq1, mockRes1);

  /**
   * ASSERTION 1: Response should be successful
   */
  expect(mockRes1.status).toHaveBeenCalledWith(200);

  // ... more steps ...

  /**
   * FINAL VERIFICATION: Alex successfully got oriented with the team project
   * ✅ Found their assigned repository in the list
   * ✅ Checked recent activity and project health
   * ✅ Explored file structure to understand codebase organization
   * ✅ Repo tracked for quick access in "recently viewed"
   *
   * Alex is now ready to start working on their assigned bug fix!
   */
  console.log("✅ Alex's team project onboarding workflow completed successfully");
});
```

## Example User Stories for GitHubApiService

### Happy Path Stories

1. **"Onboarding to a new codebase"** ✅ (implemented)
   - New developer joining team mid-sprint
   - Finding assigned repository
   - Exploring structure before starting work

2. **"Code review workflow"**
   - Developer receives PR notification
   - Opens PR to review changes
   - Checks file diffs
   - Adds review comments
   - Approves/requests changes

3. **"Bug triage workflow"**
   - Developer checks issues assigned to them
   - Filters by labels (bug, high-priority)
   - Opens specific issue to read details
   - Checks related PRs
   - Updates issue status

4. **"Release preparation"**
   - Team lead checking workflow runs
   - Verifying all tests passed
   - Reviewing recent commits
   - Creating release notes

### Error Handling Stories

1. **"Connection failure recovery"**
   - User starts without GitHub connected
   - Gets error message with clear instructions
   - Connects GitHub account
   - Retries and succeeds

2. **"Token expiration handling"**
   - Working with expired GitHub token
   - API returns 401 error
   - User prompted to reconnect
   - Token refreshed, work continues

3. **"Rate limit handling"**
   - Heavy API usage hits rate limit
   - Graceful degradation to cached data
   - User informed of rate limit status
   - Automatic retry after cooldown

### Cache Behavior Stories

1. **"Offline-first repository browsing"**
   - User opens app with cached data
   - Browses repositories without network
   - Refresh triggered when online
   - Cache updated seamlessly

## Testing Different GitHubApiService Methods

### Repository Operations

- `handleListRepos()` - Fetch user repositories
- `handleGetRepo()` - Get repository details
- `handleGetTree()` - Get file tree
- `handleGetContents()` - Read file contents
- `handleGetBranches()` - List branches

### Issue/PR Operations

- `handleGetIssues()` - List issues
- `handleGetIssue()` - Get issue details
- `handleGetPulls()` - List pull requests
- `handleGetPull()` - Get PR details
- `handleCreateComment()` - Add comments

### Workflow Operations

- `listWorkflows()` - List GitHub Actions workflows
- `handleGetActionsRuns()` - Get workflow runs
- `triggerWorkflowDispatch()` - Trigger workflow

### Profile/Social Operations

- `handleGetUserProfile()` - Get user profile
- `handleGetCollaborators()` - List repo collaborators
- `handleGetUserOrganizations()` - List user orgs

## Running Tests

```bash
# Run all lifecycle tests
bun test packages/api/tests/integration/lifecycle/

# Run specific test file
bun test packages/api/tests/integration/lifecycle/github-api-lifecycle-happy-path.test.ts

# Run with debug output
DEBUG=true bun test packages/api/tests/integration/lifecycle/github-api-lifecycle-happy-path.test.ts
```

## Coverage Goals

Each major service should have lifecycle tests covering:

1. **Happy path** (80% of functionality)
   - Primary user flows
   - Common use cases
   - Expected behavior

2. **Error handling** (15% of functionality)
   - Connection failures
   - Invalid inputs
   - Permission errors

3. **Edge cases** (5% of functionality)
   - Empty states
   - Large datasets
   - Concurrent operations

## Best Practices

### ✅ DO

- Write tests that tell a compelling story
- Use real services wherever possible
- Clean up test data in afterEach()
- Mock external APIs (GitHub, Anthropic)
- Add descriptive console.log at end of test
- Wait for async operations to complete
- Test complete user journeys

### ❌ DON'T

- Test individual functions in isolation
- Skip database cleanup
- Hard-code user IDs or tokens
- Mock internal services unnecessarily
- Write tests without context/story
- Forget to wait for async operations
- Test implementation details

## Example: Adding a New Test Story

Let's add a "Code Review Workflow" test:

```typescript
it("should handle Maria's code review workflow", async () => {
  /**
   * SCENARIO: Maria receives a PR review request from her team
   *
   * THE STORY: "Urgent hotfix review"
   *
   * Maria is the senior engineer on her team. During lunch, she gets a Slack
   * notification that a critical hotfix PR needs her review before it can be
   * deployed to production. She opens the platform on her phone, navigates to
   * the repository, finds the open PRs, and opens the specific hotfix PR.
   *
   * She reviews the file changes, sees that it's a small but important fix to
   * the payment processing logic. After verifying the logic is correct and tests
   * are included, she adds an approving comment. The PR is now ready to merge
   * and deploy.
   *
   * Step 1: Fetch repository details
   * Step 2: List open pull requests
   * Step 3: Open specific hotfix PR
   * Step 4: Add approval comment
   */
  // ... test implementation following the story ...
});
```

## Summary

Lifecycle tests for GitHubApiService should:

1. **Tell real stories** with motivation and context
2. **Test complete flows** not individual functions
3. **Use real services** except external APIs
4. **Clean up properly** after each test
5. **Follow patterns** from ChatService tests

This ensures our tests are meaningful, maintainable, and actually validate that the service works correctly in real-world scenarios.
