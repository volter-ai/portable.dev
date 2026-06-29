/**
 * fetch() with a hard timeout.
 *
 * Node's native `fetch` has NO default timeout: a request to an unreachable or
 * hanging host (e.g. GitHub is offline, or a TCP connection that never sends a
 * response) waits FOREVER, holding the request/handler open. On the single-
 * threaded server that means piled-up requests and an app that appears frozen.
 *
 * This bounds every call with an AbortSignal and normalizes the abort into a
 * typed {@link FetchTimeoutError} so callers (and handleGitHubApiError) can
 * detect "the upstream is unreachable" and degrade gracefully instead of
 * hanging or surfacing an opaque 500.
 */

/** Thrown when a {@link fetchWithTimeout} call exceeds its time budget. */
export class FetchTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number
  ) {
    super(`fetch ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Like `fetch`, but aborts after `timeoutMs` (default 30s) and rejects with a
 * {@link FetchTimeoutError}. Any caller-supplied `signal` is respected; the
 * timeout fires independently of it.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If the caller passed their own signal, abort our controller when it fires
  // so we honor cancellation as well as the timeout.
  const callerSignal = options.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // Our timeout aborted it (and the caller's own signal, if any, isn't the
    // cause) → surface a clear, typed timeout error.
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Network-level error codes that mean "the upstream host is unreachable". */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND', // DNS lookup failed (offline / bad host)
  'EAI_AGAIN', // transient DNS failure
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', // undici connect timeout
]);

/**
 * True when an error reflects an UNREACHABLE upstream (timeout, DNS failure,
 * connection refused/reset) rather than an HTTP error response. Used to map
 * "GitHub is offline" into a clean 503 instead of an opaque 500 or a hang.
 *
 * Native `fetch` surfaces these as a `TypeError: fetch failed` whose `.cause`
 * carries the real `code`; AbortSignal timeouts surface as `AbortError` /
 * `TimeoutError`; {@link fetchWithTimeout} normalizes its own timeout to
 * {@link FetchTimeoutError}. We check all of those shapes.
 */
export function isUpstreamUnreachableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };

  if (e.name === 'FetchTimeoutError' || e.name === 'AbortError' || e.name === 'TimeoutError') {
    return true;
  }
  if (e.code && UNREACHABLE_CODES.has(e.code)) return true;
  if (e.cause?.code && UNREACHABLE_CODES.has(e.cause.code)) return true;
  // undici's generic network failure (no machine-readable code on the top error)
  if (typeof e.message === 'string' && e.message.toLowerCase().includes('fetch failed')) {
    return true;
  }
  return false;
}
