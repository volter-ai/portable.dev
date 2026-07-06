/**
 * relayClient — the single authed HTTP surface for the per-user sandbox
 * backend.
 *
 * Every backend endpoint (`/api/*`) is reached through one `RelayApiClient`
 * that:
 *   1. resolves the ABSOLUTE sandbox base URL from SecureStore (the mutable
 *      per-user Sandbox base, written by provisioning — distinct from the fixed
 *      Gateway URL; see the dual base-URL model), and prefixes it to
 *      the relative path;
 *   2. attaches `Authorization: Bearer <authToken>` (cookies are NEVER sent —
 *      `credentials:'omit'`) via the reusable `createAuthedFetch` primitive
 *      which on a `401` refreshes the token against
 *      `POST /auth/mobile/react-native/refresh`, persists the renewed token, and
 *      replays the original request once with the new Bearer;
 *   3. parses JSON responses and surfaces non-2xx as a typed {@link ApiHttpError}.
 *
 * Multipart uploads (`/api/upload`, `/api/transcribe`) pass a React Native
 * `FormData` body straight through — the client deliberately does NOT set a
 * `Content-Type` header for those so the platform appends the correct multipart
 * boundary.
 *
 * It has no React/Expo coupling beyond SecureStore (injectable), so it is
 * trivially unit-testable with a mocked `fetch` + in-memory SecureStore.
 */

import type { GatewayClient } from '../../services/gatewayClient';
import { getConnectedPcId } from '../pc-connect/connectedPcStore';
import { getE2eKey } from '../pc-connect/deviceTokenStore';
import { createAuthedFetch, type AuthedFetch, NoAuthTokenError } from '../auth/authedFetch';
import { BaseUrlResolver, NoRelayUrlError } from './baseUrls';
import { createE2eFetch, type E2eFetch, type E2eResponseLike } from './e2eTransport';
import { getRelayUrl } from './relayUrlStore';

// `NoRelayUrlError` is now owned by the dual base-URL source-of-truth
// (`baseUrls.ts`); re-export it so existing importers keep working.
export { NoRelayUrlError };

/** Thrown when the sandbox responds with a non-2xx status (after any 401 refresh). */
export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Parsed error body, if any. */
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export interface RelayApiClientOptions {
  /** Gateway client used to drive the reactive `POST /refresh` on a 401. */
  gateway: GatewayClient;
  /** Resolve the mutable sandbox base URL (default: SecureStore `getRelayUrl`). */
  getRelayUrl?: () => Promise<string | null>;
  /** Underlying fetch (defaults to global `fetch`) — eases testing. */
  fetchImpl?: typeof fetch;
  /** Read the current `authToken` (default: SecureStore `getAuthToken`). */
  getToken?: () => Promise<string | null>;
  /** Persist a refreshed `authToken` (default: SecureStore `saveAuthToken`). */
  saveToken?: (token: string) => Promise<void>;
  /** Notified with the fresh token after a refresh / relay renewal (re-points the socket). */
  onTokenRefreshed?: (token: string) => void;
  /**
   * DEVICE-PATH renewal seam: persist the relay's `X-Renewed-Token`
   * data-path JWT (keyed by the connected pcId) and skip the legacy `/refresh`.
   */
  persistRenewedToken?: (token: string) => Promise<void>;
  /**
   * E2E full tunnel (portable.dev#13). Enable it (the production `ApiProvider`
   * passes `e2e: {}`) to seal every JSON `/api/*` request inside an AEAD
   * envelope POSTed to `POST /api/e2e`, so the relay never sees method/path/body.
   * Omitted → the bare authed transport (unit tests that assert raw plaintext;
   * a real PC REJECTS plaintext once Phase 5 enforcement lands, so production
   * MUST enable it). Provide the seams to inject test doubles.
   */
  e2e?: {
    getPcId?: () => Promise<string | null>;
    getE2eKey?: (pcId: string) => Promise<string | null>;
    getRelayBase?: () => Promise<string>;
  };
}

/** A multipart-capable request body. */
type RequestBody =
  | { json: unknown; formData?: never }
  | { json?: never; formData: FormData }
  | undefined;

