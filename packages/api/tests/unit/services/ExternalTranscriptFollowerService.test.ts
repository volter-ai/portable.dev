/**
 * ExternalTranscriptFollowerService (rev12 D62 mid-turn live-follow).
 *
 * Pure-unit: every dependency (registry read, transcript read, room
 * membership, socket broadcast, fs stat/watch) is injected. `checkNow` is
 * driven directly (it is what the watch callback + interval poll invoke), so
 * no timers are needed.
 */
import { describe, expect, test } from 'bun:test';

import {
  CHAT_EXTERNAL_MESSAGES_EVENT,
  ExternalTranscriptFollowerService,
  type TranscriptFollowerDeps,
} from '../../../src/services/ExternalTranscriptFollowerService.js';

import type { BufferedMessage } from '@vgit2/shared/types';

const SESSION = 'sess-abc';

const row = (id: number, content = `block-${id}`): BufferedMessage => ({
  id,
  type: 'claude_code_block',
  data: { type: 'text', content, blockId: `b${id}` },
  timestamp: 1000 + id,
});

interface Harness {
  follower: ExternalTranscriptFollowerService;
  emitted: Array<{
    room: string;
    event: string;
    payload: { chatId: string; messages: BufferedMessage[] };
  }>;
  setRows: (rows: BufferedMessage[]) => void;
  setSize: (size: number | null) => void;
  setMembers: (has: boolean) => void;
  setState: (state: string | null) => void;
  readCount: () => number;
}

function makeHarness(overrides: Partial<TranscriptFollowerDeps> = {}): Harness {
  let rows: BufferedMessage[] = [];
  let size: number | null = 0;
  let members = true;
  let state: string | null = 'live-running';
  let reads = 0;
  const emitted: Harness['emitted'] = [];

  const deps: TranscriptFollowerDeps = {
    getSession: () =>
      state === null ? null : { state, transcriptPath: '/tmp/fake/session.jsonl' },
    getMessages: async () => {
      reads++;
      return rows;
    },
    broadcastToRoom: (room, event, payload) =>
      emitted.push({ room, event, payload: payload as Harness['emitted'][number]['payload'] }),
    roomHasMembers: () => members,
    statSize: () => size,
    watchFile: () => () => {},
    pollIntervalMs: 3_600_000, // keep the backstop interval quiet in tests
    ...overrides,
  };

  return {
    follower: new ExternalTranscriptFollowerService(deps),
    emitted,
    setRows: (r) => {
      rows = r;
    },
    setSize: (s) => {
      size = s;
    },
    setMembers: (has) => {
      members = has;
    },
    setState: (s) => {
      state = s;
    },
    readCount: () => reads,
  };
}

const promptSubmit = { hook_event_name: 'UserPromptSubmit', session_id: SESSION };
const stop = { hook_event_name: 'Stop', session_id: SESSION };

