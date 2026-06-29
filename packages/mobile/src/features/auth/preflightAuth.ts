/**
 * preflightAuthToken — authoritative validation of the persisted authToken
 * against the CURRENT gateway, before any flow trusts it.
 *
 * Why a plain `fetch` and not the SSE stream: the `react-native-sse` polyfill
 * mangles both authoritative rejection shapes — a 401 surfaces as a data-less
 * `error` event, and a 2xx `text/html` body (a gateway WITHOUT the RN routes
 * serving its SPA catch-all `index.html`) parses as an event stream with zero
 * events, i.e. total silence. A direct `GET /auth/mobile/react-native/me` gives
 * us the status code and body intact.
 *
 * Verdicts:
 *   - `valid`         — 2xx + a JSON object body: the token works on this gateway.
 *   - `auth-dead`     — 401/403 (foreign/expired/revoked token), OR a 2xx
 *                       non-JSON body answered by the gateway origin itself
 *                       (SPA catch-all ⇒ the RN routes don't exist here — the
 *                       app cannot work against this gateway either way).
 *   - `indeterminate` — network error / timeout / 5xx / an OFF-origin 2xx
 *                       non-JSON response (e.g. a captive portal that redirected
 *                       the request). NEVER sign the user out on these — the
 *                       offline returning-user fail-open paths stay intact.
 *
 * Framework-free; every I/O seam injectable for deterministic tests.
 */

import type { GatewayClient } from '../../services/gatewayClient';

export type PreflightResult = 'valid' | 'auth-dead' | 'indeterminate';

/** Per-request deadline — a slow gateway must not stall cold boot. */
export const PREFLIGHT_TIMEOUT_MS = 8000;

export interface PreflightDeps {
  gateway: GatewayClient;
  authToken: string;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms, default {@link PREFLIGHT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** AbortSignal factory — injectable so tests avoid real timers. */
  timeoutSignal?: (ms: number) => AbortSignal | undefined;
}

function defaultTimeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined; // No AbortSignal.timeout on this runtime — no deadline.
  }
}

export async function preflightAuthToken(deps: PreflightDeps): Promise<PreflightResult> {
  const requestUrl = deps.gateway.url('/me');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeSignal = deps.timeoutSignal ?? defaultTimeoutSignal;

  let res: Response;
  try {
    res = await fetchImpl(requestUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${deps.authToken}`,
        Accept: 'application/json',
      },
      // No cookies, ever — the RN gateway contract is Bearer-only.
      credentials: 'omit',
      signal: makeSignal(deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS),
    });
  } catch {
    return 'indeterminate';
  }

  if (res.status === 401 || res.status === 403) return 'auth-dead';
  if (!res.ok) return 'indeterminate';

  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed !== null && typeof parsed === 'object') return 'valid';
  } catch {
    // Non-JSON 2xx — classified by origin below.
  }

  // 2xx but not JSON. Authoritative ONLY when the gateway itself answered (its
  // SPA catch-all serving index.html ⇒ the RN routes are absent). A response
  // whose final URL left the gateway origin (captive-portal redirect) proves
  // nothing about our credentials.
  const origin = requestUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1');
  const finalUrl = (res as { url?: string }).url ?? '';
  return !finalUrl || finalUrl.startsWith(origin) ? 'auth-dead' : 'indeterminate';
}
