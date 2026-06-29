/**
 * SandboxHealthMonitor — framework-free liveness monitor for the remote
 * backend.
 *
 * The remote backend that serves `/api/*` and the Socket.IO handshake can be
 * paused, killed, or migrated out from under a connected
 * client. This monitor proactively detects a genuinely-dead backend by polling
 * `GET {sandbox}/api/health` every 5s and tripping a ConnectionFailed signal
 * after 90s of CONTINUOUS, network-connected failure — but it must NOT "cry
 * wolf" when the user is merely offline or backgrounded.
 *
 * Key behaviours:
 *   - Poll interval: 5s (`HEALTH_POLL_INTERVAL_MS`), per-request timeout 15s
 *     (`HEALTH_CHECK_TIMEOUT_MS`, tolerant of cold starts + slow mobile
 *     networks).
 *   - A check only counts as healthy when the response is the REAL backend
 *     health body (`isHealthyHealthResponse`: 2xx + JSON `{ status: 'ok' }`).
 *     A dead tunnel's edge answers 200 with an HTML page — that is a
 *     FAILURE, not a success.
 *   - The 90s failure accumulator (`CONNECTION_FAILED_THRESHOLD_MS`) only counts
 *     wall-clock time during which the network is connected. Going offline
 *     FREEZES the accumulator (the in-flight segment is banked into the running
 *     total and time stops); coming back online RESUMES it from where it left
 *     off. Stopping the poll (`stopHealthPolling`) also freezes — it preserves
 *     the accumulated total so a *backgrounded* app does not reset its progress.
 *   - `reset()` is the only thing that clears the accumulator and the
 *     ConnectionFailed latch — the RN wrapper calls it on foreground `active` so
 *     a returning user gets a fresh 90s window.
 *
 * This file is deliberately framework-free (no React, React Native, or DOM): the
 * RN client (`packages/mobile`) injects its own lifecycle (AppState/NetInfo)
 * through the public injection points
 * `setNetworkConnected`, `start/stopHealthPolling`, and `reset`. All I/O seams
 * (`fetch`, the clock, the interval scheduler, the abort timeout) are injectable
 * so the thresholds can be exercised deterministically without real timers.
 *
 * Out of scope here: authoritative liveness via the Gateway sandbox-status
 * endpoint, recovery / re-provisioning, and the socket/api-failure detection
 * strategies. The monitor here is purely the health-poll accumulator.
 */

/** Poll cadence for `GET {sandbox}/api/health`. */
export const HEALTH_POLL_INTERVAL_MS = 5_000;

/**
 * Per-request timeout for a single health check. 15s tolerates cold
 * starts and slow mobile networks — a slow-but-eventually-OK response should
 * NOT be counted as a failure.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 15_000;

/**
 * Continuous, network-connected failure time after which the sandbox is
 * declared dead (→ ConnectionFailed). 90s of real failure, never counting
 * offline / backgrounded time.
 */
export const CONNECTION_FAILED_THRESHOLD_MS = 90_000;

/** Coarse connection phase surfaced to the UI (banner). */
export type SandboxHealthStatus = 'reconnecting' | 'connected';

/** Opaque handle returned by the interval scheduler seam. */
type HealthPollHandle = unknown;

export interface SandboxHealthMonitorOptions {
  /**
   * Called exactly once when continuous network-connected failure first crosses
   * {@link CONNECTION_FAILED_THRESHOLD_MS}. Polling is stopped before this fires;
   * the latch is released only by {@link SandboxHealthMonitor.reset}.
   */
  onConnectionFailed?: () => void;
  /**
   * Called on `reconnecting` (first failure after a healthy run) and `connected`
   * (first success after a failing run) transitions — drives the reconnecting
   * banner without ever tripping ConnectionFailed.
   */
  onStatusChange?: (status: SandboxHealthStatus) => void;
  /**
   * Called on EVERY failed health check with the running count of consecutive
   * failures (1 on the first failure of a run, reset to 0 on any success). The
   * authoritative-liveness layer uses this count to gate its Gateway
   * `/sandbox/status` check — steady-state after the 1st failure, cold-start after
   * the 2nd. Fires regardless of whether the 90s threshold has tripped.
   */
  onHealthFailure?: (consecutiveFailures: number) => void;
  /**
   * Called on EVERY successful health check (after the failure accumulator + the
   * consecutive-failure counter are cleared). Lets the liveness layer
   * learn the sandbox has been reached at least once (cold-start → steady-state).
   */
  onHealthSuccess?: () => void;

  /** `fetch` implementation (default: global `fetch`). Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Monotonic-ish clock in ms (default: `Date.now`). Injected in tests. */
  now?: () => number;
  /** Interval scheduler (default: global `setInterval`). Injected in tests. */
  setIntervalImpl?: (callback: () => void, ms: number) => HealthPollHandle;
  /** Interval canceller (default: global `clearInterval`). Injected in tests. */
  clearIntervalImpl?: (handle: HealthPollHandle) => void;
  /**
   * Build an abort signal that fires after `ms` (default: `AbortSignal.timeout`
   * when available, else `undefined`). Injected in tests.
   */
  timeoutSignal?: (ms: number) => AbortSignal | undefined;

