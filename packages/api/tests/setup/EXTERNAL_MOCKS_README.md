# External Service Mocking - Complete Guide

## TL;DR

**External API calls are now automatically blocked.** The test preload installs a global fetch interceptor.

For full protection (npm modules + fetch), call `setupAllExternalMocks(mock)` at the top of test files:

```typescript
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';
import { mock } from 'bun:test';

// MUST be called BEFORE importing any services
setupAllExternalMocks(mock);

// NOW safe to import services
import { createTestServer } from '../../setup/helpers/testServer';
```

## Defense in Depth Strategy

We use TWO layers of mocking to ensure no external API calls escape:

### Layer 1: Global Fetch Mock (Automatic via Preload)

The preload file (`packages/api/tests/setup/preload.ts`) installs a global fetch interceptor that:

- **Blocks ALL external API calls** via native `fetch()`
- **Returns mock responses** for common patterns (GitHub, Google, Slack, etc.)
- **Throws clear errors** when unmocked external APIs are called

This catches API calls that bypass npm libraries:

- `ConnectionsService.getGitHubAccountInfo()` → `fetch('https://api.github.com/user')`
- `AuthService.exchangeGitHubCode()` → `fetch('https://github.com/login/oauth/access_token')`
- `ConnectionsService.getGoogleAccountInfo()` → `fetch('https://www.googleapis.com/oauth2/v2/userinfo')`

### Layer 2: Module Mocks (via setupAllExternalMocks)

`setupAllExternalMocks(mock)` mocks **7 npm packages**:

1. **Slack Web API** (`@slack/web-api`) - OAuth, messaging
2. **Google APIs** (`googleapis`) - Drive, Docs, Gmail
3. **Octokit** (`@octokit/rest`) - GitHub REST API
4. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) - Anthropic API
5. **Clerk** (`@clerk/backend`) - Authentication
6. **Resend** (`resend`) - Email delivery
7. **Apify** (`apify-client`) - Web scraping

## Why Both Layers?

| API Call Method                       | Layer 1 (fetch mock) | Layer 2 (module mock) |
| ------------------------------------- | -------------------- | --------------------- |
| `fetch('https://api.github.com/...')` | ✅ Blocked           | ❌ Not caught         |
| `new Octokit(...).repos.list()`       | ❌ Not caught        | ✅ Mocked             |
| `google.drive(...).files.list()`      | ❌ Not caught        | ✅ Mocked             |

**Both layers are needed** because:

- Some services use `fetch()` directly (ConnectionsService, AuthService)
- Some services use npm libraries (ClaudeService, IntentAnalysisService)

## What Gets Blocked

### Blocked Domains (fetch mock)

- `api.github.com`, `github.com`
- `api.anthropic.com`
- `www.googleapis.com`, `oauth2.googleapis.com`
- `slack.com`, `api.slack.com`
- `api.fly.io`
- `api.apify.com`
- `api.openai.com`
- `generativelanguage.googleapis.com` (Gemini)
- Any HTTPS request to non-localhost domains

### Allowed Domains

- `localhost`
- `127.0.0.1`
- `0.0.0.0`

## Mock Responses

The fetch mock returns realistic responses for common API patterns:

### GitHub API

- `/user` - Returns mock user info
- `/user/installations` - Returns empty installations
- `/login/oauth/access_token` - Returns mock OAuth token

### Google API

- `/oauth2/v2/userinfo` - Returns mock user info
- `/token` - Returns mock OAuth tokens

### Slack API

- `/api/auth.test` - Returns successful auth test
- `/api/oauth.v2.access` - Returns mock OAuth token

### Fly.io / Apify

- GraphQL and REST endpoints return mock data

## Patterns

### Pattern 1: Standard Tests (Recommended)

Most tests should use this pattern:

```typescript
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';
import { mock } from 'bun:test';

setupAllExternalMocks(mock); // Mocks ALL 8 external services + imports fetch mock

import { createTestServer } from '../../setup/helpers/testServer';
// ... rest of imports
```

### Pattern 2: Tests Needing Custom Claude SDK Behavior

Some tests need stateful Claude SDK mocks:

```typescript
import { setupExternalServiceMocks } from '../../setup/mocks/externalServices';
import { mockQueryImplementation, query as mockQuery } from '../../setup/mocks/mockClaudeAgentSDK';
import { mock } from 'bun:test';

// Import fetch mock (also via preload, but explicit is safer)
import '../../setup/mocks/globalFetchMock';

// Mock external services (Slack, Google APIs)
setupExternalServiceMocks(mock);

// Override Claude SDK with stateful mock
mock.module('@anthropic-ai/claude-agent-sdk', () => {
  return { query: mockQuery };
});

// Mock Octokit
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      constructor() {}
    },
  };
});

// NOW import services
import { ClaudeService } from '../../../src/services/ClaudeService';

// Configure custom responses
mockQueryImplementation.addResponse({ type: 'text', text: 'Custom response' });
```

### Pattern 3: Adding Custom Fetch Mock Responses

If you need to mock a new external API endpoint:

```typescript
import { addMockResponse } from '../../setup/mocks/globalFetchMock';

// Add before running tests
addMockResponse(
  'api.newservice.com/endpoint',
  () =>
    new Response(JSON.stringify({ data: 'mock' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
);
```

## Troubleshooting

### "BLOCKED: External API call to X in test environment"

**Cause:** Test is trying to call an external API that's not mocked

**Fix:**

1. Check if the service is using `fetch()` directly - if so, add a mock response to `globalFetchMock.ts`
2. Check if the service is using an npm library - if so, add a `mock.module()` call
3. Ensure `setupAllExternalMocks(mock)` is called before service imports

### "GitHub API error: 401"

**Cause:** Test is calling real GitHub API via fetch()

**Fix:** This should be caught by the preload. If you see this:

1. Verify preload is being loaded (`DEBUG=true bun test ...`)
2. Check if the test is running the preload (`bunfig.toml` has the preload)

### "TypeError: Octokit is not a constructor"

**Cause:** Mock setup called after services were imported

**Fix:** Call `setupAllExternalMocks(mock)` BEFORE importing services

## How the Preload Works

The preload file (`packages/api/tests/setup/preload.ts`) is configured in `bunfig.toml`:

```toml
[test]
preload = ["./packages/api/tests/setup/preload.ts"]
```

This file runs BEFORE every test file and:

1. Imports `globalFetchMock.ts` which auto-installs the fetch interceptor
2. Does NOT use `mock.module()` (which would break `describe.serial`)

## Migration Checklist

When adding a new test file:

1. ✅ Import `setupAllExternalMocks` from `../../setup/mocks/setupAllExternalMocks`
2. ✅ Call `setupAllExternalMocks(mock)` BEFORE service imports
3. ✅ Verify test doesn't make real API calls (no auth errors, no network requests)
4. ✅ Test should pass with mocks

## Summary

**Golden Rule:** Every test file SHOULD call `setupAllExternalMocks(mock)` at the top for full protection. Even if you forget, the preload will catch `fetch()` calls to external APIs and throw a clear error.

**Defense in Depth:**

- Preload catches `fetch()` calls (automatic, no setup needed)
- `setupAllExternalMocks()` catches npm library calls (must be called explicitly)
- Both together = complete protection against real API calls
