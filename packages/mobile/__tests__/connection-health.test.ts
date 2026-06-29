/**
 * ConnectionHealthMonitor — the tiered connection-health state machine (pure unit tests).
 *
 * Drives the full ladder (HEALTHY ↔ PROBING → RECONNECTING ↔ SUSPENDED) with fake seams +
 * a MANUAL timer scheduler — no socket, no network, no clock. Proves: steady heartbeating,
 * a transient mobile blip is absorbed (no reconnect), a real failure escalates through the
 * HTTP fallback and reconnects (wedged vs endpoint-down), notifyConnected breaks the
 * reconnect loop, suspend/resume, and the anti-confusion generation guard (a late ack from
 * an abandoned context never flips the live state).
 */
import {
  ConnectionHealthMonitor,
  type ConnectionHealthSeams,
  type ConnectionHealthState,
  type ReconnectCause,
} from '../src/features/socket/connectionHealth';

/** Manual timer queue: fire the single earliest pending timer, draining microtasks after. */
function makeTimers() {
  let seq = 0;
  let clock = 0;
  const jobs = new Map<number, { at: number; cb: () => void }>();
  return {
    setTimeoutImpl: ((cb: () => void, ms: number) => {
      const id = ++seq;
      jobs.set(id, { at: clock + ms, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as NonNullable<ConnectionHealthSeams['setTimeoutImpl']>,
    clearTimeoutImpl: ((h: ReturnType<typeof setTimeout>) => {
      jobs.delete(h as unknown as number);
    }) as NonNullable<ConnectionHealthSeams['clearTimeoutImpl']>,
    pending: () => jobs.size,
    /** Fire the earliest pending job, then drain microtasks so the async tick settles. */
    async runNext(): Promise<boolean> {
      let next: { id: number; at: number; cb: () => void } | null = null;
      for (const [id, j] of jobs) if (!next || j.at < next.at) next = { id, ...j };
      if (!next) return false;
      jobs.delete(next.id);
      clock = next.at;
      next.cb();
      for (let i = 0; i < 50; i++) await Promise.resolve();
      return true;
    },
  };
}

interface Harness {
  monitor: ConnectionHealthMonitor;
  timers: ReturnType<typeof makeTimers>;
  states: ConnectionHealthState[];
  reconnects: ReconnectCause[];
  setHeartbeat: (fn: () => Promise<boolean>) => void;
  setHttpProbe: (fn: () => Promise<boolean>) => void;
  setSocketConnected: (v: boolean) => void;
}

function makeHarness(overrides: Partial<ConnectionHealthSeams> = {}): Harness {
  const timers = makeTimers();
  const states: ConnectionHealthState[] = [];
  const reconnects: ReconnectCause[] = [];
  let heartbeat: () => Promise<boolean> = async () => true;
  let httpProbe: () => Promise<boolean> = async () => false;
  let socketConnected = true;

  const monitor = new ConnectionHealthMonitor({
    sendHeartbeat: () => heartbeat(),
    isSocketConnected: () => socketConnected,
    httpProbe: () => httpProbe(),
    forceReconnect: (cause) => reconnects.push(cause),
    onStateChange: (s) => states.push(s),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    healthyIntervalMs: 20_000,
    probeIntervalMs: 3_000,
    heartbeatTimeoutMs: 6_000,
    maxMisses: 2,
    httpProbeTimeoutMs: 6_000,
    reconnectBackoffMs: 2_000,
    maxReconnectBackoffMs: 20_000,
    disconnectGraceMs: 8_000,
    ...overrides,
  });

  return {
    monitor,
    timers,
    states,
    reconnects,
    setHeartbeat: (fn) => (heartbeat = fn),
    setHttpProbe: (fn) => (httpProbe = fn),
    setSocketConnected: (v) => (socketConnected = v),
  };
}

describe('ConnectionHealthMonitor', () => {
  it('settles HEALTHY on connect and heartbeats steadily without reconnecting', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => true);
    h.monitor.start();
    h.monitor.notifyConnected(); // immediate confirming heartbeat scheduled at delay 0

    await h.timers.runNext(); // confirming heartbeat → acked → HEALTHY
    expect(h.monitor.state).toBe('healthy');
    await h.timers.runNext(); // next steady heartbeat → still healthy
    await h.timers.runNext();
    expect(h.monitor.state).toBe('healthy');
    expect(h.reconnects).toHaveLength(0);
  });

  it('absorbs a transient blip: one miss → PROBING, then an ack → HEALTHY (no reconnect)', async () => {
    const h = makeHarness();
    let acks = true;
    h.setHeartbeat(async () => acks);
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // HEALTHY

    acks = false; // one heartbeat blips
    await h.timers.runNext(); // miss 1/2 → PROBING (no reconnect)
    expect(h.monitor.state).toBe('probing');
    expect(h.reconnects).toHaveLength(0);

    acks = true; // blip over
    await h.timers.runNext(); // probe acks → back to HEALTHY
    expect(h.monitor.state).toBe('healthy');
    expect(h.reconnects).toHaveLength(0);
  });

  it('escalates a real failure via the HTTP fallback and reconnects — endpoint DOWN', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => false); // every heartbeat misses
    h.setHttpProbe(async () => false); // endpoint unreachable
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // confirming heartbeat MISSES → miss 1/2 → PROBING
    expect(h.monitor.state).toBe('probing');
    await h.timers.runNext(); // miss 2/2 → escalate → httpProbe(false) → RECONNECTING
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toEqual(['endpoint-down']);
  });

  it('escalates a wedged transport (endpoint reachable over HTTP) and reconnects immediately', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => false);
    h.setHttpProbe(async () => true); // /api/health answers → transport is wedged
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // miss 1/2
    await h.timers.runNext(); // miss 2/2 → escalate → httpProbe(true) → RECONNECTING (wedged)
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toEqual(['transport-wedged']);
  });

  it('notifyDisconnected BACKSTOPS a clean drop: no immediate force, then reconnects after the grace', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => true);
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // HEALTHY
    h.monitor.notifyDisconnected();
    // Silent (the socket store's markDisconnected owns the UI) — no immediate force, so
    // socket.io's own auto-reconnect + reconnectAndSync get the grace window first.
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toHaveLength(0);
    expect(h.timers.pending()).toBe(1); // the grace backstop timer
    await h.timers.runNext(); // grace elapses, still down → backstop forces a reconnect
    expect(h.reconnects).toEqual(['socket-disconnect']);
    // The socket comes back → notifyConnected breaks the backstop loop → HEALTHY.
    h.monitor.notifyConnected();
    await h.timers.runNext(); // confirming heartbeat acks
    expect(h.monitor.state).toBe('healthy');
  });

  it('a clean drop while ALREADY reconnecting is ignored (our own forceReconnect disconnect)', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => false);
    h.setHttpProbe(async () => false);
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // miss 1/2 → PROBING
    await h.timers.runNext(); // miss 2/2 → escalate → RECONNECTING + forceReconnect #1
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toHaveLength(1);
    // forceReconnect's disconnect()→ notifyDisconnected must NOT reset the loop.
    h.monitor.notifyDisconnected();
    expect(h.reconnects).toHaveLength(1); // unchanged — no new attempt scheduled out of band
  });

  it('reconnect loop (entered via heartbeat escalation) retries with backoff until a connect lands', async () => {
    const h = makeHarness();
    let acks = false;
    h.setHeartbeat(async () => acks);
    h.setHttpProbe(async () => false); // endpoint down
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // miss 1/2 → PROBING
    await h.timers.runNext(); // miss 2/2 → escalate → RECONNECTING, forceReconnect #1
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toHaveLength(1);
    await h.timers.runNext(); // backoff elapses, no connect landed → forceReconnect #2
    expect(h.reconnects).toHaveLength(2);

    // The socket finally reconnects.
    acks = true;
    h.monitor.notifyConnected(); // breaks the loop → confirming heartbeat (delay 0, earliest)
    await h.timers.runNext(); // heartbeat acks → HEALTHY
    expect(h.monitor.state).toBe('healthy');
    expect(h.reconnects).toHaveLength(2); // the superseded reconnect-loop timer never re-fires
  });

  it('suspend pauses all probing; resume re-evaluates (connected → heartbeat)', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => true);
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext(); // HEALTHY

    h.monitor.suspend();
    expect(h.monitor.state).toBe('suspended');
    expect(h.timers.pending()).toBe(0); // no timers while suspended

    h.setSocketConnected(true);
    h.monitor.resume(); // socket reports connected → confirming heartbeat
    await h.timers.runNext();
    expect(h.monitor.state).toBe('healthy');
    expect(h.reconnects).toHaveLength(0);
  });

  it('resume BACKSTOPS a reconnect when the socket reports disconnected', async () => {
    const h = makeHarness();
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext();
    h.monitor.suspend();

    h.setSocketConnected(false);
    h.monitor.resume();
    expect(h.monitor.state).toBe('reconnecting');
    expect(h.reconnects).toHaveLength(0); // grace first
    await h.timers.runNext(); // grace → force a reconnect
    expect(h.reconnects).toEqual(['socket-disconnect']);
  });

  it('discards a LATE heartbeat ack from an abandoned context (anti-confusion guard)', async () => {
    const h = makeHarness();
    // A heartbeat that never resolves until we manually release it.
    let release!: (v: boolean) => void;
    h.setHeartbeat(() => new Promise<boolean>((r) => (release = r)));
    h.monitor.start();
    h.monitor.notifyConnected();
    // Fire the heartbeat timer — it issues sendHeartbeat (pending).
    await h.timers.runNext();
    // Suspend BEFORE the ack resolves: the in-flight heartbeat is now from an old generation.
    h.monitor.suspend();
    expect(h.monitor.state).toBe('suspended');
    // Now the stale heartbeat finally acks true — it must NOT flip us back to HEALTHY.
    release(true);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.monitor.state).toBe('suspended');
    expect(h.timers.pending()).toBe(0);
  });

  it('stop() halts the machine and ignores any further ticks', async () => {
    const h = makeHarness();
    h.setHeartbeat(async () => false);
    h.setHttpProbe(async () => false);
    h.monitor.start();
    h.monitor.notifyConnected();
    await h.timers.runNext();
    h.monitor.stop();
    const ran = await h.timers.runNext();
    expect(ran).toBe(false);
    expect(h.reconnects).toHaveLength(0);
  });
});