  /** Override the 5s poll cadence (defaults to {@link HEALTH_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** Override the 15s per-request timeout (defaults to {@link HEALTH_CHECK_TIMEOUT_MS}). */
  healthTimeoutMs?: number;
  /** Override the 90s failure threshold (defaults to {@link CONNECTION_FAILED_THRESHOLD_MS}). */
  connectionFailedMs?: number;
}

/** Default abort-timeout: use `AbortSignal.timeout` when the runtime has it. */
function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } })
    .AbortSignal;
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined;
}

/**
 * Whether a `GET /api/health` response is the REAL backend's health body.
 *
 * An HTTP 2xx alone is NOT proof of life: a dead backend's tunnel host
 * can keep answering `200` with an HTML edge page, which made `response.ok`
 * checks read a zombie as healthy forever (the app then never detects
 * death and hammers the dead URL). The backend's `/api/health` returns JSON
 * `{ status: 'ok', … }` (packages/api `health.routes.ts`), so anything that
 * is not a 2xx **JSON body with `status === 'ok'`** counts as a failure.
 *
 * Structurally typed (not the DOM `Response`) so the shared module stays
 * framework/lib-free; any fetch Response satisfies it.
 */
export async function isHealthyHealthResponse(response: {
  ok: boolean;
  json(): Promise<unknown>;
}): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = (await response.json()) as { status?: unknown } | null;
    return body?.status === 'ok';
  } catch {
    // Non-JSON 200 (e.g. an edge HTML page for a dead tunnel).
    return false;
  }
}

export class SandboxHealthMonitor {
  private readonly onConnectionFailed?: () => void;
  private readonly onStatusChange?: (status: SandboxHealthStatus) => void;
  private readonly onHealthFailure?: (consecutiveFailures: number) => void;
  private readonly onHealthSuccess?: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly setIntervalImpl: (callback: () => void, ms: number) => HealthPollHandle;
  private readonly clearIntervalImpl: (handle: HealthPollHandle) => void;
  private readonly timeoutSignal: (ms: number) => AbortSignal | undefined;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly connectionFailedMs: number;

  /** Active poll handle, or `null` when not polling. */
  private intervalHandle: HealthPollHandle | null = null;
  /** Normalized sandbox base URL currently being polled. */
  private currentSandboxUrl: string | null = null;
  /** NetInfo-driven connectivity gate; while `false`, failures are not counted. */
  private networkConnected = true;
  /** Latched once 90s is crossed; cleared only by `reset()`. */
  private connectionFailed = false;
  /** True while in a failing run (used to emit `reconnecting`/`connected` once each). */
  private wasReconnecting = false;
  /** Count of consecutive failed checks; reset to 0 on any success. */
  private consecutiveFailures = 0;

  /** Banked failure time from completed (frozen) segments. */
  private accumulatedFailureMs = 0;
  /** Start `now()` of the current open failure segment, or `null` when not failing / frozen. */
  private currentFailureSegmentStart: number | null = null;