/**
 * The authed HTTP client for the sandbox backend. One instance is created at the
 * app shell and shared via React context (`useApi()`), so the TanStack Query
 * fetchers and the upload mutations all go through the same Bearer/refresh path.
 */
export class RelayApiClient {
  private readonly authedFetch: AuthedFetch;
  private readonly baseUrls: BaseUrlResolver;
  /**
   * JSON transport: the E2E tunnel wrapping `authedFetch` (production), or the
   * bare `authedFetch` when E2E is disabled (`e2e: false`, some tests).
   */
  private readonly jsonFetch: E2eFetch | AuthedFetch;

  constructor(opts: RelayApiClientOptions) {
    // Route through the dual base-URL source-of-truth: `/api/*`
    // paths resolve against the MUTABLE Sandbox URL, read fresh from SecureStore
    // on every request so a recovery re-point is observed with no stale cache.
    this.baseUrls = new BaseUrlResolver({ getRelayUrl: opts.getRelayUrl });
    this.authedFetch = createAuthedFetch({
      gateway: opts.gateway,
      fetchImpl: opts.fetchImpl,
      getToken: opts.getToken,
      saveToken: opts.saveToken,
      onTokenRefreshed: opts.onTokenRefreshed,
      persistRenewedToken: opts.persistRenewedToken,
    });

    if (opts.e2e) {
      // E2E tunnel (portable.dev#13): the AEAD envelope rides `authedFetch`, so
      // the outer Bearer + X-Renewed-Token renewal keep working while the relay
      // sees only opaque ciphertext for the inner method/path/body.
      this.jsonFetch = createE2eFetch({
        outerFetch: this.authedFetch,
        getPcId: opts.e2e.getPcId ?? getConnectedPcId,
        getE2eKey: opts.e2e.getE2eKey ?? getE2eKey,
        getRelayBase: opts.e2e.getRelayBase ?? (async () => (await getRelayUrl()) ?? ''),
      });
    } else {
      // Tunnel not enabled — JSON goes straight over the authed transport.
      this.jsonFetch = this.authedFetch;
    }
  }

  /** Resolve a relative path to an absolute URL (passes absolute URLs through). */
  resolveUrl(path: string): Promise<string> {
    return this.baseUrls.resolveUrl(path);
  }

  private async request<T>(method: string, path: string, body?: RequestBody): Promise<T> {
    const url = await this.resolveUrl(path);

    const init: RequestInit = { method };
    // Multipart uploads (file bytes) currently ride the direct authed transport,
    // NOT the E2E tunnel — RN `FormData` isn't envelope-serializable. This is the
    // one content surface (alongside binary media DOWNLOAD, which native loaders
    // fetch) still visible to the relay; tracked as a follow-up in the issue.
    let res: E2eResponseLike | Response;
    if (body?.formData !== undefined) {
      // Multipart: leave Content-Type unset so RN appends the boundary.
      init.body = body.formData;
      res = await this.authedFetch(url, init);
    } else {
      if (body?.json !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body.json);
      }
      res = await this.jsonFetch(url, init);
    }
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      let parsed: unknown;
      try {
        const text = await res.text();
        if (text) {
          parsed = JSON.parse(text);
          const err = parsed as { error?: string; message?: string };
          if (err?.error) message = err.error;
          else if (err?.message) message = err.message;
        }
      } catch {
        /* non-JSON error body */
      }
      throw new ApiHttpError(res.status, message, parsed);
    }

    // 204 / empty body → undefined; otherwise parse JSON (works for both the RN
    // fetch and the test harness Response, which can return an empty text body).
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** GET a JSON resource. */
  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** POST JSON and parse the JSON response. */
  post<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>('POST', path, json === undefined ? undefined : { json });
  }

  /** PUT JSON and parse the JSON response. */
  put<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>('PUT', path, json === undefined ? undefined : { json });
  }

  /** PATCH JSON and parse the JSON response. */
  patch<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, json === undefined ? undefined : { json });
  }

  /** DELETE a resource. */
  del<T>(path: string, json?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, json === undefined ? undefined : { json });
  }

  /** Multipart upload (`/api/upload`, `/api/transcribe`) — RN `FormData` body. */
  upload<T>(path: string, formData: FormData): Promise<T> {
    return this.request<T>('POST', path, { formData });
  }
}

export { NoAuthTokenError };
