/**
 * SidecarChannelService + ExternalClaudeSessionService.confirmSidecarPid —
 * rev12 D58 (the api half of the mcp-sidecar channel).
 *
 * Register correlates a sidecar's parent pid to the presence registry
 * (pid-exact first, unique-cwd fallback, ambiguous ⇒ none); poll long-polls
 * and `send` (Stop-on-PC delivery) resolves a parked waiter immediately or
 * queues for the next poll; lastSeen drives channel liveness.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ExternalClaudeSessionService } from '../../../src/services/ExternalClaudeSessionService.js';
import { SidecarChannelService } from '../../../src/services/SidecarChannelService.js';

let dir: string;
let sessions: ExternalClaudeSessionService;
let channel: SidecarChannelService;

const hook = (sessionId: string, cwd: string, portable?: Record<string, unknown>) => ({
  hook_event_name: 'SessionStart',
  session_id: sessionId,
  transcript_path: `/t/${sessionId}.jsonl`,
  cwd,
  portable,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-sidecar-'));
  sessions = new ExternalClaudeSessionService(dir, { isAlive: () => true });
  sessions.initialize();
  channel = new SidecarChannelService(sessions);
});

afterEach(() => {
  sessions.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('register → pid correlation', () => {
  test('an exact live-pid match confirms the pid in place', () => {
    sessions.ingestHookEvent(hook('s1', '/repo', { ppid: 500 })); // unconfirmed pid 500
    expect(sessions.getSession('s1')?.pidConfirmed).toBe(false);

    const matched = channel.register(500, '/repo');
    expect(matched).toBe('s1');
    expect(sessions.getSession('s1')?.pidConfirmed).toBe(true);
  });

  test('a UNIQUE live session in the same cwd adopts the sidecar pid', () => {
    sessions.ingestHookEvent(hook('s1', '/repo')); // no pid at all
    const matched = channel.register(9000, '/repo');
    expect(matched).toBe('s1');
    const s = sessions.getSession('s1');
    expect(s?.pid).toBe(9000);
    expect(s?.pidConfirmed).toBe(true);
  });

  test('two live sessions in one cwd ⇒ ambiguous ⇒ no correlation', () => {
    sessions.ingestHookEvent(hook('s1', '/repo'));
    sessions.ingestHookEvent(hook('s2', '/repo'));
    expect(channel.register(9000, '/repo')).toBeNull();
    expect(sessions.getSession('s1')?.pid).toBe(0);
    expect(sessions.getSession('s2')?.pid).toBe(0);
  });
});

describe('poll / send (the Stop-on-PC delivery path)', () => {
  test('send resolves a PARKED poll immediately', async () => {
    channel.register(500, '/repo');
    const pending = channel.poll(500, 5_000);
    expect(channel.send(500, { command: 'stop', mode: 'interrupt' })).toBe(true);
    expect(await pending).toEqual({ command: 'stop', mode: 'interrupt' });
  });

  test('send queues when no poll is parked; the next poll drains it', async () => {
    channel.register(500, '/repo');
    expect(channel.send(500, { command: 'stop', mode: 'end' })).toBe(true);
    expect(await channel.poll(500, 0)).toEqual({ command: 'stop', mode: 'end' });
  });

  test('poll times out empty (null) when nothing is sent', async () => {
    channel.register(500, '/repo');
    expect(await channel.poll(500, 10)).toBeNull();
  });

  test('send to a pid that never registered reports undeliverable', () => {
    expect(channel.send(12345, { command: 'stop', mode: 'interrupt' })).toBe(false);
  });

  test('lastSeen tracks polls → isChannelLive', async () => {
    expect(channel.isChannelLive(500)).toBe(false);
    channel.register(500, '/repo', 1_000_000);
    expect(channel.isChannelLive(500, 60_000, 1_000_500)).toBe(true);
    expect(channel.isChannelLive(500, 60_000, 1_100_000)).toBe(false);
    await channel.poll(500, 0, 1_100_000);
    expect(channel.isChannelLive(500, 60_000, 1_100_001)).toBe(true);
  });
});
