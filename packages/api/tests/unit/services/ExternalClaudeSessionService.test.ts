/**
 * ExternalClaudeSessionService + /api/internal routes — rev12 D53/D54.
 *
 * The presence registry for terminal `claude` sessions: hook events fold into
 * a per-session state machine (SessionStart → live-idle, UserPromptSubmit →
 * live-running, Stop/StopFailure → live-idle, SessionEnd → ended), with
 * defensive read-time rules (confirmed-dead pid ⇒ ended, stale decay/TTL) and
 * a fail-closed secret gate on the ingest route.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';

import { createInternalRoutes } from '../../../src/routes/subroutes/internal.routes.js';
import {
  ExternalClaudeSessionService,
  LIVE_TTL_MS,
  RUNNING_DECAY_MS,
} from '../../../src/services/ExternalClaudeSessionService.js';

import type { Server } from 'http';

let dir: string;
let service: ExternalClaudeSessionService;

/** A hook payload as `portable hook-relay` delivers it. */
function hookEvent(
  name: string,
  sessionId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hook_event_name: name,
    session_id: sessionId,
    transcript_path: `/home/u/.claude/projects/p/${sessionId}.jsonl`,
    cwd: '/repo',
    ...extra,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-extsess-'));
  service = new ExternalClaudeSessionService(dir, { isAlive: () => true });
  service.initialize();
});

