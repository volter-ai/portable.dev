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
import { createAuthedFetch, type AuthedFetch, NoAuthTokenError } from '../auth/authedFetch';
import { BaseUrlResolver, NoRelayUrlError } from './baseUrls';

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
  }

  /** Resolve a relative path to an absolute URL (passes absolute URLs through). */
  resolveUrl(path: string): Promise<string> {
    return this.baseUrls.resolveUrl(path);
  }

  private async request<T>(method: string, path: string, body?: RequestBody): Promise<T> {
    const url = await this.resolveUrl(path);

    const init: RequestInit = { method };
    if (body?.formData !== undefined) {
      // Multipart: leave Content-Type unset so RN appends the boundary.
      init.body = body.formData;
    } else if (body?.json !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body.json);
    }

    const res = await this.authedFetch(url, init);
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
