/**
 * startupHealthCheck — cold-start boot check (local-first budget).
 *
 * On launch the app reaches the PC's backend THROUGH THE RELAY
 * (`GET <gatewayBase>/t/<pcId>/api/health`). The PC api is ALREADY up by the time a
 * device is paired — the launcher waits for `/api/health` before showing the QR —
 * so the only legitimate reason this probe misses on boot is a brief **cloudflared
 * tunnel rotation**: the PC's tunnel URL rotates and the gateway re-points by
 * `pcId`, leaving a few-second window where the relay has no live URL (503). That
 * is NOT a dead PC, so we poll on a short front-loaded backoff and show a LOADING
 * state (never an error) until the PC answers `200 { status: 'ok' }` or the budget
 * is exhausted.
 *
 * **This is NOT a remote "sandbox cold start"** — there is no container warming up
 * in local-first, so the budget is deliberately SHORT (~11.5s), not the old ~92s
 * container-boot wait. If the PC isn't answering within a rotation window it is
 * genuinely down (launcher stopped / tunnel gone / pcId unregistered → relay 404)
 * and waiting longer won't help: exhaustion hands off to the ConnectionFailed UX,
 * which now offers a **"Connect PC"** re-scan exit.
 *
 *   - Backoff (seconds BEFORE each retry): `[0.5, 1, 2, 3, 5]` (capped 15s,
 *     `STARTUP_BACKOFF_CAP_SECONDS`). Front-loaded so a missed first probe (a relay
 *     re-route mid-rotation) is retried sub-second.
 *   - Attempt budget: `STARTUP_MAX_ATTEMPTS` (6) → 5 inter-attempt gaps ≈ 11.5s.
 *   - Abortable: the caller passes an `AbortSignal` (fired on navigate-away /
 *     sign-out). It cancels BOTH the in-flight probe and any pending backoff
 *     delay, and the whole check rejects with an `AbortError` so the ViewModel
 *     can run cleanup WITHOUT flipping the UI into a failed state.
 *
 * This contrasts with the steady-state `SandboxHealthMonitor`, which assumes the
 * PC has already answered at least once. The startup check is the FIRST-CONTACT
 * path: it runs once on boot, succeeds the moment the relay routes to the live
 * PC, and on exhaustion hands off to the ConnectionFailed UX.
 *
 * A probe only counts as healthy when the response is the REAL backend health body
 * (`isHealthyHealthResponse`: 2xx + JSON `{ status: 'ok' }`) — a dead tunnel's edge
 * answers 200 with an HTML page, which must read as a failed attempt, never as
 * "booted".
 *
 * Framework-free (no React/Expo): every I/O seam (`fetch`, the backoff delay,
 * the per-request timeout signal) is injectable so the backoff schedule and the
 * abort contract run deterministically in Jest with mocked timers.
 */

import { isHealthyHealthResponse } from '@vgit2/shared/sandbox';

/**
 * Seconds to wait BEFORE each retry (gap N uses index N). Front-loaded: the first
 * gaps are sub-second so a missed first probe (a brief relay re-route during a
 * cloudflared rotation) is retried fast. SHORT by design — local-first has no remote
 * container cold boot to wait out (see the file docstring).
 */
export const STARTUP_BACKOFF_SECONDS: readonly number[] = [0.5, 1, 2, 3, 5];

/** Cap (seconds) applied to every backoff gap, including those past the array. */
export const STARTUP_BACKOFF_CAP_SECONDS = 15;

/**
 * Total health-probe attempts before the cold start is declared failed. 6 (→ 5
 * gaps ≈ 11.5s) is enough to ride out a cloudflared tunnel rotation; it is NOT the
 * old ~92s remote-container budget — there is no sandbox warming up in local-first,
 * so a PC that isn't answering within a rotation window is genuinely down.
 */
export const STARTUP_MAX_ATTEMPTS = 6;

/**
 * Per-probe timeout. 15s tolerates a sandbox that accepts the TCP connection but
 * is slow to answer while booting (mirrors `HEALTH_CHECK_TIMEOUT_MS`).
 */
export const STARTUP_HEALTH_TIMEOUT_MS = 15_000;

/** Thrown when the sandbox never became healthy within the attempt budget. */
export class StartupHealthCheckError extends Error {
  /** How many probe attempts were made (equals `maxAttempts`). */
  readonly attempts: number;
  constructor(attempts: number) {
    super(`Sandbox did not become healthy after ${attempts} startup attempts`);
    this.name = 'StartupHealthCheckError';
    this.attempts = attempts;
  }
}

/** An `AbortError` (name-tagged so it is distinguishable across runtimes). */
function abortError(): Error {
  const err = new Error('Startup health check aborted');
  err.name = 'AbortError';
  return err;
}

/** True when `err` is the abort signal propagating out of the check. */
export function isStartupAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Backoff delay (ms) for the gap that precedes attempt `gapIndex + 2`
 * (`gapIndex` is 0-based: gap 0 is the wait after attempt 1). Uses the explicit
 * schedule, then the cap; the cap is also applied to the explicit values.
 */
