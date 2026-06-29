/**
 * `/auth/mobile/react-native/*` gateway routes (skeleton).
 *
 * The gateway HTTP layer is fully mocked (no real Express server). The mock
 * encodes the gateway contract:
 *   - protected routes require `Authorization: Bearer` (cookies are ignored),
 *   - `clerk-exchange` authenticates via the body, `provision-status` via the
 *     `authToken` query param,
 *   - `config` is public.
 *
 * Asserts that each of the eight routes responds with typed JSON, that
 * Bearer-header auth is honored while a cookie-only request is rejected (no
 * cookies accepted), and that an unauthenticated request is refused.
 */

import type {
  MobileRnAppleReviewerCredentialsResponse,
  MobileRnClerkExchangeResponse,
  MobileRnConfigResponse,
  MobileRnFirstPcConnectionResponse,
  MobileRnMeResponse,
  MobileRnRefreshResponse,
  MobileRnSandboxStatusResponse,
  MobileRnSandboxTerminateResponse,
  MobileRnScopeUpgradeUrlResponse,
} from '@vgit2/shared/types';

import { GatewayClient, GatewayHttpError, MOBILE_RN_BASE } from '../src/services/gatewayClient';

const GATEWAY_URL = 'https://gateway.example.test';

/** Minimal Response-like object (the client only uses ok/status/json). */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  body?: unknown;
}

/** Build a mocked fetch that enforces the gateway's Bearer-only contract. */
function makeMockGateway() {
  const calls: CapturedRequest[] = [];

  const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, credentials: init?.credentials, body });

    const path = url.slice(url.indexOf(MOBILE_RN_BASE) + MOBILE_RN_BASE.length);
    const hasBearer = (headers.Authorization ?? '').startsWith('Bearer ');

    // /config is public.
    if (path.startsWith('/config')) {
      return jsonResponse(200, {
        gatewayUrl: GATEWAY_URL,
        environment: 'staging',
        clerkPublishableKey: 'pk_test_123',
      } satisfies MobileRnConfigResponse);
    }

    // clerk-exchange authenticates via body, never cookies.
    if (path.startsWith('/clerk-exchange')) {
      if (!body?.clerkSessionToken)
        return jsonResponse(401, { error: 'Missing clerkSessionToken' });
      return jsonResponse(200, {
        authToken: 'auth.jwt.token',
        userId: 'user_42',
        username: 'octocat',
        email: 'octocat@example.com',
      } satisfies MobileRnClerkExchangeResponse);
    }

    // provision-status authenticates via the authToken query param.
    if (path.startsWith('/provision-status')) {
      if (!url.includes('authToken=')) return jsonResponse(401, { error: 'Missing authToken' });
      return jsonResponse(200, { ok: true });
    }

    // All remaining routes are Bearer-only.
    if (!hasBearer) return jsonResponse(401, { error: 'Bearer authorization required' });

    if (path.startsWith('/refresh')) {
      return jsonResponse(200, { authToken: 'fresh.jwt.token' } satisfies MobileRnRefreshResponse);
    }
    if (path.startsWith('/scope-upgrade-url')) {
      return jsonResponse(200, {
        url: `${GATEWAY_URL}/clerk-callback?returnTo=portable-rn%3A%2F%2Fscope&mobile=react-native`,
      } satisfies MobileRnScopeUpgradeUrlResponse);
    }
    if (path.startsWith('/sandbox/status')) {
      return jsonResponse(200, {
        running: true,
        url: 'https://sbx.modal.run',
        sandboxId: 'sb_1',
        state: 'running',
      } satisfies MobileRnSandboxStatusResponse);
    }
    if (path.startsWith('/sandbox/terminate')) {
      return jsonResponse(200, {
        success: true,
        hadSandbox: true,
        sandboxId: 'sb_1',
      } satisfies MobileRnSandboxTerminateResponse);
    }
    if (path.startsWith('/me')) {
      return jsonResponse(200, {
        id: 'user_42',
        email: 'octocat@example.com',
        username: 'octocat',
        created_at: '2026-01-01T00:00:00.000Z',
      } satisfies MobileRnMeResponse);
    }
    if (path.startsWith('/first-pc-connection')) {
      return jsonResponse(200, { ok: true } satisfies MobileRnFirstPcConnectionResponse);
    }
    if (path.startsWith('/apple-reviewer-credentials')) {
      // The non-reviewer 403 is exercised separately (a one-off fetch below).
      return jsonResponse(200, {
        gatewayBase: GATEWAY_URL,
        pcId: 'reviewer-pc',
        token: 'reviewer.jwt.token',
      } satisfies MobileRnAppleReviewerCredentialsResponse);
    }

    return jsonResponse(404, { error: 'Not found' });
  });

  return { fetchImpl, calls };
}

