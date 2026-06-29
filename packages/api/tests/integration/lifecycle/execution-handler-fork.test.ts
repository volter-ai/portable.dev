/**
 * Fork-on-first-write — the SDK query() options ExecutionHandler builds for a chat
 * CLAIMED from a Claude Code transcript (fork_source_session_id set, session_id null).
 *
 * Asserts (captured by the mock SDK the moment query() is called, so it is reliable
 * regardless of persistence-timing flake):
 *   - `resume` = the ORIGINAL CC session id + `forkSession: true` → the SDK reads the
 *     source history but writes a NEW session/transcript (the source is never mutated).
 *   - A NORMAL new chat (no fork source) gets NEITHER `resume` nor `forkSession`.
 *
 * Mirrors execution-handler-skills.test.ts's full-path setup (real DB + git repo +
 * mocked SDK query()).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';

import { mockQueryImplementation } from '../../setup/mocks/mockClaudeAgentSDK';

// @anthropic-ai/claude-agent-sdk is mocked in preload.ts. Mock Octokit (external).
mock.module('@octokit/rest', () => ({
  Octokit: class MockOctokit {
    request = async () => ({ data: {}, status: 200, headers: {} });
    constructor() {}
  },
}));

import { getUserWorkspaceDir } from '@vgit2/shared/constants';

import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { ChatService } from '../../../src/services/ChatService';
import { ClaudeService } from '../../../src/services/ClaudeService';
import { GitLocalService } from '../../../src/services/GitLocalService';
import { MessageDeduplicationService } from '../../../src/services/MessageDeduplicationService';
import { TestContextBuilder } from '../../setup/helpers/testContext';
import { createSimpleTestClaudeService } from '../../setup/helpers/testClaudeService';
import { createTestDbAdapter } from '../../setup/helpers/testDatabase';
import { TestEmitter } from '../../setup/helpers/TestEmitter';
import { MockProcessTrackerService } from '../../setup/mocks/MockProcessTrackerService';
import { MockTunnelService } from '../../setup/mocks/MockTunnelService';

describe('fork-on-first-write — ExecutionHandler SDK options', () => {
  let chatService: ChatService;
  let claudeService: ClaudeService;
  let executionService: ChatExecutionService;
  let emitter: TestEmitter;
  let testUserId: string;
  let authToken: string;
  let setupSucceeded = false;
  const TEST_USERNAME = 'testuser';
  let TEST_REPO_PATH: string;

  beforeEach(async () => {
    setupSucceeded = false;
    mockQueryImplementation.reset();
    try {
      const { TestDatabaseHelper: TDH } = await import('../../setup/helpers/testDatabase');
      if (!(await TDH.getInstance().verifyConnection())) return;

      const { adapter, userId, authToken: token } = await createTestDbAdapter();
      const dbAdapter = adapter;
      testUserId = userId;
      authToken = token;
      TEST_REPO_PATH = `${getUserWorkspaceDir(testUserId)}/testowner/testrepo`;
      await fs.mkdir(TEST_REPO_PATH, { recursive: true });
      execSync('git init', { cwd: TEST_REPO_PATH, stdio: 'ignore' });

      chatService = new ChatService(dbAdapter);
      const claudeConfig = await createSimpleTestClaudeService(testUserId, chatService);
      claudeService = claudeConfig.claudeService;
      authToken = claudeConfig.authToken;
      // Stub the local AI credential so the direct-mode path reaches the mocked query().
      claudeService.setLocalAiCredentialsService({ applyToProcessEnv: () => 'api-key' } as any);

      executionService = new ChatExecutionService(
        chatService,
        claudeService,
        new GitLocalService(),
        new MessageDeduplicationService(),
        new MockTunnelService() as any,
        new MockProcessTrackerService() as any,
        dbAdapter,
        undefined
      );
      emitter = new TestEmitter();
      mockQueryImplementation.setResponse('default', [{ type: 'text', text: 'ok' }]);
      setupSucceeded = true;
    } catch (error) {
      console.warn(
        '[TEST SETUP] test database not available, test skipped:',
        (error as Error).message
      );
    }
  });

  afterEach(async () => {
    if (!setupSucceeded) return;
    const { TestDatabaseHelper } = await import('../../setup/helpers/testDatabase');
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
    try {
      await fs.rm(TEST_REPO_PATH, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function runMessage(chatId: string): Promise<void> {
    const context = new TestContextBuilder()
      .withUserId(testUserId)
      .withUsername(TEST_USERNAME)
      .withChatId(chatId)
      .withEmitter(emitter)
      .withAuthToken(authToken)
      .build();

    await executionService.executeMessage(
      context,
      { content: 'continue please' },
      {
        permissions: 'default',
        model: 'claude-haiku-4',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );
  }

  it('forks from the original CC session (resume + forkSession:true) for a claimed row', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }
    const chatId = 'chat-fork-claim';
    // A claimed fork row: fork_source_session_id set, session_id still null.
    await chatService.saveChat({
      userId: testUserId,
      chatId,
      type: 'claude_code',
      title: 'Forked',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      forkSourceSessionId: 'cc-source-session',
      agentSetupId: 'freestyle',
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    await runMessage(chatId);

    const opts = mockQueryImplementation.getLastOptions();
    expect(opts).not.toBeNull();
    expect(opts?.options.resume).toBe('cc-source-session');
    expect((opts?.options as { forkSession?: boolean }).forkSession).toBe(true);
  });

  it('does NOT resume/fork a normal new chat (no fork source)', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }
    const chatId = 'chat-plain-new';
    await chatService.saveChat({
      userId: testUserId,
      chatId,
      type: 'claude_code',
      title: 'Plain',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      agentSetupId: 'freestyle',
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    await runMessage(chatId);

    const opts = mockQueryImplementation.getLastOptions();
    expect(opts).not.toBeNull();
    expect(opts?.options.resume).toBeUndefined();
    expect((opts?.options as { forkSession?: boolean }).forkSession).toBeUndefined();
  });
});
