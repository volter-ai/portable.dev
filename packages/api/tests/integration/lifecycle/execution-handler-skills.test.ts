/**
 * Repo + global skills enabled in a portable chat.
 *
 * Asserts the SYNCHRONOUS query-options ExecutionHandler builds (captured by the
 * mock SDK the moment query() is called), so it is reliable regardless of the
 * persistence-timing flake the broader lifecycle suite has:
 *   - `skills: 'all'` is passed (the single lever that turns BOTH the cwd repo's own
 *     `.claude/skills/*` AND the user's global `~/.claude/skills/*` ON).
 *   - `settingSources` stays project-only (Q-F2b LOCKED: skills-only — adding the
 *     `'user'` tier would import the user's global settings.json hooks/permissions).
 *   - `'Skill'` is NOT added to allowedTools (deprecated — the `skills` option enables it).
 *
 * The REAL discovery of `~/.claude/skills/*` is a live-SDK/device probe (the mock has
 * no filesystem skill scan) — the SDK init `skills` log line (ExecutionHandler) is the
 * cheap on-device verification.
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

describe('ExecutionHandler enables repo + global skills', () => {
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
      // Inject a stub local AI credential so ExecutionHandler's direct-mode path reaches
      // the (mocked) query() instead of throwing "ANTHROPIC_API_KEY not found" — the
      // const credential check is frozen at module load and can't be set per-test.
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

  it('passes skills:"all", keeps settingSources project-only, never auto-allows Skill', async () => {
    if (!setupSucceeded) {
      console.warn('[TEST SKIP] test database not available');
      return;
    }
    const chatId = 'chat-rev9-skills';
    await chatService.saveChat({
      userId: testUserId,
      chatId,
      type: 'claude_code',
      title: 'Skills',
      status: undefined,
      repoPath: TEST_REPO_PATH,
      agentSetupId: 'freestyle',
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    const context = new TestContextBuilder()
      .withUserId(testUserId)
      .withUsername(TEST_USERNAME)
      .withChatId(chatId)
      .withEmitter(emitter)
      .withAuthToken(authToken)
      .build();

    await executionService.executeMessage(
      context,
      { content: 'test message' },
      {
        permissions: 'default',
        model: 'claude-haiku-4',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );

    const lastOptions = mockQueryImplementation.getLastOptions();
    expect(lastOptions).not.toBeNull();
    // The single lever that turns repo + global ~/.claude/skills ON.
    expect(lastOptions?.options.skills).toBe('all');
    // Q-F2b LOCKED: skills-only — no 'user' tier, so global hooks/permissions stay out.
    expect(lastOptions?.options.settingSources).toEqual(['project']);
    // 'Skill' must NOT be auto-allowed (deprecated; the skills option already enables it).
    expect(lastOptions?.options.allowedTools ?? []).not.toContain('Skill');
  });
});
