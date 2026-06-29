# VGit2 Testing Infrastructure

**Philosophy**: Integration tests only - test complete flows end-to-end, not individual functions.

## Directory Structure

```
tests/
├── README.md                  # This file
├── setup/                     # Test infrastructure ✅ COMPLETE
│   ├── helpers/
│   │   ├── TestEmitter.ts           # IOutputEmitter for testing
│   │   ├── testContext.ts           # ExecutionContext builder
│   │   ├── testDatabase.ts          # Local SQLite test-database helpers
│   │   ├── testClaudeService.ts     # ClaudeService factory
│   │   └── testServer.ts            # Express app factory (no .listen())
│   ├── mocks/
│   │   ├── mockClaudeAgentSDK.ts    # Anthropic API mock
│   │   ├── MockProcessTrackerService.ts
│   │   ├── MockTunnelService.ts
│   │   └── MockReposCacheService.ts # In-memory cache for repos
│   └── fixtures/
│       ├── chats.ts                 # Chat test data
│       ├── messages.ts              # Message test data
│       └── users.ts                 # User test data
│
└── integration/
    ├── lifecycle/
    │   ├── chat-lifecycle-happy-path.test.ts
    │   ├── chat-lifecycle-edge-cases.test.ts
    │   └── chat-lifecycle-settings.test.ts
    │
    ├── routes/               # ⚠️ TODO: HTTP endpoints (supertest)
    │   ├── api-routes.test.ts
    │   ├── auth-routes.test.ts
    │   ├── chat-execution-routes.test.ts
    │   └── middleware.test.ts
    │
    └── database/             # ⚠️ TODO: Database validation
        ├── migrations.test.ts
        ├── rls-policies.test.ts
        └── cascade-behavior.test.ts
```

## Test Categories

### 1. Lifecycle Tests

**Location**: `integration/lifecycle/`

Tests complete hypothetical user flows through a feature. All major features need to have a lifecycle test
All services must be tested through simulating a user scenarios

Examples:

- The story: "Typical brief feature implementation usage: User named George creates a chat in a repo and asks the AI to implement dark mode, the AI implements dark mode. Then the user asks the AI to commit. The AI commits the code. Then the user archives the chat"

---

### 2. Route Tests ✅ COMPLETE

**Location**: `integration/routes/`

Tests HTTP endpoints without running a server (uses **supertest** for in-memory requests). Uses real services where possible:

- RESTful API endpoints (GET, POST, PUT, DELETE)
- Authentication middleware (JWT validation)
- Request validation (body, params, query)
- Error handling (400, 401, 404, 500)

**Coverage**: Express routes, middleware, request/response handling

**Test Files**:

- `api-routes.test.ts` - API endpoints (health, user, chats, repos, connections)
- `auth-routes.test.ts` - Authentication endpoints (OAuth flows, token management)
- `middleware.test.ts` - Middleware behavior (JWT auth, session management, CORS)
- `tunnel-routes.test.ts` - Internal tunnel management endpoints

**Important Notes**:

1. **Session vs JWT Authentication**:
   - Most endpoints use session-based auth (set via `createTestServer({ userEmail })`)
   - Some endpoints (like `/api/user`) require JWT in Authorization header
   - Use `.set('Authorization', `Bearer ${authToken}`)` when needed

2. **Test User IDs**:
   - `testUserId` returned by `createTestDbAdapter()` is already a full email
   - Don't wrap it with additional formatting: use `testUserId` directly

3. **Database Cleanup**:
   - Use `TestDatabaseHelper.getInstance().cleanTestData(testUserId)`
   - Warnings about missing tables (routines, connections) are expected in fresh databases

4. **Test Isolation**:
   - Each test gets a unique timestamped user ID
   - Tests run in parallel safely (each adapter uses its own throwaway temp SQLite dir)

---

### 3. Database Tests ⚠️ TODO

**Location**: `integration/database/`

Tests database schema and integrity:

- Migration application and validation. Make sure migrations are applied without error and the final schema is as expected
- If reverse migration exists, make sure reverse migration works
- `user_id` scoping (single-user filtering enforced by SqliteDbAdapter)

**Coverage**: SQLite schema, migrations, `user_id` scoping

**Prerequisites**: None — every test runs on local SQLite (unique throwaway temp dir per test)

## Key Infrastructure

### TestEmitter

Implements `IOutputEmitter` for capturing events without Socket.IO. Allows assertions on emitted events (claude:stream, claude:status, etc).

### TestContextBuilder

Fluent builder for creating `ExecutionContext` objects with sensible defaults. Auto-generates test data when not specified.

### Real Database Testing

Uses **real local SQLite** (SqliteDbAdapter — the same substrate the PC runtime uses) with `user_id` scoping. Each test gets a unique user ID + its own throwaway temp dir for isolation, so no explicit cleanup is needed.

### Test Server Factory

Creates Express app **without .listen()** for route testing with supertest. Enables in-memory HTTP requests without port binding.

## Test Patterns

### Mock External Services Only

- ✅ REAL: ChatService, ClaudeService, SqliteDbAdapter, GitLocalService, GitHubApiService, etc.
- 🔴 MOCKED: @anthropic-ai/claude-agent-sdk, @octokit/rest, Clerk API, MockTunnelService, MockProcessTrackerService, MockReposCacheService

### Test Isolation

- Each test gets unique test user ID
- Automatic cleanup in afterEach()
- Independent test database per user
- No shared state between tests

### Async Persistence

Wait for async operations to complete before assertions:

```typescript
await executionService.executeMessage(...);
await new Promise(resolve => setTimeout(resolve, 200)); // Wait for persistence
const messages = await chatService.getMessages(chatId, authToken);
```
