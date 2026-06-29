/**
 * JsonDbAdapter Tests - JSON file-backed chat/message persistence
 *
 * Chat and message persistence lives in JSON file storage on the per-user
 * workspace volume.
 *
 * THE STORY: A user's chats and messages are persisted to JSON files,
 * survive a "sandbox restart" (a fresh adapter instance pointed at the same data dir),
 * and never touch the wrapped delegate adapter for chat/message operations.
 *
 * REAL SERVICES:
 * - ✅ JsonChatStore - real filesystem reads/writes (temp dir per test)
 * - ✅ JsonDbAdapter - real adapter under test
 *
 * STUBBED:
 * - 🔴 Wrapped delegate adapter - a Proxy that THROWS if any chat/message method
 *   is invoked, proving chat data never hits the wrapped adapter. Non-chat domains
 *   (connections, themes, etc.) still delegate to it in production.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JsonDbAdapter } from '../../../src/db/JsonDbAdapter/index.js';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

const USER = 'json-test-user@example.com';
const OTHER_USER = 'someone-else@example.com';

/**
 * A wrapped adapter that throws for every method except the lifecycle hooks
 * the JsonDbAdapter is allowed to delegate (initialize/isHealthy/getAdapterType).
 * Any chat/message call reaching this proves a regression (the wrapped adapter was touched).
 */
function makeThrowingWrapped(): DbAdapter {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'initialize' || prop === 'isHealthy') {
          return async () => true;
        }
        if (prop === 'getAdapterType') {
          return () => 'StubBase';
        }
        return async () => {
          throw new Error(
            `Wrapped base adapter method '${prop}' must not be called for chat/message ops`
          );
        };
      },
    }
  ) as unknown as DbAdapter;
}

