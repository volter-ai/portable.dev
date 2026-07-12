/**
 * Start a chat FROM a worktree (portable.dev#17 follow-up) —
 * `ChatExecutionService.handleChatCreate` with the optional `worktree` field.
 *
 * A `chat:create` carrying `worktree` must persist the chat with
 * `repo_path` = the WORKTREE path (the execution cwd — the run happens inside
 * the worktree, not the main checkout), while `repoFullName` stays the GitHub
 * `owner/repo` so the chat card renders normally. The worktree is validated
 * through SourceControlService's containment guard: a path outside the repo
 * that git doesn't list → a deterministic failure, nothing persisted.
 *
 * Boundary: fake ChatService + a real SourceControlService (the nested
 * `.worktrees/<x>` fast path needs no git) over a real temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { SourceControlService } from '../../../src/services/SourceControlService';
import type { AuthService } from '../../../src/services/AuthService';
import type { ConnectionsService } from '../../../src/services/ConnectionsService';
import type { ExecutionContext } from '../../../src/services/types/ExecutionContext';

let repoDir: string;
let worktreeDir: string;

function makeService() {
  const saveChatCalls: any[] = [];
  const fakeChatService: any = {
    saveChat: async (opts: any) => {
      saveChatCalls.push(opts);
      return true;
    },
  };
  const fakeGitLocalService: any = {
    resolveLocalRepoPath: async () => repoDir,
  };
  const sourceControlService = new SourceControlService(
    {} as unknown as ConnectionsService,
    {} as unknown as AuthService
  );

  const svc = new ChatExecutionService(
    fakeChatService,
    {} as any, // claudeService — unused by handleChatCreate
    fakeGitLocalService,
    {} as any, // messageDeduplicationService
    undefined, // tunnelService
    undefined, // processTrackerService
    undefined, // dbAdapter
    undefined, // pushNotificationService
    undefined, // sopService
    undefined, // claudeCodeSessions
    undefined, // reposCacheService
    undefined, // handshakeVerificationGate
    undefined, // externalClaudeSessionService
    undefined, // stopOnPcService
    sourceControlService
  );

  const context = {
    chatId: 'chat-wt-1',
    userId: 'user-1',
    username: 'user-1',
    authToken: 'tok',
  } as unknown as ExecutionContext;

  const create = (worktree?: string) =>
    svc.handleChatCreate(context, {
      chatId: 'chat-wt-1',
      type: 'claude_code',
      title: 'Fix the flaky test',
      owner: 'octocat',
      repo: 'hello-world',
      model: 'opus',
      permissions: 'default',
      agentSetupId: 'freestyle',
      worktree,
    });

  return { create, saveChatCalls };
}

describe('handleChatCreate — start a chat from a worktree', () => {
  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-chat-wt-'));
    worktreeDir = path.join(repoDir, '.worktrees', '17');
    fs.mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('persists the chat with repo_path = the worktree path and repoFullName = owner/repo', async () => {
    const { create, saveChatCalls } = makeService();

    const result = await create(worktreeDir);

    expect(result.success).toBe(true);
    expect(result.chat!.repo_path).toBe(worktreeDir);
    expect(result.chat!.repoFullName).toBe('octocat/hello-world');
    expect(saveChatCalls).toHaveLength(1);
    expect(saveChatCalls[0].repoPath).toBe(worktreeDir);
    expect(saveChatCalls[0].repoFullName).toBe('octocat/hello-world');
  });

  it('rejects a worktree path that escapes the repo (nothing persisted)', async () => {
    const { create, saveChatCalls } = makeService();

    const result = await create(path.join(os.tmpdir(), 'somewhere-else'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid worktree path');
    expect(saveChatCalls).toHaveLength(0);
  });

  it('rejects a worktree that does not exist on disk (nothing persisted)', async () => {
    const { create, saveChatCalls } = makeService();

    const result = await create(path.join(repoDir, '.worktrees', 'missing'));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Worktree not found on disk');
    expect(saveChatCalls).toHaveLength(0);
  });

  it('without a worktree the chat keeps the main-checkout repo_path (unchanged behavior)', async () => {
    const { create, saveChatCalls } = makeService();

    const result = await create(undefined);

    expect(result.success).toBe(true);
    expect(result.chat!.repo_path).toBe(repoDir);
    expect(saveChatCalls[0].repoPath).toBe(repoDir);
  });
});
