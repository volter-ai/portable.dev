/**
 * connectionHealth — the tiered, framework-free connection-health state machine.
 *
 * WHY this exists. Over the gateway → cloudflared relay, a tunnel changeover (the
 * launcher cycles cloudflared, or it crash-rotates) drops the PC↔phone WebSocket,
 * but the phone frequently does NOT get a clean transport close — so socket.io-client's
 * `socket.connected` keeps reporting `true` against a DEAD endpoint, and its only
 * liveness signal is engine.io's server-negotiated ping (pingInterval 30s + pingTimeout
 * 120s ≈ 150s). The phone can therefore sit "connected" to nothing for ~2.5 minutes,
 * and socket.io's own auto-reconnect proved unreliable over the relay even once it does
 * notice. A browser over a direct connection never hit this (no relay, browsers surface WS closes promptly).
 *
 * THE MODEL. This machine maintains its OWN authoritative health state, derived ONLY
 * from round-trips it drives — it never trusts `socket.connected` as positive proof of
 * life. A cheap app-level heartbeat (a `ping` event acked by the PC over the SAME
 * WebSocket — ~tiny frames, far below engine.io's overhead) is the steady-state probe;
 * an HTTP `GET <relay>/api/health` is the fallback used ONLY when the socket heartbeat
 * goes unresponsive, to disambiguate a wedged transport (endpoint reachable → reconnect
 * now) from a down tunnel (endpoint unreachable → reconnect with backoff while the
 * launcher self-heal rotates the tunnel).
 *
 * TIERS (states):
 *   - HEALTHY      — last heartbeat acked. Heartbeat every {@link healthyIntervalMs}.
 *   - PROBING      — a heartbeat missed; re-probe at the tighter {@link probeIntervalMs}
 *                    so a transient mobile blip is absorbed before we react.
 *   - RECONNECTING — confirmed dead (probes exhausted, or the socket reported a
 *                    disconnect). Force a fresh transport; retry with exponential backoff
 *                    until a `connect` lands ({@link ConnectionHealthMonitor.notifyConnected}).
 *   - SUSPENDED    — app backgrounded OR device offline. All probing/reconnecting paused
 *                    (battery + pointless); the foreground/online edge {@link resume}s and
 *                    re-evaluates immediately.
 *
 * ANTI-CONFUSION RIGOR (the explicit requirement — no stateful confusion):
 *   - ONE authoritative {@link ConnectionHealthMonitor.state} + ONE {@link generation}
 *     counter. Every async callback (heartbeat ack, http probe, scheduled tick) captures
 *     the generation it was issued under and NO-OPS if the generation has since moved —
 *     so a late ack from an already-replaced socket can never flip us back to HEALTHY.
 *   - Single-flight: at most one in-flight heartbeat/probe and one reconnect loop.
 *   - Every trigger (heartbeat miss, AppState `active`, NetInfo online, socket connect/
 *     disconnect) funnels through THIS machine — nothing pokes `socket.connect()`
 *     independently, so two triggers can't race two reconnects.
 *
 * It is pure: all I/O (heartbeat, http probe, force-reconnect, timers, the UI publish) is
 * an injected seam, so the whole ladder is unit-tested with fakes + manual timers — no
 * socket, no network, no clock.
 */

export type ConnectionHealthState = 'healthy' | 'probing' | 'reconnecting' | 'suspended';

/** Why a reconnect was triggered (logged + tunes the first backoff). */
export type ReconnectCause = 'transport-wedged' | 'endpoint-down' | 'socket-disconnect';

type SetTimer = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
type ClearTimer = (handle: ReturnType<typeof setTimeout>) => void;

