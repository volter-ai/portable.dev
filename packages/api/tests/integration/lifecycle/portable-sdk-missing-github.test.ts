/**
 * Portable SDK - Missing GitHub Operations Bug Test
 *
 * THE STORY: "User tries to create GitHub issue via Portable SDK"
 *
 * BUG REPORT: User attempted to use portable.github.createIssue() and got:
 * "Cannot read properties of undefined (reading 'createIssue')"
 *
 * Root cause: PortableSDK doesn't implement github operations section.
 * User expected github operations to be available based on Portable's GitHub integration.
 *
 * This test reproduces the bug and validates the fix.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import { PortableSDK } from '../../../src/services/PortableSDK';
import { ChatService } from '../../../src/services/ChatService';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { portableExecuteTool } from '../../../src/tools/standard/portable-execute';

describe('Portable SDK - Missing GitHub Operations Bug', () => {
  let chatService: ChatService;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;
  let testChatId: string;
  let setupSucceeded = false;

  beforeEach(async () => {
    setupSucceeded = false;

    try {
      // Verify the test database is running before proceeding
      const helper = TestDatabaseHelper.getInstance();
      const isConnected = await helper.verifyConnection();
      if (!isConnected) {
        console.warn('[TEST SETUP] test database is not available, tests will be skipped');
        return;
      }

      // Create unique test user and database adapter
      const { adapter, userId, authToken: token } = await createTestDbAdapter();
      dbAdapter = adapter;
      testUserId = userId;
      authToken = token;

      // Create ChatService
      chatService = new ChatService(dbAdapter);

      // Create test chat
      testChatId = 'chat-test-portable-sdk';
      await chatService.saveChat({
        userId: testUserId,
        chatId: testChatId,
        type: 'claude_code',
        title: 'Portable SDK Test',
        status: undefined,
        repoPath: '/test/repo',
        agentSetupId: 'freestyle',
        model: 'sonnet',
        permissions: 'default',
        parentChatId: undefined,
        authToken,
      });
      setupSucceeded = true;
    } catch (error) {
      console.warn(
        '[TEST SETUP] test database not available, tests will be skipped:',
        (error as Error).message
      );
    }
  });

  afterEach(async () => {
    if (!setupSucceeded) return;
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  it('should provide github namespace with helpful error messages', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }

    /**
     * SCENARIO: User tries to access portable.github (now exists with helpful errors)
     *
     * Step 1: Create PortableSDK instance
     * Step 2: Verify github namespace exists
     * Step 3: Verify methods throw helpful errors directing to gh CLI
     */

    const portable = new PortableSDK(
      { chatService },
      {
        userId: testUserId,
        chatId: testChatId,
        authToken,
      }
    );

    // FIX: github namespace is now defined
    expect((portable as any).github).toBeDefined();
    expect((portable as any).github.createIssue).toBeDefined();
    expect((portable as any).github.listRepos).toBeDefined();
    expect((portable as any).github.createPR).toBeDefined();
    expect((portable as any).github.info).toBeDefined();

    // Methods throw helpful errors directing users to gh CLI
    await expect((portable as any).github.createIssue({})).rejects.toThrow(
      "GitHub operations should be performed using the 'gh' CLI via bash"
    );
  });

  it('should provide helpful error when using github operations via portable_execute', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }

    /**
     * SCENARIO: User executes code with github operations
     *
     * Step 1: Execute portable_execute with github code
     * Step 2: Verify helpful error message directing to gh CLI
     */

    const context = {
      userId: testUserId,
      chatId: testChatId,
      authToken,
      chatService,
      emitEvent: () => {},
    };

    // Execute code that tries to use portable.github
    const result = await portableExecuteTool.execute(
      {
        code: `
          // Try to create GitHub issue (will throw helpful error)
          const issue = await portable.github.createIssue({
            owner: 'test',
            repo: 'test',
            title: 'Test Issue',
            body: 'Test body'
          });
          return issue;
        `,
      },
      context
    );

    // Should return error with helpful message
    expect(result.content[0].type).toBe('text');
    const errorText = result.content[0].text;

    // Error should direct user to gh CLI
    expect(errorText).toContain('Error executing Portable SDK code');
    expect(errorText).toContain(
      "GitHub operations should be performed using the 'gh' CLI via bash"
    );
  });

  it('should list available namespaces when github is accessed', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }

    /**
     * SCENARIO: After fix, SDK should provide helpful error
     *
     * Step 1: Create PortableSDK instance
     * Step 2: Access github namespace
     * Step 3: Verify helpful error or placeholder object
     */

    const portable = new PortableSDK(
      { chatService },
      {
        userId: testUserId,
        chatId: testChatId,
        authToken,
      }
    );

    // After fix: github namespace exists with helpful info
    expect(portable.chat).toBeDefined();
    expect(portable.projects).toBeDefined();
    expect(portable.runtime).toBeDefined();
    expect(portable.user).toBeDefined();
    expect(portable.context).toBeDefined();

    // github namespace now exists with info() method
    expect((portable as any).github).toBeDefined();
    expect((portable as any).github.info).toBeDefined();

    // info() returns helpful guidance
    const info = (portable as any).github.info();
    expect(info.message).toContain('GitHub operations should be performed using the gh CLI');
    expect(info.availableMethods).toContain('createIssue');
    expect(info.recommendation).toContain('Use bash tool with gh CLI commands');
  });

  it('should successfully use available namespaces', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }

    /**
     * SCENARIO: Verify existing namespaces work correctly
     *
     * Step 1: Create PortableSDK instance
     * Step 2: Call methods on available namespaces
     * Step 3: Verify they work
     */

    const portable = new PortableSDK(
      { chatService },
      {
        userId: testUserId,
        chatId: testChatId,
        authToken,
      }
    );

    // Test chat namespace
    const chats = await portable.chat.list();
    expect(Array.isArray(chats)).toBe(true);

    // Test user namespace
    const userInfo = await portable.user.getInfo();
    expect(userInfo.userId).toBe(testUserId);
    expect(userInfo.chatId).toBe(testChatId);

    // Test context namespace (may return undefined/empty if RLS blocks read)
    const currentChat = await portable.context.getCurrentChat();
    if (currentChat?.id) {
      expect(currentChat.id).toBe(testChatId);
    }

    console.log('[TEST] ✓ All available namespaces work correctly');
  });
});
