/**
 * McpSidecar — rev12 D58.
 *
 * The sidecar is spawned by every terminal `claude` session, so the contract
 * is protocol correctness (a zero-tool MCP server the CLI can always connect
 * to) + fail-silent channel behavior (Portable off = quiet idle) + correct
 * stop delivery (SIGINT interrupt / SIGTERM end to the PARENT pid).
 */
import { describe, expect, test } from 'bun:test';

import { handleMcpMessage, runChannelCycle } from '../src/McpSidecar.js';

describe('handleMcpMessage (MCP stdio protocol)', () => {
  test('initialize echoes the client protocol version and advertises zero tools', () => {
    const res = handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }) as any;
    expect(res.id).toBe(1);
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.serverInfo.name).toBe('portable-sidecar');
  });

  test('tools/list is empty; ping answers; unknown methods get -32601', () => {
    expect((handleMcpMessage({ id: 2, method: 'tools/list' }) as any).result).toEqual({
      tools: [],
    });
    expect((handleMcpMessage({ id: 3, method: 'ping' }) as any).result).toEqual({});
    expect((handleMcpMessage({ id: 4, method: 'resources/list' }) as any).error.code).toBe(-32601);
  });

  test('notifications (no id) get no reply', () => {
    expect(handleMcpMessage({ method: 'notifications/initialized' })).toBeNull();
  });
});

describe('runChannelCycle', () => {
  const bridge = { port: 4200, secret: 'sec', startedAt: '' };

  test('registers {ppid, cwd} then long-polls; 204 ⇒ idle', async () => {
    const calls: string[] = [];
    const outcome = await runChannelCycle({
      ppid: 777,
      cwd: '/repo',
      readBridge: () => bridge,
      fetchImpl: (async (url: any, init: any) => {
        calls.push(String(url));
        if (String(url).endsWith('/register')) {
          expect(JSON.parse(String(init.body))).toEqual({ ppid: 777, cwd: '/repo' });
          expect(init.headers['x-portable-internal-secret']).toBe('sec');
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      kill: () => {
        throw new Error('must not signal on idle');
      },
      log: () => {},
    });
    expect(outcome).toBe('idle');
    expect(calls[0]).toContain('/api/internal/sidecar/register');
    expect(calls[1]).toContain('/api/internal/sidecar/poll?pid=777');
  });

  test('a stop command signals the PARENT: interrupt ⇒ SIGINT, end ⇒ SIGTERM', async () => {
    const signals: Array<{ pid: number; signal: string }> = [];
    const make = (mode: string) =>
      runChannelCycle({
        ppid: 777,
        cwd: '/repo',
        readBridge: () => bridge,
        fetchImpl: (async (url: any) =>
          String(url).endsWith('/register')
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response(JSON.stringify({ command: 'stop', mode }), {
                status: 200,
              })) as typeof fetch,
        kill: (pid, signal) => signals.push({ pid, signal }),
        log: () => {},
      });

    expect(await make('interrupt')).toBe('stopped');
    expect(await make('end')).toBe('stopped');
    expect(signals).toEqual([
      { pid: 777, signal: 'SIGINT' },
      { pid: 777, signal: 'SIGTERM' },
    ]);
  });

  test('N5: a pre-aborted shutdown signal cancels the in-flight request (event loop can drain)', async () => {
    const shutdown = new AbortController();
    shutdown.abort(); // parent CLI already closed stdin
    let sawAbort = false;
    const outcome = await runChannelCycle({
      ppid: 777,
      cwd: '/repo',
      readBridge: () => bridge,
      shutdownSignal: shutdown.signal,
      fetchImpl: (async (_url: any, init: any) => {
        // The combined signal must already be aborted → a real fetch rejects.
        if (init?.signal?.aborted) {
          sawAbort = true;
          throw new Error('aborted');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
      kill: () => {},
      log: () => {},
    });
    expect(sawAbort).toBe(true);
    expect(outcome).toBe('error'); // aborted fetch → caught → error (loop then sees closed)
  });

  test('Portable off (no bridge) ⇒ no-bridge, zero fetches; api errors ⇒ error, no signal', async () => {
    let fetched = 0;
    expect(
      await runChannelCycle({
        ppid: 1,
        cwd: '/x',
        readBridge: () => null,
        fetchImpl: (async () => {
          fetched += 1;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
        kill: () => {},
        log: () => {},
      })
    ).toBe('no-bridge');
    expect(fetched).toBe(0);

    expect(
      await runChannelCycle({
        ppid: 1,
        cwd: '/x',
        readBridge: () => bridge,
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
        kill: () => {
          throw new Error('must not signal on error');
        },
        log: () => {},
      })
    ).toBe('error');
  });
});
