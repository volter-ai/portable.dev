/**
 * authedFetch — a Bearer-authenticated `fetch` with token refresh.
 *
 * TWO refresh modes, picked by which seam the caller wires:
 *
 *  - **Legacy gateway-facing authToken** (no `persistRenewedToken`): on a `401`
 *    the client refreshes REACTIVELY by calling
 *    `POST /auth/mobile/react-native/refresh`, persists the fresh token to
 *    SecureStore, and replays the original request once with the new Bearer. It
 *    deliberately IGNORES any `X-Renewed-Token` response header — the
 *    authoritative fresh token comes only from `/refresh`. Concurrent 401s share
 *    a single in-flight refresh (single-flight).
 *
 *  - **Device-path credential** (`persistRenewedToken` supplied): the PC
 *    SLIDES the data-path JWT before expiry and returns the fresh one in the
 *    relay's `X-Renewed-Token` response header. There is NO `/refresh` on the PC,
 *    so the client HONORS that header — persists the renewed JWT via
 *    `persistRenewedToken` (keyed by the connected pcId) + fires
 *    `onTokenRefreshed` — and SKIPS the `/refresh` round-trip entirely (a 401 is
 *    returned to the caller for the death/re-pair path).
 *
 * Either way the current token (from `getToken`) is attached as
 * `Authorization: Bearer …` (cookies never sent — `credentials:'omit'`, per the
 * RN HTTP contract). No React/Expo coupling beyond SecureStore (injectable), so
 * it is trivially unit-testable.
 */

import type { GatewayClient } from '../../services/gatewayClient';
import { NoAuthTokenError, refreshAuthToken } from './refreshAuthToken';
import { getAuthToken, saveAuthToken } from './secureAuthStore';

/** An authenticated `fetch` — same signature as the global `fetch`. */
export type AuthedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CreateAuthedFetchOptions {
  /** Gateway client used to drive `POST /refresh`. */
  gateway: GatewayClient;
  /** Underlying fetch (defaults to global `fetch`) — eases testing. */
  fetchImpl?: typeof fetch;
  /** Read the current `authToken` (default: SecureStore `getAuthToken`). */
  getToken?: () => Promise<string | null>;
  /** Persist a refreshed `authToken` (default: SecureStore `saveAuthToken`). */
  saveToken?: (token: string) => Promise<void>;
  /**
   * Notified with the fresh token immediately after a successful refresh (legacy
   * `/refresh`) OR after honoring a relay `X-Renewed-Token` header (device path).
   * Used to re-point the socket handshake atomically; optional here.
   */
  onTokenRefreshed?: (token: string) => void;
  /**
   * DEVICE-PATH renewal seam. When supplied, the client HONORS the
   * relay's `X-Renewed-Token` response header — persisting the renewed data-path
   * JWT via this seam (the PC slides it before expiry, keyed by the connected
   * pcId) — and SKIPS the `/refresh` round-trip on a 401 (there is no `/refresh`
   * on the PC). When omitted, the legacy gateway `/refresh` behavior applies.
   */
  persistRenewedToken?: (token: string) => Promise<void>;
}

/** The relay header carrying a PC-renewed data-path JWT. */
const RENEWED_TOKEN_HEADER = 'X-Renewed-Token';

/** Normalise any `HeadersInit` shape to a plain object so we can override one key. */
function headersToObject(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  const maybe = init as unknown as Headers;
  if (typeof maybe.forEach === 'function') {
    maybe.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [key, value] of init) out[key] = value;
  } else {
    Object.assign(out, init as Record<string, string>);
  }
  return out;
}

/** Apply `Authorization: Bearer <token>` (cookies always omitted). */
function withBearer(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = headersToObject(init?.headers);
  if (token) headers.Authorization = `Bearer ${token}`;
  return { ...init, headers, credentials: 'omit' };
}

/**
 * Build a Bearer-authenticated `fetch` with reactive (401-driven) token refresh.
 */
export function createAuthedFetch(opts: CreateAuthedFetchOptions): AuthedFetch {
  const doFetch = opts.fetchImpl ?? fetch;
  const read = opts.getToken ?? getAuthToken;
  const write = opts.saveToken ?? saveAuthToken;
  const persistRenewed = opts.persistRenewedToken;

  // Single-flight refresh: concurrent 401s await the same in-flight refresh.
  let inflight: Promise<string> | null = null;
  const refresh = (): Promise<string> => {
    if (!inflight) {
      inflight = refreshAuthToken(opts.gateway, { getToken: read, saveToken: write })
        .then((token) => {
          opts.onTokenRefreshed?.(token);
          return token;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  return async (input, init) => {
    const token = await read();
    const res = await doFetch(input, withBearer(init, token));

    // DEVICE PATH: the relay slides the JWT and returns a fresh one in
    // `X-Renewed-Token`. Persist it (keyed by the connected pcId via the seam) +
    // notify, and SKIP `/refresh` entirely (there is none on the PC — a 401 is
    // returned for the death/re-pair path).
    if (persistRenewed) {
      const renewed = res.headers.get(RENEWED_TOKEN_HEADER);
      if (renewed) {
        await persistRenewed(renewed);
        opts.onTokenRefreshed?.(renewed);
      }
      return res;
    }

    if (res.status !== 401) return res;

    // LEGACY gateway path: reactive refresh on 401. We do NOT read
    // `X-Renewed-Token` here — the authoritative fresh token comes only from
    // `POST /refresh`. A NoAuthTokenError / GatewayHttpError propagates so callers
    // can trigger re-login.
    const fresh = await refresh();
    return doFetch(input, withBearer(init, fresh));
  };
}

export { NoAuthTokenError };
