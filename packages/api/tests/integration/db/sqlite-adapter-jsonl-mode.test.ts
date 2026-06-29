/**
 * SqliteDbAdapter in JSONL mode (CHAT_MESSAGE_SOURCE=jsonl).
 *
 * The end-to-end correctness anchor for "all my chats": a session run in the PC
 * terminal `claude` (a `~/.claude/projects` transcript with NO SQLite row) appears in
 * the app chat list AND opens + renders its messages — scoped to the workspace's repos.
 * A transcript outside the workspace repos does NOT appear. SqliteDbAdapter is
 * pure local SQLite, so this runs with temp dirs and no external database.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { SqliteDbAdapter } from '../../../src/db/SqliteDbAdapter/SqliteDbAdapter';
import { slugForCwd } from '../../../src/db/ClaudeProjects/projectsPaths';

const USER = 'local@host';
let root: string;
let configDir: string;
let dataDir: string;
let connDir: string;
let repoCwd: string;
let adapter: SqliteDbAdapter;

function jline(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

async function writeTranscript(cwd: string, session: string, lines?: string[]): Promise<void> {
  const dir = path.join(configDir, 'projects', slugForCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const content = (
    lines ?? [
      jline({
        type: 'user',
        message: { role: 'user', content: 'start dev server' },
        uuid: 'u1',
        timestamp: '2026-06-25T10:00:00.000Z',
        cwd,
        sessionId: session,
      }),
      jline({
        type: 'assistant',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'starting…' }] },
        uuid: 'a1',
        timestamp: '2026-06-25T10:00:01.000Z',
        sessionId: session,
      }),
      jline({ type: 'ai-title', aiTitle: 'Start dev server', sessionId: session }),
    ]
  ).join('\n');
  await fs.writeFile(path.join(dir, `${session}.jsonl`), content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rev9-jsonlmode-'));
  configDir = path.join(root, 'config');
  dataDir = path.join(root, 'chat-data');
  connDir = path.join(root, 'conn-data');
  repoCwd = path.join(root, 'ws', 'clock-app');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(repoCwd, { recursive: true });

  adapter = new SqliteDbAdapter(dataDir, connDir, {
    configDir,
    reposProvider: async () => [{ full_name: 'me/clock-app', localPath: repoCwd }],
  });
  await adapter.initialize();
});

afterEach(async () => {
  adapter.close();
  // Best-effort temp cleanup. On Windows bun:sqlite can briefly hold the db file
  // locked after close() → EBUSY on rm; retry a couple of times, then give up (the
  // OS reaps the temp dir). Never fail the test on cleanup.
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('SqliteDbAdapter jsonl mode — terminal chats', () => {
  it('lists a terminal-originated transcript (no SQLite row) scoped to a workspace repo', async () => {
    await writeTranscript(repoCwd, 'sess-terminal');
    // a transcript OUTSIDE the workspace repos must NOT appear
    await writeTranscript(path.join(root, 'elsewhere'), 'sess-outside');

    const chats = await adapter.getChats(USER);
    const ids = chats.map((c) => c.id);
    expect(ids).toContain('sess-terminal');
    expect(ids).not.toContain('sess-outside');

    const terminal = chats.find((c) => c.id === 'sess-terminal')!;
    expect(terminal.title).toBe('Start dev server');
    expect(terminal.repo_path).toBe(repoCwd);
    expect(terminal.session_id).toBe('sess-terminal');
    // chat-list "Workspace" fix: the GitHub full_name rides on the list item so
    // the mobile client shows the repo NAME instead of parsing the raw disk repo_path.
    expect((terminal as { repoFullName?: string }).repoFullName).toBe('me/clock-app');
  });

  it('opens a terminal chat (getChat) and reads its messages from the JSONL transcript', async () => {
    await writeTranscript(repoCwd, 'sess-open');

    const chat = await adapter.getChat('sess-open', USER);
    expect(chat?.id).toBe('sess-open');

    const messages = await adapter.getMessages('sess-open');
    expect(messages.map((m) => m.type)).toEqual(['user_message', 'claude_code_block']);
    expect((messages[0].data as any).content).toBe('start dev server');
    expect((messages[1].data as any).content).toBe('starting…');
    expect(await adapter.getMessageCount('sess-open')).toBe(2);
  });

  it('surfaces previews for a terminal chat in getChatsWithPreviews', async () => {
    await writeTranscript(repoCwd, 'sess-prev');
    const previews = await adapter.getChatsWithPreviews(USER);
    const p = previews.find((x) => x.id === 'sess-prev');
    expect(p).toBeDefined();
    expect(p.message_count).toBe(2);
    expect(p.first_message_data.content).toBe('start dev server');
  });

  it('reconciles a portable SQLite chat with its transcript by session_id (no duplicate)', async () => {
    await writeTranscript(repoCwd, 'sess-portable');
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-portable',
      type: 'claude_code',
      title: 'Portable chat',
      repoPath: repoCwd,
    });
    // bind the portable chat to the transcript's session id (as the SDK init would)
    await adapter.updateChatSession('chat-portable', USER, 'sess-portable', 'sys');

    const chats = await adapter.getChats(USER);
    const sessionRows = chats.filter((c) => c.session_id === 'sess-portable');
    // exactly ONE row for the session (the SQLite row is the overlay; the transcript
    // is NOT also surfaced as a separate terminal chat).
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0].id).toBe('chat-portable');
    // and its messages come from the JSONL transcript (read-through)
    const messages = await adapter.getMessages('chat-portable');
    expect(messages.map((m) => m.type)).toEqual(['user_message', 'claude_code_block']);
  });

  it('portableOnly returns ONLY messaged portable chats — excludes imported transcripts + unmessaged rows', async () => {
    // 1. An IMPORTED terminal transcript (no SQLite row) — must be EXCLUDED.
    await writeTranscript(repoCwd, 'sess-imported');
    // 2. A portable chat that was MESSAGED (session_id bound) — must be INCLUDED.
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-msg',
      type: 'claude_code',
      title: 'Messaged in portable',
      repoPath: repoCwd,
    });
    await adapter.updateChatSession('chat-msg', USER, 'sess-msg', 'sys');
    // 3. A portable chat CREATED but never messaged (no session_id) — must be EXCLUDED.
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-empty',
      type: 'claude_code',
      title: 'Never messaged',
      repoPath: repoCwd,
    });

    const portable = await adapter.getChats(USER, undefined, undefined, true);
    const ids = portable.map((c) => c.id);
    expect(ids).toContain('chat-msg');
    expect(ids).not.toContain('sess-imported');
    expect(ids).not.toContain('chat-empty');

    // The previews variant honors it too.
    const previews = await adapter.getChatsWithPreviews(USER, 50, 0, undefined, undefined, true);
    const pids = previews.map((p) => p.id);
    expect(pids).toContain('chat-msg');
    expect(pids).not.toContain('sess-imported');
    expect(pids).not.toContain('chat-empty');

    // Default (no portableOnly) STILL surfaces the imported transcript — the mobile
    // app's behavior is unchanged.
    expect((await adapter.getChats(USER)).map((c) => c.id)).toContain('sess-imported');
  });

  it('opens + reads a terminal chat run in a repo SUBDIR (cwd != repo root)', async () => {
    // A very common workflow: `claude` launched inside <repo>/packages/api. The
    // transcript is filed under slug(<repo>/packages/api), not slug(<repo>), so reading
    // it by the repo root would 404 → an empty chat with a (misleading) preview.
    const subCwd = path.join(repoCwd, 'packages', 'api');
    await writeTranscript(subCwd, 'sess-subdir');

    const chats = await adapter.getChats(USER);
    const terminal = chats.find((c) => c.id === 'sess-subdir');
    expect(terminal).toBeDefined();
    expect(terminal!.repo_path).toBe(repoCwd); // displayed under the repo root

    // and it actually OPENS with its messages (not empty)
    const messages = await adapter.getMessages('sess-subdir');
    expect(messages.map((m) => m.type)).toEqual(['user_message', 'claude_code_block']);
    expect(await adapter.getMessageCount('sess-subdir')).toBe(2);
  });

  it('reads a chat whose SQLite ROW is the repo ROOT but whose session ran in a SUBDIR', async () => {
    // The exact regression: a terminal chat run in <repo>/packages/api gets reconciled
    // into a SQLite ROW carrying repo_path = the REPO ROOT (for display/git) + session_id.
    // The transcript is filed under slug(<repo>/packages/api), so the resolver's first
    // branch (locate by repo_path) 404s — it MUST fall back to discovery (the real cwd) or
    // the chat opens EMPTY ("previous messages don't show"). Without the fix this returns 0.
    const subCwd = path.join(repoCwd, 'packages', 'api');
    await writeTranscript(subCwd, 'sess-sub-row');
    await adapter.saveChat({
      userId: USER,
      chatId: 'sess-sub-row',
      type: 'claude_code',
      title: 'Subdir chat',
      repoPath: repoCwd, // the REPO ROOT, NOT the subdir cwd the session actually ran in
    });
    await adapter.updateChatSession('sess-sub-row', USER, 'sess-sub-row', 'sys');

    const messages = await adapter.getMessages('sess-sub-row');
    expect(messages.map((m) => m.type)).toEqual(['user_message', 'claude_code_block']);
    expect(await adapter.getMessageCount('sess-sub-row')).toBe(2);
  });

  it('persists a portable OVERLAY (synthesized media) and merges it on read', async () => {
    await writeTranscript(repoCwd, 'sess-overlay');
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-ov',
      type: 'claude_code',
      title: 'Ov',
      repoPath: repoCwd,
    });
    await adapter.updateChatSession('chat-ov', USER, 'sess-overlay', 'sys');

    // a plain SDK row is dropped (read from JSONL); an image overlay is kept
    await adapter.saveMessage('chat-ov', 'user_message', { content: 'dup' }, 1000);
    await adapter.saveMessage(
      'chat-ov',
      'claude_code_block',
      { type: 'image', blockId: 'img1', source: { url: '/data/media/u/x.webp' } },
      Date.parse('2026-06-25T10:00:05.000Z')
    );

    const messages = await adapter.getMessages('chat-ov');
    const types = messages.map((m) => (m.data as any)?.type ?? m.type);
    expect(types).toEqual(['user_message', 'text', 'image']); // JSONL turns + the overlay image
  });
});

describe('SqliteDbAdapter.getChatOrigin (fork-on-first-write)', () => {
  it('classifies a discovered Claude Code transcript (no row) as discovered', async () => {
    await writeTranscript(repoCwd, 'sess-cc');

    const origin = await adapter.getChatOrigin('sess-cc', USER);
    expect(origin.origin).toBe('discovered');
    if (origin.origin === 'discovered') {
      expect(origin.sourceSessionId).toBe('sess-cc');
      expect(origin.cwd).toBe(repoCwd);
      expect(origin.repoPath).toBe(repoCwd);
      expect(origin.repoFullName).toBe('me/clock-app');
      expect(origin.title).toBe('Start dev server');
    }
  });

  it('classifies a real Portable chat row as sqlite', async () => {
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-real',
      type: 'claude_code',
      title: 'Portable chat',
      repoPath: repoCwd,
    });
    expect((await adapter.getChatOrigin('chat-real', USER)).origin).toBe('sqlite');
  });

  it('classifies an unknown chatId as none', async () => {
    expect((await adapter.getChatOrigin('nope', USER)).origin).toBe('none');
  });

  it('persists repo_full_name + fork_source_session_id on a claimed fork row', async () => {
    await writeTranscript(repoCwd, 'sess-src');
    await adapter.saveChat({
      userId: USER,
      chatId: 'chat-fork',
      type: 'claude_code',
      title: 'Forked chat',
      repoPath: repoCwd,
      repoFullName: 'me/clock-app',
      forkSourceSessionId: 'sess-src',
    });

    // A claimed (not-yet-run) fork row has a fork source but no session id → still sqlite origin.
    expect((await adapter.getChatOrigin('chat-fork', USER)).origin).toBe('sqlite');
    const chat = (await adapter.getChat('chat-fork', USER)) as {
      fork_source_session_id?: string | null;
      repoFullName?: string;
    };
    expect(chat.fork_source_session_id).toBe('sess-src');
    expect(chat.repoFullName).toBe('me/clock-app');

    // The original CC transcript STILL lists as its own card (origin unchanged) — the
    // fork does not hide or mutate it.
    expect((await adapter.getChatOrigin('sess-src', USER)).origin).toBe('discovered');
  });
});