/** Steady-state heartbeat cadence (ms) — cheap, low overhead. */
export const DEFAULT_HEALTHY_INTERVAL_MS = 20_000;
/** Tight re-probe cadence once a heartbeat has missed (ms). */
export const DEFAULT_PROBE_INTERVAL_MS = 3_000;
/** Per-heartbeat ack timeout (ms). */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6_000;
/** Consecutive heartbeat misses before escalating to the HTTP fallback + reconnect. */
export const DEFAULT_MAX_MISSES = 2;
/** HTTP fallback (`/api/health`) probe timeout (ms). */
export const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 6_000;
/** First reconnect backoff (ms). */
export const DEFAULT_RECONNECT_BACKOFF_MS = 2_000;
/** Reconnect backoff ceiling (ms). */
export const DEFAULT_MAX_RECONNECT_BACKOFF_MS = 20_000;
/**
 * Grace before the monitor BACKSTOPS a clean disconnect (ms). A real `disconnect`
 * event is first left to socket.io's own auto-reconnect + the AppState/NetInfo
 * `reconnectAndSync`; only if the transport hasn't returned within this grace does the
 * monitor force it — so a foregrounded app on a stable network is never stranded when
 * socket.io's reconnect fails over the relay (the same unreliability the heartbeat
 * covers for the silent-dead case).
 */
export const DEFAULT_DISCONNECT_GRACE_MS = 8_000;

export interface ConnectionHealthSeams {
  /**
   * Emit one heartbeat over the live socket and resolve `true` IFF the PC acks within
   * `timeoutMs`. Never throws (resolves `false` on timeout / no socket / error).
   */
  sendHeartbeat: (timeoutMs: number) => Promise<boolean>;
  /**
   * Cheap NEGATIVE-only signal: does the underlying socket report an open transport?
   * Used to skip a doomed heartbeat (a reported-down socket → straight to reconnect);
   * a reported-UP socket is NOT trusted as alive (that is what the heartbeat is for).
   */
  isSocketConnected: () => boolean;
  /**
   * HTTP fallback probe of the relay (`GET <relay>/api/health`), used only when the
   * socket heartbeat is unresponsive. Resolves `true` if the endpoint answers healthily.
   * Never throws.
   */
  httpProbe: (timeoutMs: number) => Promise<boolean>;
  /** Force a fresh transport (disconnect → connect). The resulting `connect` calls {@link notifyConnected}. */
  forceReconnect: (cause: ReconnectCause) => void;
  /** Publish the coarse phase for the UI (banners/indicators). */
  onStateChange?: (state: ConnectionHealthState) => void;
  /** setTimeout seam (tests inject a manual scheduler). */
  setTimeoutImpl?: SetTimer;
  /** clearTimeout seam. */
  clearTimeoutImpl?: ClearTimer;
  /** Line sink. */
  log?: (line: string) => void;

  // ---- tunables (all defaulted) ----
  healthyIntervalMs?: number;
  probeIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxMisses?: number;
  httpProbeTimeoutMs?: number;
  reconnectBackoffMs?: number;
  maxReconnectBackoffMs?: number;
  disconnectGraceMs?: number;
}

export class ConnectionHealthMonitor {
  private readonly seams: ConnectionHealthSeams;
  private readonly setTimeoutImpl: SetTimer;
  private readonly clearTimeoutImpl: ClearTimer;
  private readonly log: (line: string) => void;
  private readonly healthyIntervalMs: number;
  private readonly probeIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxMisses: number;
  private readonly httpProbeTimeoutMs: number;
  private readonly reconnectBackoffMs: number;
  private readonly maxReconnectBackoffMs: number;
  private readonly disconnectGraceMs: number;

  private _state: ConnectionHealthState = 'suspended';
  private started = false;
  /**
   * Bumped on EVERY context change (state transition, suspend/resume, connect/disconnect,
   * stop). An async callback captured under an older generation is ignored — the single
   * guard that prevents a stale heartbeat/probe from corrupting the live state.
   */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private misses = 0;
  private reconnectAttempt = 0;

