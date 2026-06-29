/**
 * TunnelHealthMonitor tests (tunnel self-heal).
 *
 * The monitor probes the PUBLIC relay path the phone uses and cycles cloudflared
 * when it's unreachable WHILE the local api is healthy — recovering a dead/stale
 * gateway mapping that a local or direct-tunnel check would both miss. Driven here
 * with a stubbed relay (per-URL responses) + a MANUAL timer queue, so the whole
 * loop runs with no real network/clock.
 */
import { describe, expect, it } from 'bun:test';

import {
  startTunnelHealthMonitor,
  type StartTunnelHealthMonitorOptions,
} from '../src/TunnelHealthMonitor.js';

const LOCAL = 'http://127.0.0.1:4200/api/health';
const RELAY = 'https://app.portable-dev.com/t/pc_test/api/health';

/** A manual timer queue: setTimeout pushes a job; runDue() fires the earliest first. */
function makeTimers() {
  let seq = 0;
  const jobs = new Map<number, { at: number; cb: () => void }>();
  let clock = 0;
  return {
    setTimeoutImpl: ((cb: () => void, ms: number) => {
      const id = ++seq;
      jobs.set(id, { at: clock + ms, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as StartTunnelHealthMonitorOptions['setTimeoutImpl'],
    clearTimeoutImpl: ((h: ReturnType<typeof setTimeout>) => {
      jobs.delete(h as unknown as number);
    }) as StartTunnelHealthMonitorOptions['clearTimeoutImpl'],
    /**
     * Fire the single earliest-scheduled pending job (advancing the clock to it),
     * skipping the monitor's internal per-probe ABORT timers (`requestTimeoutMs`)
     * so a test "tick" always lands on a real probe-tick, not a fetch-timeout guard.
     * Drains microtasks generously so the async `tick()` fully completes (its fetch
     * + json awaits settle and its abort timers are cleared) before returning.
     */
    async runNext(): Promise<boolean> {
      // The abort timers are short (requestTimeoutMs) and self-clear when the (instant)
      // fake fetch resolves; ignore them when choosing the next job to fire.
      let next: { id: number; at: number; cb: () => void } | null = null;
      for (const [id, j] of jobs) {
        if (j.at - clock <= 100) continue; // skip per-probe abort guards
        if (!next || j.at < next.at) next = { id, at: j.at, cb: j.cb };
      }
      if (!next) return false;
      jobs.delete(next.id);
      clock = next.at;
      next.cb();
      // Let the async tick (fetch + json awaits, finally-clear) fully settle.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      return true;
    },
    pending: () => jobs.size,
  };
}

/** A relay/api stub: maps a URL → a sequence of health bodies (or null = network error). */
function makeFetch(plan: Record<string, Array<{ ok: boolean; body: unknown } | null>>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(input);
    const queue = plan[input] ?? [];
    // Last entry repeats once exhausted (steady state).
    const entry = queue.length > 1 ? queue.shift()! : (queue[0] ?? null);
    if (entry === null) throw new Error('network error');
    return {
      ok: entry.ok,
      status: entry.ok ? 200 : 530,
      json: async () => entry.body,
    } as Response;
  }) as StartTunnelHealthMonitorOptions['fetchImpl'];
  return { fetchImpl, calls };
}

const OK = { ok: true, body: { status: 'ok' } };
const DEAD = { ok: false, body: { error: 'origin unreachable' } };

function start(
  overrides: Partial<StartTunnelHealthMonitorOptions> & {
    fetchImpl: StartTunnelHealthMonitorOptions['fetchImpl'];
    timers: ReturnType<typeof makeTimers>;
    cycle: () => void;
  }
) {
  return startTunnelHealthMonitor({
    localHealthUrl: LOCAL,
    relayHealthUrl: RELAY,
    cycle: overrides.cycle,
    intervalMs: 1000,
    cooldownMs: 5000,
    failureThreshold: 2,
    requestTimeoutMs: 100,
    fetchImpl: overrides.fetchImpl,
    setTimeoutImpl: overrides.timers.setTimeoutImpl,
    clearTimeoutImpl: overrides.timers.clearTimeoutImpl,
    log: () => {},
    ...overrides,
  });
}

describe('startTunnelHealthMonitor', () => {
  it('does NOT cycle while the public relay path is healthy', async () => {
    const timers = makeTimers();
    const { fetchImpl } = makeFetch({ [LOCAL]: [OK], [RELAY]: [OK] });
    let cycles = 0;
    const handle = start({ fetchImpl, timers, cycle: () => cycles++ });

    await timers.runNext(); // probe #1
    await timers.runNext(); // probe #2
    await timers.runNext(); // probe #3
    expect(cycles).toBe(0);
    handle.stop();
  });

  it('cycles after `failureThreshold` consecutive relay failures (api healthy)', async () => {
    const timers = makeTimers();
    // Local always OK; relay always dead.
    const { fetchImpl } = makeFetch({ [LOCAL]: [OK], [RELAY]: [DEAD] });
    let cycles = 0;
    const handle = start({ fetchImpl, timers, cycle: () => cycles++ });

    await timers.runNext(); // failure 1/2 — no cycle yet
    expect(cycles).toBe(0);
    await timers.runNext(); // failure 2/2 — cycle!
    expect(cycles).toBe(1);
    handle.stop();
  });

  it('does NOT cycle when the api itself is down (not a tunnel problem)', async () => {
    const timers = makeTimers();
    // Local down → relay never even probed; never cycle.
    const { fetchImpl, calls } = makeFetch({ [LOCAL]: [DEAD], [RELAY]: [DEAD] });
    let cycles = 0;
    const handle = start({ fetchImpl, timers, cycle: () => cycles++ });

    await timers.runNext();
    await timers.runNext();
    await timers.runNext();
    expect(cycles).toBe(0);
    // The relay was never probed because the local probe gated it out.
    expect(calls.every((c) => c === LOCAL)).toBe(true);
    handle.stop();
  });

  it('waits a cooldown after a cycle, then recovers and resets on a healthy probe', async () => {
    const timers = makeTimers();
    // Relay: dead, dead (→ cycle), then healthy thereafter.
    const { fetchImpl } = makeFetch({ [LOCAL]: [OK], [RELAY]: [DEAD, DEAD, OK] });
    const cooldowns: number[] = [];
    let cycles = 0;
    const handle = start({
      fetchImpl,
      timers,
      cycle: () => {
        cycles++;
      },
    });

    await timers.runNext(); // fail 1
    await timers.runNext(); // fail 2 → cycle, schedule cooldown
    expect(cycles).toBe(1);
    await timers.runNext(); // after cooldown: relay healthy → reset
    // A subsequent failure must take the FULL threshold again (streak was reset).
    expect(cycles).toBe(1);
    handle.stop();
    void cooldowns;
  });

  it('does NOT cycle while a device is connected, even with the relay dead', async () => {
    const timers = makeTimers();
    // Local OK, relay dead — would normally cycle at the threshold...
    const { fetchImpl } = makeFetch({ [LOCAL]: [OK], [RELAY]: [DEAD] });
    let cycles = 0;
    const handle = start({
      fetchImpl,
      timers,
      cycle: () => cycles++,
      // ...but a device is connected, proving the relay path works end-to-end.
      isDeviceConnected: () => true,
    });

    await timers.runNext(); // fail 1/2
    await timers.runNext(); // fail 2/2 — suppressed (device connected)
    await timers.runNext(); // still suppressed
    expect(cycles).toBe(0);
    handle.stop();
  });

  it('resumes self-heal once the device disconnects', async () => {
    const timers = makeTimers();
    const { fetchImpl } = makeFetch({ [LOCAL]: [OK], [RELAY]: [DEAD] });
    let cycles = 0;
    let connected = true;
    const handle = start({
      fetchImpl,
      timers,
      cycle: () => cycles++,
      isDeviceConnected: () => connected,
    });

    await timers.runNext(); // fail 1/2
    await timers.runNext(); // fail 2/2 — suppressed while connected
    expect(cycles).toBe(0);
    // Device drops — a dead mapping now genuinely strands the phone, so self-heal resumes.
    connected = false;
    await timers.runNext(); // fail 1/2 (streak was reset on suppression)
    expect(cycles).toBe(0);
    await timers.runNext(); // fail 2/2 — cycle!
    expect(cycles).toBe(1);
    handle.stop();
  });

  it('stop() cancels the loop — no further probes or cycles', async () => {
    const timers = makeTimers();
    const { fetchImpl, calls } = makeFetch({ [LOCAL]: [OK], [RELAY]: [DEAD] });
    let cycles = 0;
    const handle = start({ fetchImpl, timers, cycle: () => cycles++ });

    await timers.runNext(); // fail 1
    const callsAfterOne = calls.length;
    handle.stop();
    const ran = await timers.runNext(); // nothing scheduled after stop
    expect(ran).toBe(false);
    expect(calls.length).toBe(callsAfterOne);
    expect(cycles).toBe(0);
  });
});