describe('/auth/mobile/react-native/* gateway routes', () => {
  let gateway: ReturnType<typeof makeMockGateway>;
  let client: GatewayClient;

  beforeEach(() => {
    gateway = makeMockGateway();
    client = new GatewayClient({ gatewayUrl: GATEWAY_URL, fetchImpl: gateway.fetchImpl });
  });

  describe('each of the eight routes responds with typed JSON', () => {
    it('1. POST /clerk-exchange returns the exchange contract', async () => {
      const res = await client.clerkExchange('clerk_session_abc');
      expect(res).toEqual({
        authToken: 'auth.jwt.token',
        userId: 'user_42',
        username: 'octocat',
        email: 'octocat@example.com',
      });
    });

    it('3. POST /refresh returns a fresh authToken', async () => {
      const res = await client.refreshAuthToken('auth.jwt.token');
      expect(res).toEqual({ authToken: 'fresh.jwt.token' });
    });

    it('4. POST /scope-upgrade-url returns a URL', async () => {
      const res = await client.getScopeUpgradeUrl('auth.jwt.token', 'portable-rn://scope');
      expect(typeof res.url).toBe('string');
      expect(res.url).toContain('/clerk-callback');
    });

    it('6. GET /me returns the user identity', async () => {
      const res = await client.getMe('auth.jwt.token');
      expect(res).toEqual({
        id: 'user_42',
        email: 'octocat@example.com',
        username: 'octocat',
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('7. GET /config returns env-specific config without secrets', async () => {
      const res = await client.getConfig();
      expect(res).toEqual({
        gatewayUrl: GATEWAY_URL,
        environment: 'staging',
        clerkPublishableKey: 'pk_test_123',
      });
    });

    it('8. POST /first-pc-connection reports the activation (Bearer + {pcId})', async () => {
      const res = await client.reportFirstPcConnection('auth.jwt.token', { pcId: 'pc_alpha' });
      expect(res).toEqual({ ok: true });
      const call = gateway.calls.find((c) => c.url.endsWith('/first-pc-connection'))!;
      expect(call.method).toBe('POST');
      expect(call.headers.Authorization).toBe('Bearer auth.jwt.token');
      expect(call.credentials).toBe('omit');
      expect(call.body).toEqual({ pcId: 'pc_alpha' });
    });

    it('9. POST /apple-reviewer-credentials returns the pairing triple on a match', async () => {
      const res = await client.getAppleReviewerCredentials('auth.jwt.token');
      expect(res).toEqual({
        gatewayBase: GATEWAY_URL,
        pcId: 'reviewer-pc',
        token: 'reviewer.jwt.token',
      });
      const call = gateway.calls.find((c) => c.url.endsWith('/apple-reviewer-credentials'))!;
      expect(call.method).toBe('POST');
      expect(call.headers.Authorization).toBe('Bearer auth.jwt.token');
      expect(call.credentials).toBe('omit');
    });

    it('9b. a non-reviewer gets a 403 → GatewayHttpError (the caller treats it as "not a reviewer")', async () => {
      const forbidden = new GatewayClient({
        gatewayUrl: GATEWAY_URL,
        fetchImpl: (async () =>
          jsonResponse(403, { error: 'Not a reviewer' })) as unknown as typeof fetch,
      });
      await expect(forbidden.getAppleReviewerCredentials('auth.jwt.token')).rejects.toBeInstanceOf(
        GatewayHttpError
      );
      await forbidden
        .getAppleReviewerCredentials('auth.jwt.token')
        .catch((e: GatewayHttpError) => expect(e.status).toBe(403));
    });
  });

  describe('Bearer-header auth is honored (no cookies ever sent)', () => {
    it('attaches Authorization: Bearer and omits credentials on protected routes', async () => {
      await client.getMe('auth.jwt.token');
      const call = gateway.calls.find((c) => c.url.endsWith('/me'))!;
      expect(call.headers.Authorization).toBe('Bearer auth.jwt.token');
      expect(call.credentials).toBe('omit');
    });

    it('never includes a Cookie header on any request', async () => {
      await client.clerkExchange('clerk_session_abc');
      await client.refreshAuthToken('auth.jwt.token');
      await client.getScopeUpgradeUrl('auth.jwt.token', 'portable-rn://scope');
      await client.getMe('auth.jwt.token');
      await client.getConfig();
      for (const call of gateway.calls) {
        expect(call.credentials).toBe('omit');
        const headerKeys = Object.keys(call.headers).map((k) => k.toLowerCase());
        expect(headerKeys).not.toContain('cookie');
      }
    });
  });

  describe('a cookie-only request is rejected (no cookies accepted)', () => {
    it('refuses a protected route presented with only a Cookie (no Bearer)', async () => {
      const res = await gateway.fetchImpl(client.url('/me'), {
        method: 'GET',
        headers: { Cookie: '__session=deadbeef' },
        credentials: 'include',
      });
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: 'Bearer authorization required' });
    });
  });

  describe('an unauthenticated request is refused', () => {
    it('rejects a Bearer-protected route called without a token', async () => {
      await expect(client.getMe('')).rejects.toBeInstanceOf(GatewayHttpError);
      await client.getMe('').catch((e: GatewayHttpError) => {
        expect(e.status).toBe(401);
      });
    });
  });
});
