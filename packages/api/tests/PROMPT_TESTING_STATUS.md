# Prompt Testing Status

**Last Updated**: 2026-01-23

## Overview

All AI prompts have been centralized into [`packages/api/src/prompts/`](../src/prompts/) directory. This document tracks test coverage status for each prompt file.

## Centralized Prompt Files

### ✅ Fully Tested (100% Coverage)

1. **[actionExtraction.ts](../src/prompts/actionExtraction.ts)** - 100% coverage
   - Used by: Action extraction logic
   - Tested via: Existing integration tests

2. **[intentAnalysis.ts](../src/prompts/intentAnalysis.ts)** - 100% coverage
   - Used by: IntentAnalysisService
   - Route: `POST /api/chats/analyze-intent`
   - Tested via: `api-routes-extended.test.ts`, `api-routes-media-runtime.test.ts`

3. **[systemPrompts.ts](../src/prompts/systemPrompts.ts)** - 100% functions, 91% lines
   - Used by: ChatExecutionService (all chat sessions)
   - Tested via: `tunnelPrompts.test.ts` + all chat lifecycle tests

4. **[agents/bestPractice.ts](../src/prompts/agents/bestPractice.ts)** - 100% coverage
   - Agent setup with 6 sub-agents
   - Tested via: Chat execution with best-practice agent

5. **[agents/freestyle.ts](../src/prompts/agents/freestyle.ts)** - 100% coverage
   - Direct execution agent
   - Tested via: Chat execution with freestyle agent

6. **[agents/orchestrator.ts](../src/prompts/agents/orchestrator.ts)** - 100% coverage
   - Task coordinator agent
   - Tested via: Chat execution with orchestrator agent

### ⚠️ Needs Test Coverage (0% Coverage)

1. **[chatSearch.ts](../src/prompts/chatSearch.ts)** - 0% coverage
   - Used by: `search-chats` MCP tool
   - Route: MCP tool only (no direct HTTP route)
   - Status: Tool exists but has no integration tests
   - **Action needed**: Add MCP tool integration test using McpToolTestHelper

2. **[suggestions.ts](../src/prompts/suggestions.ts)** - 0% coverage
   - Used by: SuggestionsService
   - Route: `POST /api/chats/suggestions`
   - Status: Route tests exist BUT feature flag `ENABLE_SUGGESTIONS` is disabled by default
   - **Action needed**: Enable feature flag in test environment OR set env var in test setup

3. **[transcription.ts](../src/prompts/transcription.ts)** - 0% coverage
   - Used by: TranscriptionService
   - Route: Voice transcription correction (internal service)
   - Status: No tests for TranscriptionService
   - **Action needed**: Add integration test for voice transcription flow

## Action Items for Full Coverage

### 1. Enable Suggestions Feature Flag in Tests

**Priority**: High
**Effort**: Low (< 30 minutes)

The suggestions endpoint tests exist but the `ENABLE_SUGGESTIONS` feature flag is disabled by default. To fix:

**Option A**: Set environment variable in test files:

```typescript
// At top of api-routes-extended.test.ts
process.env.ENABLE_SUGGESTIONS = 'true';
```

**Option B**: Mock the feature flags:

```typescript
import { FEATURE_FLAGS } from '../../../src/config/featureFlags';
FEATURE_FLAGS.ENABLE_SUGGESTIONS = true;
```

### 2. Add Integration Test for search-chats Tool

**Priority**: Medium
**Effort**: Medium (1-2 hours)

Create test file: `tests/integration/tools/search-chats.test.ts`

Use `McpToolTestHelper` pattern (see `run-connection-lifecycle.test.ts` for reference):

```typescript
import { McpToolTestHelper } from '../../setup/helpers/mcpToolTestHelper';

describe('search-chats Tool - Integration Tests', () => {
  let testHelper: McpToolTestHelper;

  beforeEach(async () => {
    const { adapter, userId, authToken } = await createTestDbAdapter();
    testHelper = new McpToolTestHelper({
      testUserId: userId,
      authToken,
      dbAdapter: adapter,
    });
    await testHelper.setup();
  });

  it('should search chats with semantic AI ranking', async () => {
    // Create test chats first
    // Then execute search tool
    const result = await testHelper.executeMcpTool({
      userMessage: 'Search for auth-related chats',
      toolName: 'mcp__chat__search_chats',
      toolInput: { query: 'authentication bugs', limit: 10 },
      mockToolResult: { success: true, matches: [] },
    });

    expect(result.toolWasInvoked).toBe(true);
  });
});
```

### 3. Add Integration Test for TranscriptionService

**Priority**: Low
**Effort**: Medium (1-2 hours)

Create test file: `tests/integration/services/transcription-service.test.ts`

Test the voice transcription correction flow:

```typescript
import { TranscriptionService } from '../../../src/services/TranscriptionService';

describe('TranscriptionService - Integration Tests', () => {
  it('should correct technical terms using chat context', async () => {
    const rawTranscription = 'update the read this service';
    const chatContext = JSON.stringify([{ role: 'user', content: 'Working on Redis integration' }]);

    const corrected = await transcriptionService.correctTranscription(
      rawTranscription,
      chatContext
    );

    expect(corrected).toContain('Redis');
  });
});
```

## Benefits of Current Organization

✅ **Single source of truth**: All prompts in one directory
✅ **Clear separation**: Analysis prompts, agent setups, system prompts
✅ **Easy discovery**: Central `prompts/index.ts` re-export
✅ **Testability**: Enhanced mock infrastructure captures prompts
✅ **Type safety**: All imports checked by TypeScript

## Related Documentation

- [MCP Tool Testing Strategy](./STRATEGY-MCP-Tool-Testing.md) - How to test MCP-only tools
- [Coverage Analysis](./COVERAGE_ANALYSIS.md) - Overall test coverage metrics
- [Test Performance Report](./TEST_PERFORMANCE_REPORT.md) - Test execution times

## Future Improvements

1. Add prompt validation tests (schema validation, required fields)
2. Add prompt regression tests (detect accidental changes)
3. Add prompt quality metrics (length, clarity, specificity)
4. Consider extracting prompts to separate package for reusability
