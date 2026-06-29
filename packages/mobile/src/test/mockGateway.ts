/**
 * mockGateway — reusable HTTP mocking layer for the Portable gateway, the
 * foundation every `packages/mobile` integration test builds on.
 *
 * Why not `msw`? Under the `jest-expo` preset on top of a Bun monorepo, React
 * Native's `fetch` is polyfilled (whatwg-fetch over XHR) and does not route
 * through Node's `http` module, so `msw/node`'s network interceptors are
 * fragile to wire up reliably. The acceptance criteria explicitly allow an
 * "equivalent" — this module is that equivalent, and it interposes at the
 * `fetch` boundary in two complementary ways:
 *
 *   1. `gateway.fetchImpl` — an injectable `fetch` to hand to `GatewayClient`
 *      (or any other consumer that accepts a `fetchImpl`), matching the repo's
 *      dependency-injection testing pattern.
 *   2. `gateway.install()` / `gateway.restore()` — swap `global.fetch` so code
 *      that calls the global `fetch` directly (e.g. a future TanStack Query
 *      client) is intercepted too, the way `msw` would.
 *
 * Requests are routed by `METHOD relativePath` (the path after the gateway base
 * URL). Sensible typed defaults are registered for the eight
 * `/auth/mobile/react-native/*` routes — including the gateway's Bearer-only
 * auth contract — so most tests work with zero configuration; any route can be
 * overridden per-test via `on()` / `onRn()`. Every request is recorded on
 * `gateway.requests` for assertions.
 */

import type {
  MobileRnClerkExchangeResponse,
  MobileRnConfigResponse,
  MobileRnMeResponse,
  MobileRnRefreshResponse,
  MobileRnSandboxStatusResponse,
  MobileRnSandboxTerminateResponse,
  MobileRnScopeUpgradeUrlResponse,
} from '@vgit2/shared/types';

import { MOBILE_RN_BASE } from '../services/gatewayClient';

/** A request observed by the mock gateway (recorded on `gateway.requests`). */
export interface MockGatewayRequest {
  /** Fully-qualified URL the consumer requested. */
  url: string;
  /** Path relative to the gateway base URL (e.g. `/auth/mobile/react-native/config`). */
  path: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  /** Parsed JSON body (undefined for GET / no body / non-JSON). */
  body?: unknown;
  /** The raw `init.body` as passed to fetch (e.g. a `FormData` for multipart uploads). */
  rawBody?: unknown;
}

/** What a handler returns; defaults to `200` with an empty body. */
export interface MockGatewayResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A route handler — receives the recorded request, returns a response spec. */
export type MockGatewayHandler = (
  req: MockGatewayRequest
) => MockGatewayResponseSpec | Promise<MockGatewayResponseSpec>;

export interface MockGatewayOptions {
  /** Gateway base URL the client targets (no trailing slash). */
  baseUrl?: string;
  /** Register the typed defaults for the RN routes (default `true`). */
  withRnDefaults?: boolean;
}

export interface MockGateway {
  /** The gateway base URL this mock answers for. */
  readonly baseUrl: string;
  /** Injectable `fetch` to pass to `GatewayClient` (or any `fetchImpl` consumer). */
  readonly fetchImpl: typeof fetch;
  /** Every request observed since the last `reset()`. */
  readonly requests: MockGatewayRequest[];
  /** Register/override a handler keyed by method + base-relative path. */
  on(method: string, path: string, handler: MockGatewayHandler): MockGateway;
  /** Convenience: register a handler for an RN route (prefixes `MOBILE_RN_BASE`). */
  onRn(method: string, rnPath: string, handler: MockGatewayHandler): MockGateway;
  /** Swap `global.fetch` so direct global-fetch callers are intercepted too. */
  install(): void;
  /** Restore the original `global.fetch`. */
  restore(): void;
  /** Clear recorded requests (handlers are kept). */
  reset(): void;
}

const DEFAULT_BASE_URL = 'https://gateway.portable.test';

/** Minimal `Response`-like object: implements the surface consumers actually use. */
function makeResponse(spec: MockGatewayResponseSpec): Response {
  const status = spec.status ?? 200;
  const body = spec.body;
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Map(Object.entries(spec.headers ?? {})) as unknown as Headers,
    json: async () => body,
    text: async () => text,
    clone() {
      return makeResponse(spec);
    },
  } as unknown as Response;
}

function headersToObject(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  const maybeHeaders = init as unknown as Headers;
  if (typeof maybeHeaders.forEach === 'function') {
    maybeHeaders.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [key, value] of init) out[key] = value;
  } else {
    Object.assign(out, init as Record<string, string>);
  }
  return out;
}

function hasBearer(headers: Record<string, string>): boolean {
  const auth = headers.Authorization ?? headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice('Bearer '.length).length > 0;
}