export function startupBackoffDelayMs(
  gapIndex: number,
  opts: { backoffSeconds?: readonly number[]; capSeconds?: number } = {}
): number {
  const seq = opts.backoffSeconds ?? STARTUP_BACKOFF_SECONDS;
  const cap = opts.capSeconds ?? STARTUP_BACKOFF_CAP_SECONDS;
  const seconds = gapIndex < seq.length ? seq[gapIndex] : cap;
  return Math.min(seconds, cap) * 1000;
}

/** Default abortable delay: a `setTimeout` that also resolves/rejects on abort. */
function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Default per-request timeout signal (uses `AbortSignal.timeout` when present). */
function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } })
    .AbortSignal;
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined;
}

/**
 * Combine the external abort signal with the per-request timeout into one signal
 * for `fetch`. Prefers `AbortSignal.any` when available; otherwise falls back to
 * whichever single signal exists (the external-abort case is still honored
 * because `startupHealthCheck` re-checks `signal.aborted` after the probe).
 */
function linkProbeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
  timeoutSignal: (ms: number) => AbortSignal | undefined
): AbortSignal | undefined {
  const timeout = timeoutSignal(timeoutMs);
  const anyFn = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (external && timeout && typeof anyFn === 'function') return anyFn([external, timeout]);
  return external ?? timeout;
}

export interface StartupHealthCheckDeps {
  /** Mutable sandbox base URL to probe (`{url}/api/health`). */
  sandboxUrl: string;
  /** `fetch` used for the probe (default: global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Cancels the whole check (navigate away / sign out) → rejects `AbortError`. */
  signal?: AbortSignal;
  /** Abortable backoff delay (default: `setTimeout`-based). Injected in tests. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Total attempts before failing (default {@link STARTUP_MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /** Backoff schedule in seconds (default {@link STARTUP_BACKOFF_SECONDS}). */
  backoffSeconds?: readonly number[];
  /** Backoff cap in seconds (default {@link STARTUP_BACKOFF_CAP_SECONDS}). */
  capSeconds?: number;
  /** Per-probe timeout in ms (default {@link STARTUP_HEALTH_TIMEOUT_MS}). */
  healthTimeoutMs?: number;
  /** Build the per-request timeout signal. Injected in tests. */
  timeoutSignal?: (ms: number) => AbortSignal | undefined;
  /** Called with the 1-based attempt number before each probe (for loading UX). */
  onAttempt?: (attempt: number) => void;
}

/**
 * One probe: `true` only for the real JSON health body (2xx + `status:'ok'`);
 * `false` on non-2xx / non-JSON 200 / network error / timeout.
 */
async function probeOnce(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  healthTimeoutMs: number,
  timeoutSignal: (ms: number) => AbortSignal | undefined
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: linkProbeSignal(signal, healthTimeoutMs, timeoutSignal),
    });
    return await isHealthyHealthResponse(response);
  } catch {
    // An EXTERNAL abort propagates as a cancellation; a per-request TIMEOUT (or
    // any other transport error) is just a failed attempt to retry on.
    if (signal?.aborted) throw abortError();
    return false;
  }
}

/**
 * Poll `{sandboxUrl}/api/health` on the cold-start backoff until it answers
 * with the real JSON health body (2xx + `{ status: 'ok' }`).
 *
 * @returns when the sandbox is healthy (the JSON health body was observed).
 * @throws {StartupHealthCheckError} when all `maxAttempts` probes failed.
 * @throws an `AbortError` (see {@link isStartupAbort}) when `signal` fires.
 */
export async function startupHealthCheck(deps: StartupHealthCheckDeps): Promise<void> {
  const {
    sandboxUrl,
    // Cast to `typeof fetch`: with both DOM and React Native `fetch` types in
    // scope, `Parameters<typeof fetch>` resolves to RN's narrower overload
    // (input: RequestInfo, no URL) while the param annotation keeps DOM's wider
    // one (RequestInfo | URL) — a contravariance mismatch. The wrapper forwards
    // verbatim at runtime; the cast just reconciles the dual type declarations.
    fetchImpl = ((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch,
    signal,
    delay = defaultDelay,
    maxAttempts = STARTUP_MAX_ATTEMPTS,
    backoffSeconds = STARTUP_BACKOFF_SECONDS,
    capSeconds = STARTUP_BACKOFF_CAP_SECONDS,
    healthTimeoutMs = STARTUP_HEALTH_TIMEOUT_MS,
    timeoutSignal = defaultTimeoutSignal,
    onAttempt,
  } = deps;

  const healthUrl = `${sandboxUrl.replace(/\/+$/, '')}/api/health`;
  throwIfAborted(signal);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    onAttempt?.(attempt);

    if (await probeOnce(healthUrl, fetchImpl, signal, healthTimeoutMs, timeoutSignal)) {
      return; // sandbox is up — boot complete.
    }

    throwIfAborted(signal);
    if (attempt < maxAttempts) {
      await delay(startupBackoffDelayMs(attempt - 1, { backoffSeconds, capSeconds }), signal);
    }
  }

  throw new StartupHealthCheckError(maxAttempts);
}