afterEach(() => {
  service.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('state machine', () => {
  test('SessionStart → live-idle; UserPromptSubmit → live-running; Stop → live-idle; SessionEnd → ended', () => {
    const t = 1_000_000;
    expect(service.ingestHookEvent(hookEvent('SessionStart', 's1'), t).changed).toBe(true);
    expect(service.getSession('s1', t)?.state).toBe('live-idle');

    expect(service.ingestHookEvent(hookEvent('UserPromptSubmit', 's1'), t + 1).changed).toBe(true);
    expect(service.getSession('s1', t + 1)?.state).toBe('live-running');
    expect(service.isLive('s1', t + 1)).toBe(true);

    expect(service.ingestHookEvent(hookEvent('Stop', 's1'), t + 2).changed).toBe(true);
    expect(service.getSession('s1', t + 2)?.state).toBe('live-idle');

    expect(service.ingestHookEvent(hookEvent('SessionEnd', 's1'), t + 3).changed).toBe(true);
    expect(service.isLive('s1', t + 3)).toBe(false);
    expect(service.getLiveSessions(t + 3)).toHaveLength(0);
  });

  test('a repeated same-state event reports changed:false (no rebroadcast storm)', () => {
    const t = 1_000_000;
    service.ingestHookEvent(hookEvent('SessionStart', 's1'), t);
    expect(service.ingestHookEvent(hookEvent('UserPromptSubmit', 's1'), t + 1).changed).toBe(true);
    expect(service.ingestHookEvent(hookEvent('Stop', 's1'), t + 2).changed).toBe(true);
    // Stop after Stop lands on the same live-idle state — nothing to rebroadcast.
    expect(service.ingestHookEvent(hookEvent('Stop', 's1'), t + 3).changed).toBe(false);
  });

  test('unknown events and payloads without a session_id are ignored', () => {
    expect(
      service.ingestHookEvent({ hook_event_name: 'PreToolUse', session_id: 'x' }).changed
    ).toBe(false);
    expect(service.ingestHookEvent(hookEvent('Stop', '')).changed).toBe(false);
    expect(service.getLiveSessions()).toHaveLength(0);
  });

  test('an unknown session is not live (adopt gate default)', () => {
    expect(service.isLive('never-seen')).toBe(false);
  });
});

describe('pid handling', () => {
  test('a claude-named ancestor is stored as a CONFIRMED pid', () => {
    service.ingestHookEvent(
      hookEvent('SessionStart', 's1', {
        portable: {
          ppid: 999,
          ancestors: [
            { pid: 999, command: 'zsh' },
            { pid: 500, command: 'claude' },
          ],
        },
      })
    );
    const s = service.getSession('s1');
    expect(s?.pid).toBe(500);
    expect(s?.pidConfirmed).toBe(true);
  });

  test('a bare ppid is stored UNCONFIRMED and never demotes the session on death', () => {
    const dead = new ExternalClaudeSessionService(dir + '-2', { isAlive: () => false });
    dead.initialize();
    try {
      dead.ingestHookEvent(hookEvent('SessionStart', 's1', { portable: { ppid: 999 } }));
      const s = dead.getSession('s1');
      expect(s?.pid).toBe(999);
      expect(s?.pidConfirmed).toBe(false);
      // Unconfirmed pid (may be the hook's transient shell): still live.
      expect(dead.isLive('s1')).toBe(true);
    } finally {
      dead.close();
      fs.rmSync(dir + '-2', { recursive: true, force: true });
    }
  });

  test('a CONFIRMED dead pid demotes the session to ended', () => {
    const dead = new ExternalClaudeSessionService(dir + '-3', { isAlive: () => false });
    dead.initialize();
    try {
      dead.ingestHookEvent(
        hookEvent('SessionStart', 's1', {
          portable: { ppid: 999, ancestors: [{ pid: 500, command: 'claude' }] },
        })
      );
      expect(dead.isLive('s1')).toBe(false);
    } finally {
      dead.close();
      fs.rmSync(dir + '-3', { recursive: true, force: true });
    }
  });
});

describe('read-time staleness rules', () => {
  test('live-running decays to live-idle after RUNNING_DECAY_MS (crashed mid-turn guard)', () => {
    const t = 1_000_000;
    service.ingestHookEvent(hookEvent('UserPromptSubmit', 's1'), t);
    expect(service.getSession('s1', t + RUNNING_DECAY_MS - 1)?.state).toBe('live-running');
    expect(service.getSession('s1', t + RUNNING_DECAY_MS + 1)?.state).toBe('live-idle');
  });

  test('any live-* row is ended after LIVE_TTL_MS', () => {
    const t = 1_000_000;
    service.ingestHookEvent(hookEvent('SessionStart', 's1'), t);
    expect(service.isLive('s1', t + LIVE_TTL_MS + 1)).toBe(false);
  });

  test('registry survives a service restart (SQLite persistence)', () => {
    const t = 1_000_000;
    service.ingestHookEvent(hookEvent('UserPromptSubmit', 's1'), t);
    service.close();

    const reopened = new ExternalClaudeSessionService(dir, { isAlive: () => true });
    reopened.initialize();
    try {
      expect(reopened.getSession('s1', t + 1)?.state).toBe('live-running');
    } finally {
      reopened.close();
    }
  });

  test('markEnded is terminal', () => {
    service.ingestHookEvent(hookEvent('SessionStart', 's1'));
    service.markEnded('s1');
    expect(service.isLive('s1')).toBe(false);
  });
});

describe('/api/internal routes (secret gate)', () => {
  let server: Server;
  let base: string;
  let changed: number;

  beforeEach(async () => {
    changed = 0;
    const app = express();
    app.use(express.json());
    app.use(
      '/api/internal',
      createInternalRoutes(service, {
        secret: () => 'top-secret',
        onSessionsChanged: () => {
          changed += 1;
        },
      })
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('rejects a missing or wrong secret with 401', async () => {
    const noHeader = await fetch(`${base}/api/internal/claude-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hookEvent('SessionStart', 's1')),
    });
    expect(noHeader.status).toBe(401);

    const wrong = await fetch(`${base}/api/internal/claude-hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-portable-internal-secret': 'nope',
      },
      body: JSON.stringify(hookEvent('SessionStart', 's1')),
    });
    expect(wrong.status).toBe(401);
    expect(service.getLiveSessions()).toHaveLength(0);
  });

  test('ingests a valid hook event (204) and fires the change callback once', async () => {
    const res = await fetch(`${base}/api/internal/claude-hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-portable-internal-secret': 'top-secret',
      },
      body: JSON.stringify(hookEvent('SessionStart', 's1')),
    });
    expect(res.status).toBe(204);
    expect(changed).toBe(1);
    expect(service.getSession('s1')?.state).toBe('live-idle');

    // Same-state repeat: 204 but NO extra broadcast.
    const repeat = await fetch(`${base}/api/internal/claude-hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-portable-internal-secret': 'top-secret',
      },
      body: JSON.stringify(hookEvent('SessionStart', 's1')),
    });
    expect(repeat.status).toBe(204);
    expect(changed).toBe(1);
  });

  test('GET /external-sessions returns the live registry', async () => {
    service.ingestHookEvent(hookEvent('UserPromptSubmit', 's9'));
    const res = await fetch(`${base}/api/internal/external-sessions`, {
      headers: { 'x-portable-internal-secret': 'top-secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string; state: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe('s9');
    expect(body.sessions[0].state).toBe('live-running');
  });

  test('fails closed (503) when no secret is configured', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/internal', createInternalRoutes(service, { secret: () => undefined }));
    const closed = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const address = closed.address();
      const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      const res = await fetch(`${url}/api/internal/claude-hook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-portable-internal-secret': 'anything',
        },
        body: JSON.stringify(hookEvent('SessionStart', 's1')),
      });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => closed.close(() => resolve()));
    }
  });
});