  constructor(seams: ConnectionHealthSeams) {
    this.seams = seams;
    this.setTimeoutImpl = seams.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl = seams.clearTimeoutImpl ?? ((h) => clearTimeout(h));
    this.log = seams.log ?? (() => {});
    this.healthyIntervalMs = seams.healthyIntervalMs ?? DEFAULT_HEALTHY_INTERVAL_MS;
    this.probeIntervalMs = seams.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.heartbeatTimeoutMs = seams.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxMisses = seams.maxMisses ?? DEFAULT_MAX_MISSES;
    this.httpProbeTimeoutMs = seams.httpProbeTimeoutMs ?? DEFAULT_HTTP_PROBE_TIMEOUT_MS;
    this.reconnectBackoffMs = seams.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    this.maxReconnectBackoffMs = seams.maxReconnectBackoffMs ?? DEFAULT_MAX_RECONNECT_BACKOFF_MS;
    this.disconnectGraceMs = seams.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  }

  get state(): ConnectionHealthState {
    return this._state;
  }

  /**
   * Begin monitoring. Call once the socket is built. Starts SUSPENDED until the first
   * `connect` ({@link notifyConnected}) or an explicit {@link resume}, so we never probe
   * before a transport exists.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.transition('suspended');
  }

  /** Stop all timers + invalidate in-flight callbacks. Idempotent. */
  stop(): void {
    this.started = false;
    this.generation++;
    this.clearTimer();
  }

  /**
   * The socket transport just opened (initial connect OR a reconnect landed). Confirm
   * life with an immediate heartbeat and, on ack, settle into HEALTHY. This is the ONLY
   * path out of RECONNECTING.
   */
  notifyConnected(): void {
    if (!this.started) return;
    this.misses = 0;
    this.reconnectAttempt = 0;
    this.transition('probing'); // bumps generation, cancels any reconnect-loop timer
    // Immediate confirming heartbeat (delay 0).
    this.scheduleHeartbeat(0);
  }

  /**
   * The socket reported a CLEAN disconnect (a real `disconnect` event fired). Start the
   * BACKSTOP: a clean drop is first left to socket.io's own auto-reconnect + the
   * AppState/NetInfo `reconnectAndSync` (the resulting `connect` calls
   * {@link notifyConnected}), but if the transport hasn't returned within
   * `disconnectGraceMs` the monitor FORCES it — socket.io's reconnect is unreliable over
   * the relay, so a foregrounded app on a stable network is never stranded. Kept SILENT
   * (no publish): the socket store's own `markDisconnected` ('disconnected' + the
   * ReconnectingBanner) already drives the UI. No-op when already reconnecting (incl. the
   * `disconnect` our OWN forceReconnect emits) or suspended (backgrounded/offline).
   */
  notifyDisconnected(): void {
    if (!this.started || this._state === 'reconnecting' || this._state === 'suspended') return;
    this.misses = 0;
    this.reconnectAttempt = 0;
    this.transition('reconnecting', false); // internal — markDisconnected owns the UI phase
    this.scheduleReconnect('socket-disconnect', 0, this.disconnectGraceMs);
  }

  /** App backgrounded OR device went offline: pause everything. */
  suspend(): void {
    if (!this.started) return;
    this.transition('suspended');
  }

