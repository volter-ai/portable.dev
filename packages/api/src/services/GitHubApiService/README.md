# GitHubApiService - Modular Architecture

This directory contains the refactored GitHubApiService, split into a modular structure using Dependency Injection pattern.

## Architecture

```
GitHubApiService/
├── index.ts                 # Main service class (facade pattern)
├── GitHubConnectionError.ts # Custom error class
├── types.ts                 # Shared TypeScript types
├── handlers/                # Specialized domain handlers
│   ├── RepoHandler.ts       # Repository operations
│   ├── ContentHandler.ts    # File content operations
│   ├── IssueHandler.ts      # Issue management
│   ├── PullRequestHandler.ts# Pull request operations
│   ├── ActionHandler.ts     # GitHub Actions/Workflows
│   ├── BranchHandler.ts     # Branch operations
│   └── UserHandler.ts       # User profile & tasks
└── utils/                   # Shared utilities
    ├── GitHubUtils.ts       # GitHub API utilities
    └── GitLocalUtils.ts     # Local git operations
```

## Design Patterns

### 1. Facade Pattern

The main `GitHubApiService` class acts as a facade, providing a simple interface to complex subsystems (handlers).

### 2. Delegation Pattern

Instead of a monolithic class with 5000+ lines, the service delegates operations to specialized handlers based on domain.

### 3. Dependency Injection

Handlers receive their dependencies through constructors:

- `HandlerDependencies` interface provides shared methods (getUserOctokit, etc.)
- Service-specific dependencies (caches, trackers) are injected individually

## Backward Compatibility

The refactoring maintains 100% backward compatibility:

- Same constructor signature
- All public methods preserved
- Event listeners unchanged
- Import path unchanged (re-exported from ./GitHubApiService.ts)

## Verified Methods

All 46 public methods have been verified:

**Repository Operations:**

- handleListRepos, handleListReposCached, handleListReposRefresh
- handleGetRepo, handleGetTree
- getSimpleReposList, handleGetGitStatus

**Content Operations:**

- handleGetContents, handleGetRawContent
- handleUpdateContents, handleUpdateGitHubContents
- handleServeVideo, handleServeImage

**Issue Operations:**

- handleGetIssues, handleGetIssue
- handleCreateComment, handleUpdateIssue
- handleAddAssignees, handleRemoveAssignees

**Pull Request Operations:**

- handleGetPulls, handleGetPull
- handleRequestReviewers, handleRemoveRequestedReviewers

**Actions/Workflow Operations:**

- handleGetActionsRuns, handleGetWorkflowRun
- listWorkflows, getWorkflowFile, createWorkflowFile, updateWorkflowFile, deleteWorkflowFile
- triggerWorkflowDispatch, listWorkflowRuns
- createOrUpdateRepoSecret

**Branch Operations:**

- handleGetBranches, handleGetCommits

**User Operations:**

- handleGetUserProfile, handleGetUserOrganizations
- handleGetRecentBranches, handleGetCollaborators
- handleGetUserTasks, handleGetUserTasksCached, handleGetUserTasksRefresh
- handleGetUserTaskStats

**Token Management:**

- initialize, loadTokenForUser, getCachedToken

## Benefits

1. **Maintainability**: ~300 lines per file instead of 5000
2. **Testability**: Each handler can be tested in isolation
3. **Scalability**: Easy to add new handlers without touching existing code
4. **Clarity**: Clear separation of concerns by domain
5. **Reusability**: Handlers can be reused or extended independently

## Migration Notes

No migration needed! The old import path still works:

```typescript
import { GitHubApiService } from './services/GitHubApiService.js';
```

The actual implementation is now in `./services/GitHubApiService/index.ts` but this is transparent to consumers.
