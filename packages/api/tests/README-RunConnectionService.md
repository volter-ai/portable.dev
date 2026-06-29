# RunConnectionService Testing Strategy

## Current Status: Low Test Coverage (2.01%)

RunConnectionService has minimal test coverage because it's only accessible through the MCP tool system, requiring complex end-to-end chat lifecycle tests.

## Architecture Overview

```
User Message → ClaudeService → MCP Tool (run-connection) → RunConnectionService → External SDKs
```

**Key points:**

- NO HTTP routes - not accessible via REST API
- NO direct service calls from frontend
- ONLY invoked when Claude AI decides to use the run-connection MCP tool
- Requires full chat execution infrastructure to test

## Why GitHubApiService Has High Coverage

GitHubApiService achieves 84.59% coverage through lifecycle tests because:

1. **HTTP route handlers** - Can be tested directly via Express handlers
2. **Simpler invocation** - Called directly from routes, not through MCP tools
3. **Less complex setup** - Doesn't require mocking Claude SDK tool invocations

Example from `github-api-lifecycle-happy-path.test.ts`:

```typescript
await gitHubApiService.handleListRepos(mockReq, mockRes);
// Direct service method call - simple to test!
```

## Challenge with RunConnectionService

Testing RunConnectionService properly requires:

1. **Full chat infrastructure**: ChatService, ClaudeService, ChatExecutionService, McpService
2. **Complex SDK mocking**: Mock Claude SDK to return tool_use blocks with run-connection invocations
3. **Message structure handling**: Parse complex content blocks and tool results
4. **Connection setup**: Create test connections in database with proper credentials

Example of required test complexity:

```typescript
// Mock Claude SDK response
mockQueryImplementation.setSequentialResponses([
  [
    { type: 'text', text: "I'll post to Slack" },
    {
      type: 'tool_use',
      id: 'tool_001',
      name: 'mcp__run-connection__run_connection_execute_code',
      input: {
        connections: ['company_slack'],
        code: `await company_slack.chat.postMessage({...})`,
      },
    },
  ],
]);

// Execute through full chat flow
await executionService.executeMessage(context, { content: userMessage }, {...});

// Wait for async persistence
await new Promise(resolve => setTimeout(resolve, 300));

// Parse persisted messages to verify tool execution
const messages = await chatService.getMessages(chatId, authToken);
// ... complex message structure parsing ...
```

## Recommended Testing Strategy

### Option 1: Direct Unit Tests (Simpler, Less Coverage)

Test RunConnectionService directly bypassing MCP:

```typescript
const runConnectionService = new RunConnectionService(connectionsService);

const result = await runConnectionService.execute({
  connections: ['test_slack'],
  code: `return await test_slack.chat.postMessage({...})`,
  userId,
  chatId,
  emitEvent,
  authToken,
});

expect(result.success).toBe(true);
```

**Pros:**

- Simple setup
- Tests core execution logic
- Fast

**Cons:**

- Doesn't test MCP integration
- Doesn't test real user flow
- Not true end-to-end

### Option 2: Full Lifecycle Tests (Complex, High Coverage)

Test through complete MCP tool invocation:

**Pros:**

- True end-to-end testing
- Tests real user flow
- Tests MCP integration

**Cons:**

- Very complex setup
- Fragile (many moving parts)
- Requires extensive mocking

### Option 3: Focus on GitHubApiService Pattern (Recommended Short-term)

Since RunConnectionService is working in production and the architecture is sound:

1. Document the service thoroughly
2. Add simple unit tests for critical paths
3. Rely on manual QA for full integration
4. Revisit when testing infrastructure improves

## Lessons Learned

**Key Insight**: Testing services that are ONLY accessible through MCP tools requires significantly more infrastructure than services with HTTP endpoints.

**For future services:**

- Consider adding HTTP endpoints for easier testing (even if only used internally)
- Or build reusable test infrastructure for MCP tool invocations
- Document testing challenges early in development

## Next Steps

To improve RunConnectionService test coverage:

1. **Create `tests/setup/helpers/mcpToolTestHelper.ts`** - Reusable infrastructure for testing MCP tool invocations
2. **Add simple unit tests** - Test `setupContext()`, `setupServiceClient()`, `executeCode()` independently
3. **Document manual test scenarios** - Real user flows to test manually before releases
4. **Consider refactoring** - Add internal HTTP endpoint for testing purposes only

## Related Files

- Production code: `src/services/RunConnectionService.ts`
- MCP integration: `src/services/mcp/McpService.ts` (line 396)
- Base class: `src/services/CodeExecutorService.ts`
- GitHub tests (reference): `tests/integration/lifecycle/github-api-lifecycle-*.test.ts`
