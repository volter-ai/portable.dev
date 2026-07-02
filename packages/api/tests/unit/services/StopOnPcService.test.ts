/**
 * StopOnPcService — rev12 D59/D60.
 *
 * Delivers a stop to a live terminal `claude` session (sidecar-first, direct
 * kill fallback) and WAITS for evidence before reporting stopped. Never
 * signals an unconfirmed pid; a grace timeout returns stopped:false so the
 * caller falls back to fork.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ExternalClaudeSessionService } from '../../../src/services/ExternalClaudeSessionService.js';
import { SidecarChannelService } from '../../../src/services/SidecarChannelService.js';
import { StopOnPcService } from '../../../src/services/StopOnPcService.js';

let dir: string;

const startWithConfirmedPid = (svc: ExternalClaudeSessionService, sessionId: string, pid: number) =>
  svc.ingestHookEvent({
    hook_event_name: 'UserPromptSubmit', // live-running
    session_id: sessionId,
    cwd: '/repo',
    portable: { ppid: pid, ancestors: [{ pid, command: 'claude' }] }, // confirmed
  });

const build = (opts: {
  alive: Set<number>;
  sidecar?: SidecarChannelService | any;
  killed?: Array<{ pid: number; signal: string }>;
  /** Called on each delivered signal (tests simulate the process dying). */
  onKill?: (pid: number, signal: string) => void;
  /** pid → comm for the N2 pid-reuse guard (default: 'claude'). */
  comm?: (pid: number) => string | null;
}) => {
  const sessions = new ExternalClaudeSessionService(dir, {
    isAlive: (pid) => opts.alive.has(pid),
  });
  sessions.initialize();
  const stop = new StopOnPcService(sessions, opts.sidecar, {
    isAlive: (pid) => opts.alive.has(pid),
    kill: (pid, signal) => {
      opts.killed?.push({ pid, signal });
      opts.onKill?.(pid, signal);
    },
    readComm: opts.comm ?? (() => 'claude'), // no real `ps` in unit tests
    // Real (tiny) macrotask sleep so out-of-band setTimeout(0) effects (a pid
    // dying, a Stop hook arriving) land between polls; `waited` counts pollMs.
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    graceMs: 900,
    pollMs: 100,
  });
  return { sessions, stop };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-stoppc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('StopOnPcService.stop', () => {
  test('end (SIGTERM): direct kill when no sidecar, confirmed once the pid dies', async () => {
    const alive = new Set([500]);
    const killed: Array<{ pid: number; signal: string }> = [];
    // The kill makes the pid die → the next liveness poll confirms.
    const { sessions, stop } = build({ alive, killed, onKill: (pid) => alive.delete(pid) });
    startWithConfirmedPid(sessions, 's1', 500);

    const res = await stop.stop('s1', 'end');
    expect(res.stopped).toBe(true);
    expect(res.reason).toBe('stopped');
    expect(res.via).toBe('direct-kill');
    expect(killed).toEqual([{ pid: 500, signal: 'SIGTERM' }]);
    expect(sessions.isLive('s1')).toBe(false);
    sessions.close();
  });

  test('prefers the sidecar channel when one is live (no direct kill)', async () => {
    const alive = new Set([500]);
    const sidecar = new SidecarChannelService();
    sidecar.register(500, '/repo'); // just registered → isChannelLive true
    const delivered: unknown[] = [];
    const pending = sidecar.poll(500, 5_000).then((c) => delivered.push(c));

    const killed: Array<{ pid: number; signal: string }> = [];
    const { sessions, stop } = build({ alive, sidecar, killed });
    startWithConfirmedPid(sessions, 's1', 500);
    // The sidecar "kills" out-of-band → simulate by dropping liveness shortly.
    setTimeout(() => alive.delete(500), 0);

    const res = await stop.stop('s1', 'end');
    await pending;
    expect(res.via).toBe('sidecar');
    expect(killed).toHaveLength(0); // never fell back to a direct kill
    expect(delivered).toEqual([{ command: 'stop', mode: 'end' }]);
    sessions.close();
  });

  test('N1: a DEAD/non-live sidecar channel falls through to direct kill (not a silent no-op)', async () => {
    const alive = new Set([500]);
    const killed: Array<{ pid: number; signal: string }> = [];
    let sent = false;
    // A channel that exists but is NOT live (crashed sidecar): send would queue
    // into a dead channel and return true — the gate must skip it.
    const deadChannel = {
      isChannelLive: () => false,
      send: () => {
        sent = true;
        return true;
      },
    };
    const { sessions, stop } = build({
      alive,
      sidecar: deadChannel,
      killed,
      onKill: (pid) => alive.delete(pid),
    });
    startWithConfirmedPid(sessions, 's1', 500);

    const res = await stop.stop('s1', 'end');
    expect(sent).toBe(false); // never delivered to the dead channel
    expect(res.via).toBe('direct-kill');
    expect(killed).toEqual([{ pid: 500, signal: 'SIGTERM' }]);
    sessions.close();
  });

  test('N2: direct-kill re-verifies the pid is a claude process (pid-reuse) — recycled pid is NOT killed', async () => {
    const alive = new Set([500]); // pid alive but recycled to another process
    const killed: Array<{ pid: number; signal: string }> = [];
    const { sessions, stop } = build({
      alive,
      killed,
      comm: () => 'vim', // the pid is now the user's editor, not claude
    });
    startWithConfirmedPid(sessions, 's1', 500);

    const res = await stop.stop('s1', 'end');
    expect(killed).toHaveLength(0); // the editor is NOT signalled
    expect(res.stopped).toBe(true);
    expect(res.reason).toBe('already-ended');
    expect(sessions.isLive('s1')).toBe(false);
    sessions.close();
  });

  test('refuses to signal an UNCONFIRMED pid', async () => {
    const { sessions, stop } = build({ alive: new Set([500]) });
    sessions.ingestHookEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/repo',
      portable: { ppid: 500 }, // bare ppid — unconfirmed
    });
    const res = await stop.stop('s1', 'end');
    expect(res.stopped).toBe(false);
    expect(res.reason).toBe('no-confirmed-pid');
    sessions.close();
  });

  test('an already-ended session is a no-op success', async () => {
    const { sessions, stop } = build({ alive: new Set() });
    startWithConfirmedPid(sessions, 's1', 500);
    sessions.markEnded('s1');
    const res = await stop.stop('s1', 'end');
    expect(res).toEqual({ stopped: true, reason: 'already-ended' });
    sessions.close();
  });

  test('unknown session reports unknown-session', async () => {
    const { sessions, stop } = build({ alive: new Set() });
    const res = await stop.stop('nope', 'end');
    expect(res.reason).toBe('unknown-session');
    sessions.close();
  });

  test('grace timeout (pid stays alive) ⇒ stopped:false so the caller forks', async () => {
    const alive = new Set([500]); // the pid never dies
    const killed: Array<{ pid: number; signal: string }> = [];
    const { sessions, stop } = build({ alive, killed });
    startWithConfirmedPid(sessions, 's1', 500);
    const res = await stop.stop('s1', 'end');
    expect(res.stopped).toBe(false);
    expect(res.reason).toBe('not-confirmed');
    expect(killed).toEqual([{ pid: 500, signal: 'SIGTERM' }]);
    sessions.close();
  });

  test('interrupt (SIGINT): confirmed when the turn leaves the running state', async () => {
    const alive = new Set([500]);
    const { sessions, stop } = build({ alive });
    startWithConfirmedPid(sessions, 's1', 500); // live-running
    // The Stop hook (turn finished) arrives out-of-band → flip to live-idle.
    setTimeout(
      () =>
        sessions.ingestHookEvent({
          hook_event_name: 'Stop',
          session_id: 's1',
          cwd: '/repo',
          portable: { ppid: 500, ancestors: [{ pid: 500, command: 'claude' }] },
        }),
      0
    );
    const res = await stop.stop('s1', 'interrupt');
    expect(res.stopped).toBe(true);
    sessions.close();
  });
});