describe('JsonDbAdapter - chat/message persistence on JSON files', () => {
  let dataDir: string;
  let adapter: JsonDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-db-adapter-'));
    adapter = new JsonDbAdapter(makeThrowingWrapped(), dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reports a JSON adapter type', () => {
    expect(adapter.getAdapterType()).toContain('JSON');
  });

  it('saves a chat and reads it back with camelCase + snake_case parity', async () => {
    const ok = await adapter.saveChat({
      userId: USER,
      chatId: 'chat-1',
      type: 'claude_code',
      title: 'My first chat',
      repoPath: '/workspace/repo-a',
    });
    expect(ok).toBe(true);

    const chat = await adapter.getChat('chat-1', USER);
    expect(chat).toBeDefined();
    expect(chat!.id).toBe('chat-1');
    expect(chat!.user_id).toBe(USER);
    expect(chat!.title).toBe('My first chat');
    expect(chat!.repo_path).toBe('/workspace/repo-a');
    // Defaults match the schema defaults
    expect(chat!.model).toBe('opus');
    expect(chat!.permissions).toBe('bypass_permissions');
    expect(chat!.agent_setup_id).toBe('freestyle');
    expect(chat!.hidden).toBe(0);
    expect(chat!.archived).toBe(0);
    // camelCase aliases present (drop-in parity with the legacy adapter output)
    expect((chat as any).repoPath).toBe('/workspace/repo-a');
    expect((chat as any).agentSetupId).toBe('freestyle');
  });

  it('does not leak chats across users', async () => {
    await adapter.saveChat({ userId: USER, chatId: 'mine', type: 'claude_code', title: 'Mine' });
    await adapter.saveChat({
      userId: OTHER_USER,
      chatId: 'theirs',
      type: 'claude_code',
      title: 'Theirs',
    });

    const mine = await adapter.getChats(USER);
    expect(mine.map((c) => c.id)).toEqual(['mine']);

    expect(await adapter.getChat('theirs', USER)).toBeUndefined();
    expect(await adapter.getChat('theirs', OTHER_USER)).toBeDefined();
  });

  it('saves messages with sequential numeric ids and reads them ordered by timestamp', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-2',
      type: 'claude_code',
      title: 'Chat 2',
    });

    await adapter.saveMessage('chat-2', 'user_message', { text: 'hello' }, 1000);
    await adapter.saveMessage('chat-2', 'assistant_message', { text: 'hi there' }, 2000);

    const messages = await adapter.getMessages('chat-2');
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe(1);
    expect(messages[1].id).toBe(2);
    expect(messages[0].type).toBe('user_message');
    expect(messages[0].data).toEqual({ text: 'hello' });
    expect(messages[1].timestamp).toBe(2000);

    expect(await adapter.getMessageCount('chat-2')).toBe(2);

    // saving a message bumps the chat's last_updated
    const chat = await adapter.getChat('chat-2', USER);
    expect(chat!.last_updated).toBeGreaterThanOrEqual(2000);
  });

  it('returns chats with previews (counts + first/last message data)', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-3',
      type: 'claude_code',
      title: 'Chat 3',
    });
    await adapter.saveMessage('chat-3', 'user_message', { text: 'first' }, 100);
    await adapter.saveMessage('chat-3', 'assistant_message', { text: 'middle' }, 200);
    await adapter.saveMessage('chat-3', 'assistant_message', { text: 'last' }, 300);

    const previews = await adapter.getChatsWithPreviews(USER, 50, 0);
    expect(previews).toHaveLength(1);
    expect(previews[0].id).toBe('chat-3');
    expect(previews[0].message_count).toBe(3);
    expect(previews[0].first_message_data).toEqual({ text: 'first' });
    expect(previews[0].last_message_data).toEqual({ text: 'last' });
  });

  it('updates chat metadata fields', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-4',
      type: 'claude_code',
      title: 'Old title',
    });

    expect(await adapter.updateChatTitle('chat-4', USER, 'New title')).toBe(true);
    expect(await adapter.updateChatStatus('chat-4', USER, 'completed')).toBe(true);
    expect(await adapter.updateChatSummary('chat-4', USER, 'a summary')).toBe(true);
    expect(await adapter.updateModel('chat-4', USER, 'haiku')).toBe(true);
    expect(await adapter.updatePermissions('chat-4', USER, 'plan')).toBe(true);
    expect(await adapter.updateChatSession('chat-4', USER, 'sess-abc', 'system prompt')).toBe(true);
    expect(await adapter.updateLastReadMessageId('chat-4', USER, 5)).toBe(true);

    const chat = await adapter.getChat('chat-4', USER);
    expect(chat!.title).toBe('New title');
    expect(chat!.status).toBe('completed');
    expect(chat!.summary).toBe('a summary');
    expect(chat!.model).toBe('haiku');
    expect(chat!.permissions).toBe('plan');
    expect(chat!.session_id).toBe('sess-abc');
    expect(chat!.system_prompt).toBe('system prompt');
    expect(chat!.last_read_message_id).toBe(5);
  });

  it('returns false when updating a non-existent chat (methods that report rows-affected)', async () => {
    expect(await adapter.updateChatSummary('nope', USER, 'x')).toBe(false);
    expect(await adapter.updateModel('nope', USER, 'haiku')).toBe(false);
    expect(await adapter.archiveChat('nope', USER, true)).toBe(false);
  });

  it('archives chats and filters by archived flag', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-5',
      type: 'claude_code',
      title: 'Chat 5',
    });
    expect(await adapter.archiveChat('chat-5', USER, true)).toBe(true);

    const active = await adapter.getChats(USER, undefined, false);
    expect(active.find((c) => c.id === 'chat-5')).toBeUndefined();

    const archived = await adapter.getChats(USER, undefined, true);
    expect(archived.find((c) => c.id === 'chat-5')).toBeDefined();
  });

  it('maps last chat activity by repo path', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'r1',
      type: 'claude_code',
      title: 'r1',
      repoPath: '/repo/x',
    });
    await adapter.saveChat({
      userId: USER,
      chatId: 'r2',
      type: 'claude_code',
      title: 'r2',
      repoPath: '/repo/y',
    });

    const map = await adapter.getLastChatActivityByRepo(USER);
    expect(map.has('/repo/x')).toBe(true);
    expect(map.has('/repo/y')).toBe(true);
    // ISO string
    expect(() => new Date(map.get('/repo/x')!).toISOString()).not.toThrow();
  });

  it('finds chats by workflow run id', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'wf-chat',
      type: 'claude_code',
      title: 'WF',
      workflowRunId: 'run-123',
    });

    const found = await adapter.getChatsByWorkflowRunId('run-123');
    expect(found.map((c) => c.id)).toContain('wf-chat');
  });

  it('deletes a chat and its messages', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-7',
      type: 'claude_code',
      title: 'Chat 7',
    });
    await adapter.saveMessage('chat-7', 'user_message', { text: 'hi' }, 1);

    expect(await adapter.deleteChat('chat-7', USER)).toBe(true);
    expect(await adapter.getChat('chat-7', USER)).toBeUndefined();
    expect(await adapter.getMessages('chat-7')).toEqual([]);
  });

  it('persists chats and messages across a "sandbox restart" (new adapter, same dir)', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'persist',
      type: 'claude_code',
      title: 'Persist me',
    });
    await adapter.saveMessage('persist', 'user_message', { text: 'remember this' }, 500);
    await adapter.saveMessage('persist', 'assistant_message', { text: 'remembered' }, 600);

    // Simulate restart: brand-new adapter instance pointed at the same data dir
    const reloaded = new JsonDbAdapter(makeThrowingWrapped(), dataDir);
    await reloaded.initialize();

    const chats = await reloaded.getChats(USER);
    expect(chats.map((c) => c.id)).toContain('persist');

    const messages = await reloaded.getMessages('persist');
    expect(messages).toHaveLength(2);
    expect(messages[0].data).toEqual({ text: 'remember this' });
    expect(messages[1].id).toBe(2);

    // continuing to add messages keeps ids monotonic after reload
    await reloaded.saveMessage('persist', 'user_message', { text: 'and this' }, 700);
    const after = await reloaded.getMessages('persist');
    expect(after).toHaveLength(3);
    expect(after[2].id).toBe(3);
  });
});