/** The gateway's standard 401 for a missing/empty Bearer token. */
function unauthorized(): MockGatewayResponseSpec {
  return { status: 401, body: { error: 'Unauthorized' } };
}

/**
 * Create a configured mock gateway. By default it answers the eight RN routes
 * with representative typed payloads and enforces the Bearer-only contract.
 */
export function createMockGateway(options: MockGatewayOptions = {}): MockGateway {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const handlers = new Map<string, MockGatewayHandler>();
  const requests: MockGatewayRequest[] = [];

  const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

  const api: MockGateway = {
    baseUrl,
    requests,

    on(method, path, handler) {
      handlers.set(key(method, path), handler);
      return api;
    },

    onRn(method, rnPath, handler) {
      return api.on(method, `${MOBILE_RN_BASE}${rnPath}`, handler);
    },

    install() {
      if (originalFetch === undefined) originalFetch = globalThis.fetch;
      (globalThis as { fetch: typeof fetch }).fetch = api.fetchImpl;
    },

    restore() {
      if (originalFetch !== undefined) {
        (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        originalFetch = undefined;
      }
    },

    reset() {
      requests.length = 0;
    },

    // Assigned below (needs `requests`/`handlers` in scope).
    fetchImpl: undefined as unknown as typeof fetch,
  };

  let originalFetch: typeof fetch | undefined;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = headersToObject(init?.headers);
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) || '/' : url;

    const record: MockGatewayRequest = {
      url,
      path,
      method,
      headers,
      credentials: init?.credentials,
      body,
      rawBody: init?.body,
    };
    requests.push(record);

    const handler = handlers.get(key(method, path));
    if (!handler) {
      return makeResponse({
        status: 404,
        body: { error: `No mock handler for ${method} ${path}` },
      });
    }
    return makeResponse(await handler(record));
  }) as unknown as typeof fetch;

  (api as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;

  if (options.withRnDefaults ?? true) registerRnDefaults(api);

  return api;
}

/**
 * Register representative typed defaults for the eight RN gateway routes,
 * enforcing the Bearer-only auth contract on the protected ones. Exposed so a
 * test that opted out (`withRnDefaults: false`) can add them back selectively.
 */
export function registerRnDefaults(gateway: MockGateway): void {
  gateway
    .onRn('GET', '/config', (): MockGatewayResponseSpec => {
      const config: MobileRnConfigResponse = {
        gatewayUrl: gateway.baseUrl,
        environment: 'test',
        clerkPublishableKey: 'pk_test_mock',
      };
      return { body: config };
    })
    .onRn('POST', '/clerk-exchange', (req): MockGatewayResponseSpec => {
      const token = (req.body as { clerkSessionToken?: string } | undefined)?.clerkSessionToken;
      if (!token) return { status: 401, body: { error: 'Missing clerkSessionToken' } };
      const res: MobileRnClerkExchangeResponse = {
        authToken: 'mock-auth-token',
        userId: 'mock-user',
        username: 'mockuser',
        email: 'mock@portable.test',
      };
      return { body: res };
    })
    .onRn('POST', '/refresh', (req): MockGatewayResponseSpec => {
      if (!hasBearer(req.headers)) return unauthorized();
      const res: MobileRnRefreshResponse = { authToken: 'mock-refreshed-token' };
      return { body: res };
    })
    .onRn('POST', '/scope-upgrade-url', (req): MockGatewayResponseSpec => {
      if (!hasBearer(req.headers)) return unauthorized();
      const res: MobileRnScopeUpgradeUrlResponse = {
        url: 'https://github.com/login/oauth/authorize?mock=1',
      };
      return { body: res };
    })
    .onRn('GET', '/sandbox/status', (req): MockGatewayResponseSpec => {
      if (!hasBearer(req.headers)) return unauthorized();
      const res: MobileRnSandboxStatusResponse = {
        running: true,
        url: 'https://mock-sandbox.modal.run',
        sandboxId: 'sb_mock',
        state: 'running',
      };
      return { body: res };
    })
    .onRn('POST', '/sandbox/terminate', (req): MockGatewayResponseSpec => {
      if (!hasBearer(req.headers)) return unauthorized();
      const res: MobileRnSandboxTerminateResponse = {
        success: true,
        hadSandbox: true,
        sandboxId: 'sb_mock',
      };
      return { body: res };
    })
    .onRn('GET', '/me', (req): MockGatewayResponseSpec => {
      if (!hasBearer(req.headers)) return unauthorized();
      const res: MobileRnMeResponse = {
        id: 'mock-user',
        email: 'mock@portable.test',
        username: 'mockuser',
        created_at: '2026-01-01T00:00:00.000Z',
      };
      return { body: res };
    });
}
