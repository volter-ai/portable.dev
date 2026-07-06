/**
 * SqliteDbAdapter Tests - SQLite-backed chat/message persistence + JSON migration
 *
 * Migrates chat storage from JSON to SQLite in the user volume.
 *
 * THE STORY: A user's chats and messages are persisted to a SQLite database on
 * the per-user workspace volume (drop-in replacement for JsonDbAdapter) and
 * survive a "sandbox restart" (fresh adapter instance on the same data dir).
 * Users with legacy JSON chat data (chats.json + messages/*.jsonl) are migrated
 * into SQLite automatically on initialize — exactly once (persistent marker),
 * without ever deleting the original JSON files, and without a single malformed
 * record aborting the whole migration.
 *
 * REAL SERVICES:
 * - ✅ SqliteChatStore - real bun:sqlite database (temp dir per test)
 * - ✅ SqliteDbAdapter - real adapter under test
 * - ✅ Migration - real legacy JSON files seeded on disk
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SqliteDbAdapter,
  SQLITE_DB_FILE,
  SQLITE_MIGRATION_MARKER,
} from '../../../src/db/SqliteDbAdapter/index.js';

const USER = 'sqlite-test-user@example.com';
const OTHER_USER = 'someone-else@example.com';

/** A legacy JSON chat row as JsonChatStore wrote it (snake_case, full shape). */
function legacyChatRow(id: string, userId: string, overrides: Record<string, any> = {}) {
  return {
    id,
    user_id: userId,
    type: 'claude_code',
    title: `Legacy ${id}`,
    summary: null,
    status: null,
    hidden: false,
    archived: false,
    last_updated: 1000,
    repo_path: null,
    session_id: null,
    system_prompt: null,
    playwright_device: null,
    model: 'opus',
    permissions: 'bypass_permissions',
    agent_setup_id: 'best-practice',
    parent_chat_id: null,
    workflow_run_id: null,
    routine_id: null,
    last_read_message_id: null,
    linked_issue: null,
    created_at: 900,
    ...overrides,
  };
}

/** Write a legacy JsonChatStore layout (chats.json + messages/*.jsonl) into dataDir. */
async function seedLegacyJson(
  dataDir: string,
  chats: Record<string, any>,
  messagesByChat: Record<string, any[]>
): Promise<void> {
  await fs.mkdir(path.join(dataDir, 'messages'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'chats.json'), JSON.stringify(chats, null, 2), 'utf8');
  for (const [chatId, messages] of Object.entries(messagesByChat)) {
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await fs.writeFile(path.join(dataDir, 'messages', `${chatId}.jsonl`), lines, 'utf8');
  }
}

describe('SqliteDbAdapter - chat/message persistence on SQLite', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-db-adapter-'));
    // Keep the connections SQLite DB inside the temp dir too (defaults to
    // resolveDataDir() = ~/.portable otherwise) so tests stay isolated.
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reports a SQLite adapter type', () => {
    expect(adapter.getAdapterType()).toContain('SQLite');
  });

  it('creates the database file inside the data dir (user volume)', async () => {
    await adapter.saveChat({ userId: USER, chatId: 'c', type: 'claude_code', title: 'c' });
    const stat = await fs.stat(path.join(dataDir, SQLITE_DB_FILE));
    expect(stat.isFile()).toBe(true);
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

  it('skips injected task-notification rows when picking preview messages (public issue #11)', async () => {
    const note = [
      '<task-notification>',
      '<task-id>bvt6pifet</task-id>',
      '<status>completed</status>',
      '<summary>Background command "dev server" finished</summary>',
      '</task-notification>',
    ].join('\n');
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-note',
      type: 'claude_code',
      title: 'Chat note',
    });
    // The SDK injects the status blob into the stream as a user_message — both as a
    // stale first row and as the trailing last row here, so neither preview slot may
    // pick it (the raw XML leaked into every chat card otherwise).
    await adapter.saveMessage('chat-note', 'user_message', { content: note }, 100);
    await adapter.saveMessage('chat-note', 'user_message', { content: 'real question' }, 200);
    await adapter.saveMessage('chat-note', 'assistant_message', { text: 'real answer' }, 300);
    await adapter.saveMessage('chat-note', 'user_message', { content: note }, 400);

    const previews = await adapter.getChatsWithPreviews(USER, 50, 0);
    const chat = previews.find((p) => p.id === 'chat-note')!;
    expect(chat.message_count).toBe(4); // notification rows still count
    expect(chat.first_message_data).toEqual({ content: 'real question' });
    expect(chat.last_message_data).toEqual({ text: 'real answer' });
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

  it('stores and returns a linked issue (JSON column round-trip)', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-li',
      type: 'claude_code',
      title: 'Linked',
    });
    const issue = { owner: 'volter-ai', repo: 'mobile-vgit', number: 1336 };
    expect(await adapter.updateLinkedIssue('chat-li', USER, issue)).toBe(true);

    const chat = await adapter.getChat('chat-li', USER);
    expect(chat!.linked_issue).toEqual(issue);

    expect(await adapter.updateLinkedIssue('chat-li', USER, null)).toBe(true);
    const cleared = await adapter.getChat('chat-li', USER);
    expect(cleared!.linked_issue).toBeNull();
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
    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();

    try {
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
    } finally {
      reloaded.close();
    }
  });
});