  /**
   * App foregrounded OR device came back online: re-arm liveness checking. If the socket
   * reports connected, confirm it with an immediate heartbeat (which catches a socket
   * lying `connected:true` against a dead endpoint). If it reports disconnected, run the
   * silent backstop reconnect (socket.io + `reconnectAndSync` may not recover over the
   * relay — same reasoning as {@link notifyDisconnected}).
   */
  resume(): void {
    if (!this.started || this._state !== 'suspended') return;
    this.misses = 0;
    this.reconnectAttempt = 0;
    if (this.seams.isSocketConnected()) {
      this.transition('probing');
      this.scheduleHeartbeat(0);
    } else {
      this.transition('reconnecting', false);
      this.scheduleReconnect('socket-disconnect', 0, this.disconnectGraceMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private transition(next: ConnectionHealthState, publish = true): void {
    this.generation++;
    this.clearTimer();
    if (this._state !== next) {
      this._state = next;
      if (publish) this.seams.onStateChange?.(next);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
  }

  /**
   * The anti-confusion guard: an async callback is STALE (must no-op) if its generation
   * has been superseded, the machine has stopped, or we've suspended since it was issued.
   * Returns a boolean (NOT a type guard) on purpose — so callers don't inherit a narrowed
   * `this._state` across the check.
   */
  private isStale(gen: number): boolean {
    return gen !== this.generation || !this.started || this._state === 'suspended';
  }

  private scheduleHeartbeat(delayMs: number): void {
    const gen = this.generation;
    this.clearTimer();
    this.timer = this.setTimeoutImpl(() => {
      void this.runHeartbeat(gen);
    }, delayMs);
  }

  private async runHeartbeat(gen: number): Promise<void> {
    if (this.isStale(gen)) return;

    // A socket that itself reports closed is a free negative — don't waste a heartbeat.
    if (!this.seams.isSocketConnected()) {
      this.reconnect('socket-disconnect');
      return;
    }

    const acked = await this.seams.sendHeartbeat(this.heartbeatTimeoutMs);
    // Discard a late ack from a context we've already left (the anti-confusion guard).
    if (this.isStale(gen)) return;

    if (acked) {
      this.misses = 0;
      if (this._state !== 'healthy') {
        this.transition('healthy');
      } else {
        // Stay healthy — transition() would bump the generation needlessly; just reschedule.
        this.generation++;
      }
      this.scheduleHeartbeat(this.healthyIntervalMs);
      return;
    }

    // Missed.
    this.misses += 1;
    this.log(`[health] heartbeat miss ${this.misses}/${this.maxMisses}`);
    if (this.misses < this.maxMisses) {
      if (this._state !== 'probing') this.transition('probing');
      else this.generation++; // already probing — just keep the loop alive
      this.scheduleHeartbeat(this.probeIntervalMs);
      return;
    }

    // Probes exhausted — escalate via the HTTP fallback.
    await this.escalate();
  }

  /**
   * The WS heartbeat is unresponsive. ONE HTTP `/api/health` probe disambiguates the
   * recovery: reachable ⇒ the transport is wedged (reconnect now); unreachable ⇒ the
   * tunnel/endpoint is down (reconnect, but with backoff so we don't hammer a relay
   * that the launcher self-heal is still rotating).
   */
  private async escalate(): Promise<void> {
    const gen = this.generation;
    const reachable = await this.seams.httpProbe(this.httpProbeTimeoutMs);
    if (this.isStale(gen)) return;
    this.reconnect(reachable ? 'transport-wedged' : 'endpoint-down');
  }

  /**
   * Enter the RECONNECTING loop from the HEARTBEAT-ESCALATION path (the silent-dead
   * case): PUBLISH 'reconnecting' (there is no `markDisconnected` to drive the UI here)
   * and force a fresh transport now. The clean-disconnect backstop instead enters the
   * loop silently via {@link scheduleReconnect} (see {@link notifyDisconnected}).
   * {@link notifyConnected} BREAKS the loop in both cases.
   */
  private reconnect(cause: ReconnectCause): void {
    this.transition('reconnecting');
    this.misses = 0;
    this.attemptReconnect(cause, 0);
  }

  /** Schedule the next reconnect attempt after `delayMs`, no-op'd if superseded. */
  private scheduleReconnect(cause: ReconnectCause, attempt: number, delayMs: number): void {
    const gen = this.generation;
    this.clearTimer();
    this.timer = this.setTimeoutImpl(() => {
      if (gen !== this.generation || !this.started || this._state !== 'reconnecting') return;
      this.attemptReconnect(cause, attempt);
    }, delayMs);
  }

  private attemptReconnect(cause: ReconnectCause, attempt: number): void {
    this.reconnectAttempt = attempt + 1;
    this.log(`[health] reconnect (${cause}) attempt ${this.reconnectAttempt}`);
    try {
      this.seams.forceReconnect(cause);
    } catch (err) {
      this.log(
        `[health] forceReconnect error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Retry if `notifyConnected` doesn't land first (which bumps the generation and
    // cancels this timer). Backoff grows with the attempt count, capped.
    const backoff = Math.min(
      this.maxReconnectBackoffMs,
      this.reconnectBackoffMs * 2 ** Math.min(attempt, 10)
    );
    this.scheduleReconnect(cause, this.reconnectAttempt, backoff);
  }
}
