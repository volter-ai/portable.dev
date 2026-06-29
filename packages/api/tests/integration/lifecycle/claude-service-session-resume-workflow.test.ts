/**
 * Claude Service - Session Resume Workflow Tests
 *
 * THE STORY: "Developer's browser crashes mid-conversation"
 *
 * Scenario Type: Session interruption and restoration
 * User: Marcus (a developer debugging a complex issue with Claude's help)
 *
 * Marcus is debugging a production issue with Claude's assistance. He sends an initial
 * message asking Claude to analyze the logs. While Claude is processing, Marcus's browser
 * crashes. When he reopens the app and reconnects, he wants to send a follow-up message.
 * The system should resume his session with Claude, preserving all context from the
 * previous conversation.
 *
 * REAL SERVICES:
 * - ✅ ClaudeService - Session management, session restoration
 * - ✅ ChatService - Message persistence and retrieval
 * - ✅ ChatExecutionService - Core execution logic
 * - ✅ DbAdapter - REAL local SQLite
 * - ✅ GitLocalService - Local git operations
 * - ✅ MessageDeduplicationService - Message deduplication
 *
 * MOCKED EXTERNAL:
 * - 🔴 @anthropic-ai/claude-agent-sdk - Anthropic API (would cost money)
 * - 🔴 @octokit/rest - GitHub API (external API calls)
 * - 🔴 ProcessTrackerService, TunnelService - Peripheral services
 *
 * Coverage Target: Session resumption and context preservation (~58 lines)
 * - Session restoration from database
 * - Message queue handling
 * - Context preservation across resume
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import { mockQueryImplementation } from '../../setup/mocks/mockClaudeAgentSDK';

// NOTE: @anthropic-ai/claude-agent-sdk is mocked in preload.ts (bunfig.toml)
// Do NOT call mock.module() here - it causes ES module hoisting issues in CI

// Mock Octokit (GitHub API client)
mock.module('@octokit/rest', () => {
  return {
    Octokit: class MockOctokit {
      request = async () => ({ data: {}, status: 200, headers: {} });
      constructor() {}
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

// Skip in CI - Claude SDK mock timing issues make session resume tests flaky in CI
const isCI = process.env.CI === '1' || process.env.CI === 'true';

describe.skipIf(isCI)('Claude Service - Session Resume Workflow', () => {
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
  const TEST_CHAT_ID = 'chat-resume-workflow-001';
  let TEST_REPO_PATH: string;

  beforeEach(async () => {
    // Reset mock state
    mockQueryImplementation.reset();

    // Small delay to avoid overwhelming the test database
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

  it("should resume Marcus's debugging session after browser crash", async () => {
    /**
     * SCENARIO: Browser crashes mid-conversation, user reconnects
     *
     * Step 1: Marcus creates chat and asks Claude to analyze logs
     * Step 2: First message executes successfully, session created
     * Step 3: Browser crashes (simulate by removing session)
     * Step 4: Marcus reconnects and sends follow-up message
     * Step 5: Session restores, second message executes with context
     */

    // Configure mock SDK for TWO messages
    mockQueryImplementation.setSequentialResponses([
      // First message: Analyze logs
      [
        {
          type: 'text',
          text: 'I analyzed the logs. There are 3 errors related to database connections.',
        },
      ],
      // Second message: Suggest fix (after resume)
      [
        {
          type: 'text',
          text: 'To fix the database connection issues, update your connection pool settings.',
        },
      ],
    ]);

    // Step 1: Create chat
    await chatService.saveChat({
      userId: testUserId,
      chatId: TEST_CHAT_ID,
      type: 'claude_code',
      title: 'Production Debugging',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      agentSetupId: 'freestyle',
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

    // Step 2: Execute first message
    await executionService.executeMessage(
      context,
      { content: 'Analyze the error logs and tell me what issues you find' },
      {
        permissions: 'default',
        model: 'claude-sonnet-4.5',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    /**
     * ASSERTION 1: First message created session
     */
    let session = claudeService.getSession(TEST_CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.session_id).toBeDefined();

    /**
     * ASSERTION 2: First message persisted to database
     */
    const messagesAfterFirst = await chatService.getMessages(TEST_CHAT_ID, authToken);
    expect(messagesAfterFirst.length).toBeGreaterThanOrEqual(2); // User + assistant

    // Step 3: Simulate browser crash by removing session
    console.log('🔥 Simulating browser crash - removing session...');
    claudeService.removeSession(TEST_CHAT_ID);
    await new Promise((resolve) => setTimeout(resolve, 200));

    /**
     * ASSERTION 3: Session removed (simulating crash)
     */
    session = claudeService.getSession(TEST_CHAT_ID);
    expect(session).toBeUndefined();

    // Step 4: User reconnects and sends follow-up message
    console.log('🔄 User reconnects and sends follow-up message...');

    await executionService.executeMessage(
      context,
      { content: 'How can I fix those database connection errors?' },
      {
        permissions: 'default',
        model: 'claude-sonnet-4.5',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    /**
     * ASSERTION 4: New session created after resume
     */
    session = claudeService.getSession(TEST_CHAT_ID);
    expect(session).toBeDefined();

    /**
     * ASSERTION 5: Second message executed successfully
     */
    expect(mockQueryImplementation.getCallCount()).toBe(2);

    /**
     * ASSERTION 6: All messages persisted (context preserved)
     */
    const messagesAfterResume = await chatService.getMessages(TEST_CHAT_ID, authToken);
    expect(messagesAfterResume.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant

    console.log('✅ Session resume after browser crash tested successfully');
  });
});