describe('SqliteDbAdapter - automatic JSON → SQLite migration on initialize', () => {
  let dataDir: string;
  const openedAdapters: SqliteDbAdapter[] = [];

  /** Create + initialize an adapter, tracking it for cleanup. */
  async function newAdapter(): Promise<SqliteDbAdapter> {
    const a = new SqliteDbAdapter(dataDir, dataDir);
    await a.initialize();
    openedAdapters.push(a);
    return a;
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-migration-'));
  });

  afterEach(async () => {
    for (const a of openedAdapters.splice(0)) {
      a.close();
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('imports legacy chats and messages on initialize, with no user action', async () => {
    await seedLegacyJson(
      dataDir,
      {
        'chat-a': legacyChatRow('chat-a', USER, {
          repo_path: '/workspace/repo-a',
          linked_issue: { owner: 'volter-ai', repo: 'mobile-vgit', number: 7 },
        }),
        'chat-b': legacyChatRow('chat-b', USER, { archived: true }),
      },
      {
        'chat-a': [
          { id: 1, type: 'user_message', data: { text: 'hello' }, timestamp: 100 },
          { id: 2, type: 'assistant_message', data: { text: 'hi' }, timestamp: 200 },
        ],
        'chat-b': [{ id: 1, type: 'user_message', data: { text: 'archived chat' }, timestamp: 50 }],
      }
    );

    const adapter = await newAdapter();

    const active = await adapter.getChats(USER, undefined, false);
    expect(active.map((c) => c.id)).toEqual(['chat-a']);
    const archived = await adapter.getChats(USER, undefined, true);
    expect(archived.map((c) => c.id)).toEqual(['chat-b']);

    const chatA = await adapter.getChat('chat-a', USER);
    expect(chatA!.repo_path).toBe('/workspace/repo-a');
    expect(chatA!.linked_issue).toEqual({ owner: 'volter-ai', repo: 'mobile-vgit', number: 7 });

    const messages = await adapter.getMessages('chat-a');
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe(1);
    expect(messages[0].data).toEqual({ text: 'hello' });
    expect(messages[1].data).toEqual({ text: 'hi' });
  });

  it('imports a legacy chat carrying an effort level, and tolerates one with none', async () => {
    await seedLegacyJson(
      dataDir,
      {
        'chat-effort': legacyChatRow('chat-effort', USER, { effort: 'xhigh' }),
        'chat-no-effort': legacyChatRow('chat-no-effort', USER),
      },
      {}
    );

    const adapter = await newAdapter();

    const withEffort = await adapter.getChat('chat-effort', USER);
    expect(withEffort!.effort).toBe('xhigh');
    const withoutEffort = await adapter.getChat('chat-no-effort', USER);
    expect(withoutEffort!.effort ?? null).toBeNull();
  });

  it('writes a persistent migration marker into the chat data directory itself', async () => {
    await seedLegacyJson(dataDir, { c1: legacyChatRow('c1', USER) }, {});
    await newAdapter();

    const markerPath = path.join(dataDir, SQLITE_MIGRATION_MARKER);
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    expect(marker.migratedAt).toBeDefined();
    expect(marker.chatsImported).toBe(1);
  });

  it('preserves the original JSON files byte-for-byte (recovery path)', async () => {
    await seedLegacyJson(
      dataDir,
      { c1: legacyChatRow('c1', USER) },
      {
        c1: [{ id: 1, type: 'user_message', data: { text: 'keep me' }, timestamp: 1 }],
      }
    );
    const chatsJsonBefore = await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8');
    const jsonlBefore = await fs.readFile(path.join(dataDir, 'messages', 'c1.jsonl'), 'utf8');

    await newAdapter();

    expect(await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8')).toBe(chatsJsonBefore);
    expect(await fs.readFile(path.join(dataDir, 'messages', 'c1.jsonl'), 'utf8')).toBe(jsonlBefore);
  });

  it('runs exactly once: the marker blocks re-import on subsequent startups', async () => {
    await seedLegacyJson(
      dataDir,
      { c1: legacyChatRow('c1', USER) },
      {
        c1: [{ id: 1, type: 'user_message', data: { text: 'one' }, timestamp: 1 }],
      }
    );
    const first = await newAdapter();
    await first.saveMessage('c1', 'user_message', { text: 'post-migration' }, 2);
    first.close();
    openedAdapters.splice(openedAdapters.indexOf(first), 1);

    // A chat added to chats.json AFTER migration must NOT be imported (marker respected)
    const chats = JSON.parse(await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8'));
    chats['late-chat'] = legacyChatRow('late-chat', USER);
    await fs.writeFile(path.join(dataDir, 'chats.json'), JSON.stringify(chats), 'utf8');

    const second = await newAdapter();
    const ids = (await second.getChats(USER)).map((c) => c.id);
    expect(ids).not.toContain('late-chat');

    // No duplicate import: c1 still has its 2 messages (1 migrated + 1 new), not 3
    const messages = await second.getMessages('c1');
    expect(messages).toHaveLength(2);
    expect(messages[1].data).toEqual({ text: 'post-migration' });
  });

  it('continues numbering message ids after the migrated maximum', async () => {
    await seedLegacyJson(
      dataDir,
      { c1: legacyChatRow('c1', USER) },
      {
        c1: [
          { id: 1, type: 'user_message', data: { text: 'a' }, timestamp: 1 },
          { id: 2, type: 'assistant_message', data: { text: 'b' }, timestamp: 2 },
        ],
      }
    );
    const adapter = await newAdapter();

    await adapter.saveMessage('c1', 'user_message', { text: 'c' }, 3);
    const messages = await adapter.getMessages('c1');
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('skips malformed JSONL lines without aborting the migration', async () => {
    await seedLegacyJson(dataDir, { c1: legacyChatRow('c1', USER) }, {});
    await fs.writeFile(
      path.join(dataDir, 'messages', 'c1.jsonl'),
      [
        JSON.stringify({ id: 1, type: 'user_message', data: { text: 'good 1' }, timestamp: 1 }),
        '{ this is not valid json !!!',
        JSON.stringify({ id: 3, type: 'user_message', data: { text: 'good 2' }, timestamp: 3 }),
      ].join('\n') + '\n',
      'utf8'
    );

    const adapter = await newAdapter();

    const messages = await adapter.getMessages('c1');
    expect(messages.map((m) => m.data)).toEqual([{ text: 'good 1' }, { text: 'good 2' }]);

    const marker = JSON.parse(
      await fs.readFile(path.join(dataDir, SQLITE_MIGRATION_MARKER), 'utf8')
    );
    expect(marker.messagesImported).toBe(2);
    expect(marker.messagesSkipped).toBe(1);
  });

  it('survives a fully corrupt chats.json: still imports messages and initializes', async () => {
    await fs.mkdir(path.join(dataDir, 'messages'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'chats.json'), '{"truncated": ', 'utf8');
    await fs.writeFile(
      path.join(dataDir, 'messages', 'c1.jsonl'),
      JSON.stringify({ id: 1, type: 'user_message', data: { text: 'salvaged' }, timestamp: 1 }) +
        '\n',
      'utf8'
    );

    const adapter = await newAdapter(); // must not throw

    // Messages were salvaged even though the chat directory was lost
    const messages = await adapter.getMessages('c1');
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toEqual({ text: 'salvaged' });

    // Marker records the failure for recovery; corrupt original is preserved
    const marker = JSON.parse(
      await fs.readFile(path.join(dataDir, SQLITE_MIGRATION_MARKER), 'utf8')
    );
    expect(marker.chatsJsonError).toBeDefined();
    expect(await fs.readFile(path.join(dataDir, 'chats.json'), 'utf8')).toBe('{"truncated": ');
  });

  it('imports orphan message files (jsonl without a chat row)', async () => {
    await seedLegacyJson(
      dataDir,
      { c1: legacyChatRow('c1', USER) },
      {
        orphan: [{ id: 1, type: 'user_message', data: { text: 'orphaned' }, timestamp: 1 }],
      }
    );

    const adapter = await newAdapter();

    const messages = await adapter.getMessages('orphan');
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toEqual({ text: 'orphaned' });
  });

  it('does nothing on a fresh volume (no legacy JSON): no marker, adapter fully functional', async () => {
    const adapter = await newAdapter();

    await expect(fs.access(path.join(dataDir, SQLITE_MIGRATION_MARKER))).rejects.toThrow();

    await adapter.saveChat({ userId: USER, chatId: 'new', type: 'claude_code', title: 'New' });
    expect((await adapter.getChats(USER)).map((c) => c.id)).toEqual(['new']);
  });
});

describe('SqliteDbAdapter - Saved category + Pin (long-press menu)', () => {
  let dataDir: string;
  let adapter: SqliteDbAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-saved-pin-'));
    adapter = new SqliteDbAdapter(dataDir, dataDir);
    await adapter.initialize();
  });

  afterEach(async () => {
    adapter.close();
    // Windows can briefly hold the just-closed SQLite file handle → fs.rm EBUSY.
    // The dir is an OS temp dir, so a failed cleanup is harmless; never fail the test on it.
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed(id: string) {
    await adapter.saveChat({ userId: USER, chatId: id, type: 'claude_code', title: id });
  }

  it('partitions Active / Saved / Archived via the category filter', async () => {
    await seed('active-1');
    await seed('saved-1');
    await seed('archived-1');
    expect(await adapter.setChatSaved('saved-1', USER, true)).toBe(true);
    expect(await adapter.archiveChat('archived-1', USER, true)).toBe(true);

    const active = await adapter.getChats(USER, undefined, undefined, undefined, 'active');
    expect(active.map((c) => c.id)).toEqual(['active-1']);

    const saved = await adapter.getChats(USER, undefined, undefined, undefined, 'saved');
    expect(saved.map((c) => c.id)).toEqual(['saved-1']);

    const archived = await adapter.getChats(USER, undefined, undefined, undefined, 'archived');
    expect(archived.map((c) => c.id)).toEqual(['archived-1']);
  });

  it('keeps Saved and Archived mutually exclusive (each clears the other)', async () => {
    await seed('c');
    // Save → archive: archiving clears saved.
    expect(await adapter.setChatSaved('c', USER, true)).toBe(true);
    expect(await adapter.archiveChat('c', USER, true)).toBe(true);
    let saved = await adapter.getChats(USER, undefined, undefined, undefined, 'saved');
    let archived = await adapter.getChats(USER, undefined, undefined, undefined, 'archived');
    expect(saved.map((c) => c.id)).toEqual([]);
    expect(archived.map((c) => c.id)).toEqual(['c']);

    // Archive → save: saving clears archived.
    expect(await adapter.setChatSaved('c', USER, true)).toBe(true);
    saved = await adapter.getChats(USER, undefined, undefined, undefined, 'saved');
    archived = await adapter.getChats(USER, undefined, undefined, undefined, 'archived');
    expect(saved.map((c) => c.id)).toEqual(['c']);
    expect(archived.map((c) => c.id)).toEqual([]);
  });

  it('legacy archived=false still includes saved chats (terminal back-compat)', async () => {
    await seed('a');
    await seed('s');
    await adapter.setChatSaved('s', USER, true);
    // No category → the legacy archived boolean path: "not archived" includes saved.
    const notArchived = await adapter.getChats(USER, undefined, false);
    expect(notArchived.map((c) => c.id).sort()).toEqual(['a', 's']);
  });

  it('floats pinned chats to the top regardless of recency, and unpins', async () => {
    await seed('old-pinned');
    await seed('new-unpinned');
    // Make the unpinned chat strictly the most recent.
    await adapter.saveMessage('new-unpinned', 'user_message', { text: 'fresh' }, 9_999_999_999_999);
    expect(await adapter.setChatPinned('old-pinned', USER, true)).toBe(true);

    let chats = await adapter.getChats(USER, undefined, undefined, undefined, 'active');
    expect(chats.map((c) => c.id)).toEqual(['old-pinned', 'new-unpinned']);
    expect((chats[0] as any).pinned).toBe(1);

    // Unpin → falls back to pure recency (newest first).
    expect(await adapter.setChatPinned('old-pinned', USER, false)).toBe(true);
    chats = await adapter.getChats(USER, undefined, undefined, undefined, 'active');
    expect(chats.map((c) => c.id)).toEqual(['new-unpinned', 'old-pinned']);
  });

  it('pin is orthogonal — a pinned chat stays in its category', async () => {
    await seed('p');
    await adapter.setChatPinned('p', USER, true);
    await adapter.setChatSaved('p', USER, true);
    const saved = await adapter.getChats(USER, undefined, undefined, undefined, 'saved');
    expect(saved.map((c) => c.id)).toEqual(['p']);
    expect((saved[0] as any).pinned).toBe(1);
    expect((saved[0] as any).saved).toBe(1);
  });

  it('saved/pinned survive a restart (new adapter, same dir)', async () => {
    await seed('keep');
    await adapter.setChatSaved('keep', USER, true);
    await adapter.setChatPinned('keep', USER, true);

    adapter.close();
    const reloaded = new SqliteDbAdapter(dataDir, dataDir);
    await reloaded.initialize();
    try {
      const saved = await reloaded.getChats(USER, undefined, undefined, undefined, 'saved');
      expect(saved.map((c) => c.id)).toEqual(['keep']);
      expect((saved[0] as any).pinned).toBe(1);
    } finally {
      reloaded.close();
    }
  });

  it('reports false when saving/pinning a non-existent chat', async () => {
    expect(await adapter.setChatSaved('nope', USER, true)).toBe(false);
    expect(await adapter.setChatPinned('nope', USER, true)).toBe(false);
  });
});
