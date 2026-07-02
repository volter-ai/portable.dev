/**
 * HookRelay + InternalBridge — rev12 D53.
 *
 * The relay runs inside the user's own `claude` sessions, so the contract is
 * silence and speed: relay the payload (augmented with process ancestry) to
 * the loopback internal endpoint when Portable is up, and do NOTHING —
 * quietly — when it isn't.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { INTERNAL_SECRET_HEADER, runHookRelay } from '../src/HookRelay.js';
import {
  internalBridgePath,
  mintInternalSecret,
  readInternalBridge,
  writeInternalBridge,
} from '../src/InternalBridge.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-bridge-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('InternalBridge', () => {
  test('round-trips port + secret through the bridge file (0600)', () => {
    const secret = mintInternalSecret();
    writeInternalBridge({ port: 4200, secret, startedAt: '2026-07-02T00:00:00Z' }, dir);

    const read = readInternalBridge(dir);
    expect(read).toEqual({ port: 4200, secret, startedAt: '2026-07-02T00:00:00Z' });

    if (process.platform !== 'win32') {
      const mode = fs.statSync(internalBridgePath(dir)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('returns null for a missing, corrupt, or field-less bridge file', () => {
    expect(readInternalBridge(dir)).toBeNull();
    fs.writeFileSync(internalBridgePath(dir), 'not json');
    expect(readInternalBridge(dir)).toBeNull();
    fs.writeFileSync(internalBridgePath(dir), JSON.stringify({ port: 'x', secret: '' }));
    expect(readInternalBridge(dir)).toBeNull();
  });
});

describe('runHookRelay', () => {
  const bridge = { port: 4321, secret: 's3cret', startedAt: '' };

  test('POSTs the augmented payload to the loopback internal endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const ok = await runHookRelay({
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'abc',
          cwd: '/repo',
        }),
      readBridge: () => bridge,
      readAncestors: () => [{ pid: 111, command: 'claude' }],
      ppid: 222,
      fetchImpl,
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4321/api/internal/claude-hook');
    expect((calls[0].init.headers as Record<string, string>)[INTERNAL_SECRET_HEADER]).toBe(
      's3cret'
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.session_id).toBe('abc');
    expect(body.portable).toEqual({ ppid: 222, ancestors: [{ pid: 111, command: 'claude' }] });
  });

  test('reads the bridge from an explicit --bridge path (B2), not DATA_DIR', async () => {
    // Write a real bridge at a NON-default path; the relay must read exactly it.
    writeInternalBridge({ port: 4321, secret: 's3cret', startedAt: '' }, dir);
    let posted = false;
    const ok = await runHookRelay({
      bridgePath: internalBridgePath(dir),
      readStdin: async () => '{"hook_event_name":"Stop","session_id":"abc"}',
      readAncestors: () => [],
      fetchImpl: (async () => {
        posted = true;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(posted).toBe(true);
  });

  test('is a silent no-op when Portable is off (no bridge file)', async () => {
    let fetched = false;
    const ok = await runHookRelay({
      readStdin: async () => '{"hook_event_name":"Stop","session_id":"abc"}',
      readBridge: () => null,
      fetchImpl: (async () => {
        fetched = true;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(ok).toBe(false);
    expect(fetched).toBe(false);
  });

  test('never throws on unparseable stdin or a dead endpoint', async () => {
    expect(
      await runHookRelay({
        readStdin: async () => 'not json',
        readBridge: () => bridge,
        fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
      })
    ).toBe(false);

    expect(
      await runHookRelay({
        readStdin: async () => '{"hook_event_name":"Stop","session_id":"x"}',
        readBridge: () => bridge,
        readAncestors: () => [],
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
      })
    ).toBe(false);
  });
});