describe('ExternalTranscriptFollowerService', () => {
  test('UserPromptSubmit starts following; the baseline is never emitted', async () => {
    const h = makeHarness();
    h.setRows([row(1), row(2)]);
    h.setSize(100);

    await h.follower.onHookEvent(promptSubmit);

    expect(h.follower.followedCount()).toBe(1);
    expect(h.emitted).toHaveLength(0);
    h.follower.unfollowAll();
  });

  test('a grown transcript pushes ONLY the new rows to the chat room', async () => {
    const h = makeHarness();
    h.setRows([row(1), row(2)]);
    h.setSize(100);
    await h.follower.onHookEvent(promptSubmit);

    h.setRows([row(1), row(2), row(3), row(4)]);
    h.setSize(220);
    await h.follower.checkNow(SESSION);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].room).toBe(SESSION);
    expect(h.emitted[0].event).toBe(CHAT_EXTERNAL_MESSAGES_EVENT);
    expect(h.emitted[0].payload.chatId).toBe(SESSION);
    expect(h.emitted[0].payload.messages.map((m) => m.id)).toEqual([3, 4]);
    h.follower.unfollowAll();
  });

  test('the cursor advances — a second check emits only rows newer than the last push', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    h.setRows([row(1), row(2)]);
    h.setSize(100);
    await h.follower.checkNow(SESSION);
    h.setRows([row(1), row(2), row(3)]);
    h.setSize(150);
    await h.follower.checkNow(SESSION);

    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[0].payload.messages.map((m) => m.id)).toEqual([2]);
    expect(h.emitted[1].payload.messages.map((m) => m.id)).toEqual([3]);
    h.follower.unfollowAll();
  });

  test('an unchanged size never re-reads the transcript', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);
    const baselineReads = h.readCount();

    await h.follower.checkNow(SESSION);
    await h.follower.checkNow(SESSION);

    expect(h.readCount()).toBe(baselineReads);
    expect(h.emitted).toHaveLength(0);
    h.follower.unfollowAll();
  });

  test('a missing/torn file (stat null) is a safe no-op', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    h.setSize(null);
    await h.follower.checkNow(SESSION);

    expect(h.emitted).toHaveLength(0);
    expect(h.follower.followedCount()).toBe(1);
    h.follower.unfollowAll();
  });

  test('does not start when the room has no members', async () => {
    const h = makeHarness();
    h.setMembers(false);
    await h.follower.onHookEvent(promptSubmit);
    expect(h.follower.followedCount()).toBe(0);
  });

  test('does not start when the session is not live-running (idle / ended / unknown)', async () => {
    for (const state of ['live-idle', 'ended', null]) {
      const h = makeHarness();
      h.setState(state);
      await h.follower.onHookEvent(promptSubmit);
      expect(h.follower.followedCount()).toBe(0);
    }
  });

  test('chat:join starts a follow for a live-running session (opening the chat mid-turn)', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onChatJoined(SESSION);
    expect(h.follower.followedCount()).toBe(1);
    h.follower.unfollowAll();
  });

  test('a racing hook + join start exactly one follow (single baseline read)', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await Promise.all([h.follower.onHookEvent(promptSubmit), h.follower.onChatJoined(SESSION)]);
    expect(h.follower.followedCount()).toBe(1);
    expect(h.readCount()).toBe(1);
    h.follower.unfollowAll();
  });

  test('the Stop hook unfollows; later transcript growth pushes nothing', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    await h.follower.onHookEvent(stop);
    expect(h.follower.followedCount()).toBe(0);

    h.setRows([row(1), row(2)]);
    h.setSize(100);
    await h.follower.checkNow(SESSION);
    expect(h.emitted).toHaveLength(0);
  });

  test('losing the room members mid-follow unfollows (re-startable via the next join)', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    h.setMembers(false);
    await h.follower.checkNow(SESSION);
    expect(h.follower.followedCount()).toBe(0);
  });

  test('a session that reads back as ended unfollows', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    h.setState('ended');
    await h.follower.checkNow(SESSION);
    expect(h.follower.followedCount()).toBe(0);
  });

  test('a decayed live-idle session KEEPS the follow (RUNNING_DECAY is not "turn over")', async () => {
    const h = makeHarness();
    h.setRows([row(1)]);
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);

    h.setState('live-idle');
    h.setRows([row(1), row(2)]);
    h.setSize(100);
    await h.follower.checkNow(SESSION);

    expect(h.follower.followedCount()).toBe(1);
    expect(h.emitted).toHaveLength(1);
    h.follower.unfollowAll();
  });

  test('a failed baseline read aborts the follow', async () => {
    const h = makeHarness({
      getMessages: async () => {
        throw new Error('unresolvable chat');
      },
    });
    h.setSize(50);
    await h.follower.onHookEvent(promptSubmit);
    expect(h.follower.followedCount()).toBe(0);
  });

  test('user_message rows ride the same push (the terminal prompt is visible too)', async () => {
    const h = makeHarness();
    h.setRows([]);
    h.setSize(10);
    await h.follower.onHookEvent(promptSubmit);

    const userRow: BufferedMessage = {
      id: 1,
      type: 'user_message',
      data: { content: 'do the thing' },
      timestamp: 2000,
    };
    h.setRows([userRow, row(2)]);
    h.setSize(90);
    await h.follower.checkNow(SESSION);

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.messages.map((m) => m.type)).toEqual([
      'user_message',
      'claude_code_block',
    ]);
    h.follower.unfollowAll();
  });
});
