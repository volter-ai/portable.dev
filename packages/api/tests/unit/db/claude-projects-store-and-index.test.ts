/**
 * ClaudeProjects paths, message store (JSONL + overlay merge),
 * and chat-list discovery (scoped to the workspace's repos). Exercised against real
 * temp dirs (these are pure fs/SQLite units).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  ClaudeProjectsChatIndex,
  matchRepo,
} from '../../../src/db/ClaudeProjects/ClaudeProjectsChatIndex';
import {
  ClaudeProjectsMessageStore,
  isOverlayMessage,
  mergeStreams,
} from '../../../src/db/ClaudeProjects/ClaudeProjectsMessageStore';
import { OverlayMessageStore } from '../../../src/db/ClaudeProjects/OverlayMessageStore';
import {
  listProjectTranscripts,
  slugForCwd,
  transcriptPath,
} from '../../../src/db/ClaudeProjects/projectsPaths';

let root: string;
let configDir: string;
let wsRoot: string;

function jline(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** A minimal valid transcript (one user turn + one assistant text turn) at a given cwd. */
function sampleTranscript(cwd: string, session: string, userText = 'hello there'): string {
  return [
    jline({
      type: 'user',
      message: { role: 'user', content: userText },
      uuid: 'u1',
      timestamp: '2026-06-25T10:00:00.000Z',
      cwd,
      sessionId: session,
    }),
    jline({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
      uuid: 'a1',
      timestamp: '2026-06-25T10:00:01.000Z',
      sessionId: session,
    }),
    jline({ type: 'ai-title', aiTitle: 'A friendly greeting', sessionId: session }),
  ].join('\n');
}

