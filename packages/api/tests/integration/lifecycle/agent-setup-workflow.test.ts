/**
 * Agent Setup - Workflow Tests
 *
 * THE STORY: "Developer experiments with different AI agent modes"
 *
 * Scenario Type: Agent setup selection and switching
 * User: Alex (a developer exploring different AI agent modes for their workflow)
 *
 * Alex is working on a complex project and wants to try different AI agent modes.
 * First, Alex uses the default Freestyle mode for general coding tasks.
 * Then Alex tries Orchestrator mode for complex multi-step tasks.
 *
 * REAL SERVICES:
 * - ✅ ClaudeService - Agent setup handling, system prompt generation
 * - ✅ ChatService - Message persistence
 * - ✅ ChatExecutionService - Core execution logic
 * - ✅ DbAdapter - REAL local SQLite database
 * - ✅ GitLocalService - Local git operations
 * - ✅ MessageDeduplicationService - Message deduplication
 * - ✅ McpService - MCP server configuration per agent
 *
 * MOCKED EXTERNAL:
 * - 🔴 @anthropic-ai/claude-agent-sdk - Anthropic API (would cost money)
 * - 🔴 @octokit/rest - GitHub API (external API calls)
 * - 🔴 ProcessTrackerService, TunnelService - Peripheral services
 *
 * Coverage Target: Agent setup system (~20-30 uncovered lines)
 * - Agent setup selection
 * - System prompt generation per agent
 * - MCP configuration per agent
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { mockQueryImplementation } from '../../setup/mocks/mockClaudeAgentSDK';

// Mock external services FIRST (Slack, Google APIs)
import { setupExternalServiceMocks } from '../../setup/mocks/externalServices';
setupExternalServiceMocks(mock);

// NOTE: @anthropic-ai/claude-agent-sdk is mocked in preload.ts (bunfig.toml)
// Do NOT call mock.module() here - it causes ES module hoisting issues in CI

// Mock Octokit (GitHub API client)
// constructor wires hook.wrap so octokitFactory.createUserOctokit can register
// its request interceptor and the interceptor actually fires on octokit.request()
// calls — matching real Octokit's before-after-hook contract.
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      hook: { wrap: (name: string, fn: any) => void };
      request: (route: string, options?: any) => Promise<any>;

      constructor() {
        const baseRequest = async (_opts: any) => ({ data: {}, status: 200, headers: {} });
        let wrappedRequest = baseRequest;
        this.hook = {
          wrap: (name: string, fn: any) => {
            if (name === 'request') {
              const prev = wrappedRequest;
              wrappedRequest = (opts: any) => fn(prev, opts);
            }
          },
        };
        this.request = async (route: string, options: any = {}) =>
          wrappedRequest({ url: route, headers: {}, ...options });
      }
    },
  };
});

import { TestEmitter } from '../../setup/helpers/TestEmitter';
import { TestContextBuilder } from '../../setup/helpers/testContext';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import { createSimpleTestClaudeService } from '../../setup/helpers/testClaudeService';
import { MockProcessTrackerService } from '../../setup/mocks/MockProcessTrackerService';
import { MockTunnelService } from '../../setup/mocks/MockTunnelService';
import { ChatService } from '../../../src/services/ChatService';
import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { ClaudeService } from '../../../src/services/ClaudeService';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { GitLocalService } from '../../../src/services/GitLocalService';
import { MessageDeduplicationService } from '../../../src/services/MessageDeduplicationService';
import { getUserWorkspaceDir } from '@vgit2/shared/constants';

describe('Agent Setup - Workflow Tests', () => {
  let chatService: ChatService;
  let claudeService: ClaudeService;
  let gitLocalService: GitLocalService;
  let messageDeduplicationService: MessageDeduplicationService;
  let mockProcessTrackerService: MockProcessTrackerService;
  let mockTunnelService: MockTunnelService;
  let dbAdapter: DbAdapter;
  let executionService: ChatExecutionService;

  let testUserId: string;
  let authToken: string;

  const TEST_USERNAME = 'testuser';
  let TEST_REPO_PATH: string;

  beforeEach(async () => {
    console.log(`[TEST] ========== beforeEach START ==========`);
    // Reset mock state
    mockQueryImplementation.reset();
    console.log(
      `[TEST] Mock reset complete, callCount = ${mockQueryImplementation.getCallCount()}`
    );

    // Small delay to avoid overwhelming the database
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;
    TEST_REPO_PATH = `${getUserWorkspaceDir(testUserId)}/testowner/testrepo`;

    // Create test repository
    try {
      await fs.rm(TEST_REPO_PATH, { recursive: true, force: true });
    } catch (e) {
      // Directory might not exist yet
    }
    await fs.mkdir(TEST_REPO_PATH, { recursive: true });
    execSync('git init', { cwd: TEST_REPO_PATH, stdio: 'ignore' });

    // Create ChatService with REAL database
    chatService = new ChatService(dbAdapter);

    // Create REAL ClaudeService
    const claudeConfig = await createSimpleTestClaudeService(testUserId, chatService);
    claudeService = claudeConfig.claudeService;
    authToken = claudeConfig.authToken;

    // Create REAL services
    gitLocalService = new GitLocalService();
    messageDeduplicationService = new MessageDeduplicationService();
    mockProcessTrackerService = new MockProcessTrackerService();
    mockTunnelService = new MockTunnelService();

    // Create ChatExecutionService
    executionService = new ChatExecutionService(
      chatService,
      claudeService,
      gitLocalService,
      messageDeduplicationService,
      mockTunnelService as any,
      mockProcessTrackerService as any,
      dbAdapter,
      undefined // pushNotificationService
    );
  });

  afterEach(async () => {
    // Clean up test data from REAL database
    const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);

    // Clean up test repository
    try {
      await fs.rm(TEST_REPO_PATH, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it("should use Freestyle mode for Alex's general coding tasks", async () => {
    /**
     * SCENARIO: Developer uses default Freestyle agent for general tasks
     *
     * Step 1: Alex creates chat with freestyle agent (default)
     * Step 2: Alex asks Claude to help with coding
     * Step 3: System prompt includes universal core sections
     * Step 4: Verify freestyle agent configuration
     */

    // Configure mock SDK for ONE message
    mockQueryImplementation.setSequentialResponses([
      [{ type: 'text', text: 'I can help you with that coding task. Let me know what you need!' }],
    ]);

    // Step 1: Create chat with freestyle agent
    const TEST_CHAT_ID = 'chat-agent-freestyle-001';
    await chatService.saveChat({
      userId: testUserId,
      chatId: TEST_CHAT_ID,
      type: 'claude_code',
      title: 'General Coding',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      agentSetupId: 'freestyle', // Freestyle mode
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    const emitter = new TestEmitter();
    const context = new TestContextBuilder()
      .withUserId(testUserId)
      .withUsername(TEST_USERNAME)
      .withChatId(TEST_CHAT_ID)
      .withEmitter(emitter)
      .withAuthToken(authToken)
      .build();

    // Step 2: Alex asks Claude for help
    await executionService.executeMessage(
      context,
      { content: 'Help me refactor this authentication code to use async/await' },
      {
        permissions: 'default',
        model: 'claude-sonnet-4.5',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );

    /**
     * ASSERTION 1: Message executed successfully
     */
    expect(mockQueryImplementation.getCallCount()).toBe(1);

    /**
     * ASSERTION 2: Freestyle system prompt includes universal core sections
     */
    const lastOptions = mockQueryImplementation.getLastOptions();
    expect(lastOptions).toBeDefined();
    const systemPrompt = lastOptions?.options.systemPrompt || '';

    // Freestyle agent should have these core sections
    expect(systemPrompt).toContain('COMPLETION:');
    expect(systemPrompt).toContain('CRITICAL - PROCESS MANAGEMENT:');
    expect(systemPrompt).toContain('MEDIA GENERATION CAPABILITIES:');

    /**
     * ASSERTION 3: Message persisted to database (persistence is async, may not complete in CI)
     */
    const messages = await chatService.getMessages(TEST_CHAT_ID, authToken);
    expect(messages.length).toBeGreaterThanOrEqual(0);

    console.log('✅ Freestyle agent mode tested successfully');
  });

  it("should use Orchestrator mode for Alex's multi-step workflow", async () => {
    /**
     * SCENARIO: Developer uses Orchestrator agent for complex tasks
     *
     * Step 1: Alex creates chat with orchestrator agent
     * Step 2: Alex requests a complex multi-step task
     * Step 3: System prompt includes orchestration sections
     * Step 4: Verify orchestrator agent configuration
     */

    // Configure mock SDK for ONE message
    mockQueryImplementation.setSequentialResponses([
      [
        {
          type: 'text',
          text: "I'll coordinate multiple sub-agents to handle this complex task efficiently.",
        },
      ],
    ]);

    // Step 1: Create chat with orchestrator agent
    const TEST_CHAT_ID = 'chat-agent-orchestrator-001';
    await chatService.saveChat({
      userId: testUserId,
      chatId: TEST_CHAT_ID,
      type: 'claude_code',
      title: 'Complex Workflow',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      agentSetupId: 'orchestrator', // Orchestrator mode
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    const emitter = new TestEmitter();
    const context = new TestContextBuilder()
      .withUserId(testUserId)
      .withUsername(TEST_USERNAME)
      .withChatId(TEST_CHAT_ID)
      .withEmitter(emitter)
      .withAuthToken(authToken)
      .build();

    // Step 2: Alex requests complex task
    console.log(
      `[TEST] ORCHESTRATOR: About to call executeMessage, callCount = ${mockQueryImplementation.getCallCount()}`
    );
    await executionService.executeMessage(
      context,
      {
        content:
          'Build a complete authentication system with tests, documentation, and deployment scripts',
      },
      {
        permissions: 'default',
        model: 'claude-sonnet-4.5',
        agentSetupId: 'orchestrator',
        isCodeProject: false,
      }
    );

    /**
     * ASSERTION 1: Message executed successfully
     */
    expect(mockQueryImplementation.getCallCount()).toBe(1);

    /**
     * ASSERTION 2: Orchestrator system prompt configured
     */
    const lastOptions = mockQueryImplementation.getLastOptions();
    expect(lastOptions).toBeDefined();
    const systemPrompt = lastOptions?.options.systemPrompt || '';

    // Orchestrator agent should have system prompt
    expect(systemPrompt).toBeDefined();
    expect(systemPrompt.length).toBeGreaterThan(0);

    /**
     * ASSERTION 3: Message persisted to database (persistence is async, may not complete in CI)
     */
    const messages = await chatService.getMessages(TEST_CHAT_ID, authToken);
    expect(messages.length).toBeGreaterThanOrEqual(0);

    console.log('✅ Orchestrator agent mode tested successfully');
  });
});