  constructor(options: SandboxHealthMonitorOptions = {}) {
    this.onConnectionFailed = options.onConnectionFailed;
    this.onStatusChange = options.onStatusChange;
    this.onHealthFailure = options.onHealthFailure;
    this.onHealthSuccess = options.onHealthSuccess;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.setIntervalImpl =
      options.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms) as HealthPollHandle);
    this.clearIntervalImpl =
      options.clearIntervalImpl ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
    this.timeoutSignal = options.timeoutSignal ?? defaultTimeoutSignal;
    this.pollIntervalMs = options.pollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    this.connectionFailedMs = options.connectionFailedMs ?? CONNECTION_FAILED_THRESHOLD_MS;
  }

  // --- public injection points (the contract the platform wrappers drive) ---

  /**
   * Update network connectivity. Going offline FREEZES the failure accumulator
   * (banks the in-flight segment, stops the clock); coming back online RESUMES
   * accumulation from the banked total. Polling itself is unaffected — a check
   * that fires while offline is simply skipped (not counted).
   */
  setNetworkConnected(connected: boolean): void {
    const wasConnected = this.networkConnected;
    if (wasConnected === connected) return;
    this.networkConnected = connected;

    if (wasConnected && !connected) {
      // Offline: freeze the in-flight failure segment.
      this.freezeFailureSegment();
    } else if (!wasConnected && connected) {
      // Online again: resume timing if we were mid-failure.
      if (this.accumulatedFailureMs > 0 && this.currentFailureSegmentStart === null) {
        this.currentFailureSegmentStart = this.now();
      }
    }
  }

  /**
   * Begin polling `{sandboxUrl}/api/health` every {@link pollIntervalMs}. A
   * different URL releases the ConnectionFailed latch (a new sandbox gets a
   * fresh window). Re-starting the SAME URL while already polling is a no-op.
   * Does NOT clear the failure accumulator — use {@link reset} for that — so a
   * backgrounded→foregrounded restart can deliberately preserve OR reset.
   */
  startHealthPolling(sandboxUrl: string): void {
    const normalized = sandboxUrl.replace(/\/+$/, '');

    // A new sandbox URL means a fresh sandbox — release the death latch.
    if (this.currentSandboxUrl !== normalized) {
      this.connectionFailed = false;
    }
    if (this.connectionFailed) return;
    if (this.intervalHandle !== null && this.currentSandboxUrl === normalized) return;

    this.stopInterval();
    this.currentSandboxUrl = normalized;

    // Check immediately, then on the cadence.
    void this.checkHealth();
    this.intervalHandle = this.setIntervalImpl(() => {
      void this.checkHealth();
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling and FREEZE the accumulator (bank the in-flight segment). The
   * accumulated failure total is preserved so a backgrounded app does not lose
   * its progress; the URL is retained so the same sandbox can be resumed.
   */
  stopHealthPolling(): void {
    this.stopInterval();
    this.freezeFailureSegment();
  }

  /**
   * Clear ALL failure state: banked total, open segment, the reconnecting flag,
   * and the ConnectionFailed latch. Does not touch polling — callers that want
   * to resume should `reset()` then `startHealthPolling(url)`.
   */
  reset(): void {
    this.resetFailureTimer();
    this.wasReconnecting = false;
    this.connectionFailed = false;
    this.consecutiveFailures = 0;
  }

  /**
   * Authoritatively declare the sandbox dead NOW, short-circuiting the 90s
   * accumulator. Used by the Gateway-status liveness layer when the
   * Gateway reports `running:false`: stops polling, latches ConnectionFailed, and
   * fires `onConnectionFailed` exactly once (idempotent — cleared by `reset()`).
   */
  markConnectionFailed(): void {
    this.tripConnectionFailed();
  }

  /** Whether the 90s threshold has tripped (latched until `reset()`). */
  get isConnectionFailed(): boolean {
    return this.connectionFailed;
  }

  /** Banked + in-flight network-connected failure time, in ms (for diagnostics/tests). */
  get accumulatedFailureMsForTest(): number {
    const open =
      this.currentFailureSegmentStart === null
        ? 0
        : Math.max(0, this.now() - this.currentFailureSegmentStart);
    return this.accumulatedFailureMs + open;
  }

  // --- internals ---

  private stopInterval(): void {
    if (this.intervalHandle !== null) {
      this.clearIntervalImpl(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Bank the currently-open failure segment and close it (idempotent). */
  private freezeFailureSegment(): void {
    if (this.currentFailureSegmentStart !== null) {
      this.accumulatedFailureMs += Math.max(0, this.now() - this.currentFailureSegmentStart);
      this.currentFailureSegmentStart = null;
    }
  }

  private resetFailureTimer(): void {
    this.accumulatedFailureMs = 0;
    this.currentFailureSegmentStart = null;
  }

  private async checkHealth(): Promise<void> {
    // Guard: no URL, already dead, or offline → don't poll / don't count.
    if (!this.currentSandboxUrl || this.connectionFailed || !this.networkConnected) return;

    const healthUrl = `${this.currentSandboxUrl}/api/health`;
    try {
      const response = await this.fetchImpl(healthUrl, {
        method: 'GET',
        signal: this.timeoutSignal(this.healthTimeoutMs),
      });
      // A 2xx alone is not proof of life — a dead tunnel's edge can
      // answer 200 with HTML, so the body must be the real JSON health body.
      const healthy = await isHealthyHealthResponse(response);
      // State may have changed while awaiting (went offline / stopped / died).
      if (!this.networkConnected || this.connectionFailed) return;
      if (healthy) {
        this.handleHealthSuccess();
      } else {
        this.handleHealthFailure();
      }
    } catch {
      // A failure observed after going offline mid-flight must not be counted.
      if (!this.networkConnected || this.connectionFailed) return;
      this.handleHealthFailure();
    }
  }

  private handleHealthSuccess(): void {
    this.resetFailureTimer();
    this.consecutiveFailures = 0;
    if (this.wasReconnecting) {
      this.wasReconnecting = false;
      this.onStatusChange?.('connected');
    }
    this.onHealthSuccess?.();
  }

  private handleHealthFailure(): void {
    if (this.currentFailureSegmentStart === null) {
      this.currentFailureSegmentStart = this.now();
    }
    if (!this.wasReconnecting) {
      this.wasReconnecting = true;
      this.onStatusChange?.('reconnecting');
    }

    this.consecutiveFailures += 1;
    // Report the failure (with its consecutive count) BEFORE the natural 90s
    // trip check so the liveness layer can short-circuit the wait if the Gateway
    // confirms death — or reset the timer if it confirms the sandbox is alive.
    this.onHealthFailure?.(this.consecutiveFailures);

    const totalFailureMs =
      this.accumulatedFailureMs + Math.max(0, this.now() - this.currentFailureSegmentStart);
    if (totalFailureMs >= this.connectionFailedMs) {
      this.tripConnectionFailed();
    }
  }

  private tripConnectionFailed(): void {
    if (this.connectionFailed) return;
    this.connectionFailed = true;
    this.stopInterval();
    this.onConnectionFailed?.();
  }
}