async function writeTranscript(cwd: string, session: string, content?: string): Promise<string> {
  const dir = path.join(configDir, 'projects', slugForCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  await fs.writeFile(file, content ?? sampleTranscript(cwd, session));
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rev9-cp-'));
  configDir = path.join(root, 'config');
  wsRoot = path.join(root, 'ws');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(wsRoot, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('projectsPaths', () => {
  it('slugForCwd replaces every non-alphanumeric char with "-" (matches the SDK)', () => {
    expect(slugForCwd('/Users/x/claude-workspace/local_h.local/Owner/clock-app-21')).toBe(
      '-Users-x-claude-workspace-local-h-local-Owner-clock-app-21'
    );
  });

  it('transcriptPath slugs the repo_path forward', () => {
    expect(transcriptPath('/cfg', '/a/b', 'sess')).toBe(
      path.join('/cfg', 'projects', '-a-b', 'sess.jsonl')
    );
  });

  it('listProjectTranscripts finds TOP-LEVEL transcripts and EXCLUDES subagent/workflow subdirs', async () => {
    const cwd = path.join(wsRoot, 'repo');
    await writeTranscript(cwd, 'sess-main');
    // a sub-agent transcript nested under <session>/subagents/ must NOT be listed
    const subDir = path.join(configDir, 'projects', slugForCwd(cwd), 'sess-main', 'subagents');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      path.join(subDir, 'agent-abc.jsonl'),
      jline({ type: 'user', message: { content: 'sub' } })
    );

    const found = await listProjectTranscripts(configDir);
    expect(found.map((f) => f.sessionId)).toEqual(['sess-main']);
  });

  it('returns [] for a missing projects dir (never throws)', async () => {
    expect(await listProjectTranscripts(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('matchRepo (scope filter)', () => {
  const repos = [
    { full_name: 'me/repo', localPath: '/ws/repo' },
    { full_name: 'me/repo-sub', localPath: '/ws/repo/sub' },
  ];
  it('matches a cwd that is / is under a repo, longest-prefix wins', () => {
    expect(matchRepo('/ws/repo', repos)?.full_name).toBe('me/repo');
    expect(matchRepo('/ws/repo/src', repos)?.full_name).toBe('me/repo');
    expect(matchRepo('/ws/repo/sub/x', repos)?.full_name).toBe('me/repo-sub'); // longest prefix
  });
  it('excludes a cwd that is not under any repo', () => {
    expect(matchRepo('/tmp/other', repos)).toBeNull();
    expect(matchRepo('/ws', repos)).toBeNull(); // workspace root, not a repo
  });
});

describe('ClaudeProjectsChatIndex.discoverChats', () => {
  it('discovers in-scope transcripts, excludes out-of-scope, empty, and unknown-repo ones', async () => {
    const repoCwd = path.join(wsRoot, 'clock-app');
    const subCwd = path.join(repoCwd, 'src'); // a subdir of the repo → in scope
    const outCwd = path.join(root, 'elsewhere'); // not under any workspace repo
    await writeTranscript(repoCwd, 'sess-in');
    await writeTranscript(subCwd, 'sess-sub');
    await writeTranscript(outCwd, 'sess-out');
    // an empty / meta-only transcript must never become a phantom chat
    await writeTranscript(
      repoCwd,
      'sess-empty',
      jline({ type: 'ai-title', aiTitle: 'x', sessionId: 'sess-empty' })
    );

    const index = new ClaudeProjectsChatIndex(configDir);
    const repos = [{ full_name: 'me/clock-app', localPath: repoCwd }];
    const chats = await index.discoverChats(repos);

    const ids = chats.map((c) => c.sessionId).sort();
    expect(ids).toEqual(['sess-in', 'sess-sub']);
    const inChat = chats.find((c) => c.sessionId === 'sess-in')!;
    expect(inChat.repoPath).toBe(repoCwd);
    expect(inChat.repoFullName).toBe('me/clock-app');
    expect(inChat.title).toBe('A friendly greeting');
    expect(inChat.messageCount).toBe(2); // user + assistant text
  });

  it('returns [] when there are no workspace repos (scope is empty)', async () => {
    await writeTranscript(path.join(wsRoot, 'repo'), 'sess');
    expect(await new ClaudeProjectsChatIndex(configDir).discoverChats([])).toEqual([]);
  });

  it('preview rows skip injected task-notification user messages (public issue #11)', async () => {
    const repoCwd = path.join(wsRoot, 'bg-task-app');
    const note = [
      '<task-notification>',
      '<task-id>bvt6pifet</task-id>',
      '<status>completed</status>',
      '<summary>Background command "Start dev server" finished</summary>',
      '</task-notification>',
    ].join('\n');
    const content = [
      jline({
        type: 'user',
        message: { role: 'user', content: 'start the dev server' },
        uuid: 'u1',
        timestamp: '2026-06-25T10:00:00.000Z',
        cwd: repoCwd,
        sessionId: 'sess-note',
      }),
      jline({
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Server started.' }],
        },
        uuid: 'a1',
        timestamp: '2026-06-25T10:00:01.000Z',
        sessionId: 'sess-note',
      }),
      // the SDK injects the status blob as a LAST user message when the task ends —
      // it must never become the chat card's preview
      jline({
        type: 'user',
        message: { role: 'user', content: note },
        uuid: 'u2',
        timestamp: '2026-06-25T10:05:00.000Z',
        cwd: repoCwd,
        sessionId: 'sess-note',
      }),
    ].join('\n');
    await writeTranscript(repoCwd, 'sess-note', content);

    const index = new ClaudeProjectsChatIndex(configDir);
    const chats = await index.discoverChats([{ full_name: 'me/bg-task-app', localPath: repoCwd }]);
    expect(chats).toHaveLength(1);
    const chat = chats[0];
    expect(chat.messageCount).toBe(3); // the row still counts — it just never previews
    expect((chat.firstMessageData as any).content).toBe('start the dev server');
    expect((chat.lastMessageData as any).content).toBe('Server started.');
    expect(chat.title).toBe('start the dev server');
  });

  it('matches a JUNCTION/symlink repo: transcript cwd is the realpath target, repo is listed at the link path', async () => {
    // The repo's real on-disk location (where the SDK records `cwd`)…
    const realRepo = path.join(root, 'real', 'unreal-mcp');
    await fs.mkdir(realRepo, { recursive: true });
    // …surfaced in the workspace via a symlink/junction (what getLocalRepositories lists).
    const linkRepo = path.join(wsRoot, 'owner', 'unreal-mcp');
    await fs.mkdir(path.dirname(linkRepo), { recursive: true });
    try {
      await fs.symlink(realRepo, linkRepo, 'junction');
    } catch {
      await fs.symlink(realRepo, linkRepo); // POSIX (no 'junction' type)
    }

    // Terminal `claude` ran at the resolved target → transcript cwd is the REAL path.
    await writeTranscript(realRepo, 'sess-junction');

    const index = new ClaudeProjectsChatIndex(configDir);
    const repos = [{ full_name: 'owner/unreal-mcp', localPath: linkRepo }]; // listed at the link
    const chats = await index.discoverChats(repos);

    expect(chats.map((c) => c.sessionId)).toEqual(['sess-junction']);
    const chat = chats[0];
    expect(chat.repoFullName).toBe('owner/unreal-mcp');
    expect(chat.repoPath).toBe(linkRepo); // display stays the listed (link) path
    expect(chat.cwd).toBe(realRepo); // locate key stays the real recorded cwd
  });
});

describe('ClaudeProjectsMessageStore', () => {
  it('isOverlayMessage flags synthesized media/action blocks only', () => {
    expect(isOverlayMessage('claude_code_block', { type: 'image' })).toBe(true);
    expect(isOverlayMessage('claude_code_block', { type: 'video' })).toBe(true);
    expect(isOverlayMessage('claude_code_block', { type: 'actions' })).toBe(true);
    expect(isOverlayMessage('claude_code_block', { type: 'text' })).toBe(false);
    expect(isOverlayMessage('claude_code_block', { type: 'tool_use' })).toBe(false);
    expect(isOverlayMessage('user_message', { content: 'hi' })).toBe(false);
  });

  it('mergeStreams interleaves by timestamp and re-ids into one monotonic space', () => {
    const jsonl = [
      { id: 1, type: 'user_message', data: {}, timestamp: 100 },
      { id: 2, type: 'claude_code_block', data: { type: 'text' }, timestamp: 200 },
    ];
    const overlay = [{ id: 1, type: 'claude_code_block', data: { type: 'image' }, timestamp: 150 }];
    const merged = mergeStreams(jsonl, overlay);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(merged.map((m) => (m.data as any).type ?? m.type)).toEqual([
      'user_message',
      'image',
      'text',
    ]);
  });

  it('reads the JSONL transcript and merges overlay rows; appendMessage stores only overlays', async () => {
    const cwd = path.join(wsRoot, 'repo');
    const session = 'sess-msg';
    await writeTranscript(cwd, session);

    const overlay = new OverlayMessageStore(path.join(root, 'data'));
    const store = new ClaudeProjectsMessageStore(configDir, overlay, async (chatId) =>
      chatId === 'chat1' ? { repoPath: cwd, sessionId: session } : null
    );
    await store.initialize();

    // A plain SDK-authored row is DROPPED (read from JSONL instead) — returns id 0.
    expect(await store.appendMessage('chat1', 'user_message', { content: 'dup' }, 1000)).toBe(0);
    // A synthesized media overlay is PERSISTED to the side stream.
    const oid = await store.appendMessage(
      'chat1',
      'claude_code_block',
      { type: 'image', blockId: 'img1', source: { url: '/data/media/u/x.webp' } },
      Date.parse('2026-06-25T10:00:02.000Z')
    );
    expect(oid).toBeGreaterThan(0);

    const rows = await store.readMessages('chat1');
    // JSONL: user_message + assistant text (2) + overlay image (1) = 3, re-ided 1..3
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(rows[0].type).toBe('user_message');
    expect((rows[2].data as any).type).toBe('image'); // overlay merged at the tail by timestamp
    expect(await store.getMessageCount('chat1')).toBe(3);

    // No transcript yet (session unresolved) → only overlay rows.
    expect(await store.readMessages('unknown')).toEqual([]);
    store.close();
  });
});
