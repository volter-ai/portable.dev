/**
 * rev6 QR pairing — save the QR's data-path JWT, then connect.
 *
 * Covers the link/connect client surface (the relay is mocked at the boundary):
 *
 *   - linkPc: SAVE-ONLY — persists the QR's data-path JWT keyed by `pcId` with NO
 *     gateway round-trip (no `/link-pc`, no Clerk session token, no device-token
 *     mint — D16/D19).
 *   - verifyTunnelAddress: (1) body-validates `GET /api/health` through the relay —
 *     true ONLY for 2xx + JSON `{ status: 'ok' }`; a 200-HTML zombie / non-2xx /
 *     network error → false (the 200+HTML discrimination is the app's job). Then
 *     (2) probes the AUTHED `GET /api/user-settings` — a `401`/`403` means the PC
 *     rejected the token (fail-fast, e.g. a JWT_SECRET mismatch) → false; any other
 *     authed outcome (non-401) never blocks a valid token (liveness already passed).
 *   - connectToPc: no stored token → `no-token`; token + healthy → ready; token +
 *     unhealthy → `unhealthy`.
 *
 * Imports from the FILES (not the pc-connect barrel) so the themed scanner graph
 * (useAppTheme → themeStore → MMKV) never loads — only expo-secure-store needs a
 * mock.
 */

// In-memory keychain for deviceTokenStore (expo-secure-store).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

import { createMockGateway } from '../src/test/mockGateway';
import { connectToPc } from '../src/features/pc-connect/connectToPc';
import {
  clearDeviceToken,
  getDeviceToken,
  saveDeviceToken,
} from '../src/features/pc-connect/deviceTokenStore';
import { linkPc } from '../src/features/pc-connect/linkPc';
import {
  relayAuthCheckUrl,
  relayHealthUrl,
  verifyTunnelAddress,
} from '../src/features/pc-connect/verifyTunnelAddress';

const GATEWAY = 'https://app.portable.dev';

const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

afterEach(() => {
  secureStore.__store.clear();
});

describe('linkPc (save-only — rev6)', () => {
  it('persists the QR data-path JWT keyed by pcId via the injected save seam', async () => {
    const saveToken = jest.fn().mockResolvedValue(undefined);

    const result = await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        deviceLabel: "Bruno's iPhone",
      },
      { saveToken }
    );

    expect(saveToken).toHaveBeenCalledWith('pc_charlie', 'pc-minted-jwt');
    expect(result.pcId).toBe('pc_charlie');
  });

  it('default seam writes the JWT to SecureStore (no gateway round-trip)', async () => {
    const result = await linkPc({
      gatewayBase: GATEWAY,
      pcId: 'pc_charlie',
      token: 'pc-minted-jwt',
    });

    expect(result.pcId).toBe('pc_charlie');
    expect(await getDeviceToken('pc_charlie')).toBe('pc-minted-jwt');
  });

  it('persists the QR e2eKey beside the JWT (portable.dev#13)', async () => {
    const saveToken = jest.fn().mockResolvedValue(undefined);
    const saveE2eKey = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      {
        gatewayBase: GATEWAY,
        pcId: 'pc_charlie',
        token: 'pc-minted-jwt',
        e2eKey: 'psk-base64',
      },
      { saveToken, saveE2eKey }
    );

    expect(saveE2eKey).toHaveBeenCalledWith('pc_charlie', 'psk-base64');
  });

  it('skips the e2eKey save when the input has none (Apple-reviewer path)', async () => {
    const saveE2eKey = jest.fn().mockResolvedValue(undefined);

    await linkPc(
      { gatewayBase: GATEWAY, pcId: 'pc_charlie', token: 'pc-minted-jwt' },
      { saveE2eKey }
    );

    expect(saveE2eKey).not.toHaveBeenCalled();
  });
});

describe('verifyTunnelAddress', () => {
  /** Register a live PC: `/api/health` ok + `/api/user-settings` accepts the token. */
  function registerLivePc(gateway: ReturnType<typeof createMockGateway>, pcId: string) {
    gateway.on('GET', `/t/${pcId}/api/health`, (req) => {
      expect(req.headers.Authorization ?? req.headers.authorization).toBe('Bearer dt');
      expect(req.credentials).toBe('omit');
      return { status: 200, body: { status: 'ok' } };
    });
    gateway.on('GET', `/t/${pcId}/api/user-settings`, (req) => {
      expect(req.headers.Authorization ?? req.headers.authorization).toBe('Bearer dt');
      expect(req.credentials).toBe('omit');
      return { status: 200, body: { settings: {} } };
    });
  }

  it('returns true when health is { status: "ok" } AND the authed probe is accepted', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    registerLivePc(gateway, 'pc_alpha');

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(true);

    // Both probes ran, health first.
    const gets = gateway.requests.filter((r) => r.method === 'GET');
    expect(gets[0]?.url).toBe(relayHealthUrl(GATEWAY, 'pc_alpha'));
    expect(gets.some((r) => r.url === relayAuthCheckUrl(GATEWAY, 'pc_alpha'))).toBe(true);
  });

  it('rejects (fail-fast) when the PC 401s the token even though health is live', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({ status: 200, body: { status: 'ok' } }));
    // The PC's jwtMiddleware rejects a JWT_SECRET-mismatched token → 401.
    gateway.on('GET', '/t/pc_alpha/api/user-settings', () => ({
      status: 401,
      body: { error: 'Unauthorized' },
    }));

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
  });

  it('does NOT fail a valid token on a flaky authed probe (non-401 → still ready)', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({ status: 200, body: { status: 'ok' } }));
    gateway.on('GET', '/t/pc_alpha/api/user-settings', () => ({
      status: 500,
      body: { error: 'transient' },
    }));

    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(true);
  });

  it('rejects a 200-HTML zombie edge page (no { status: "ok" } body) — no authed probe', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({
      status: 200,
      body: '<html>dead tunnel</html>',
    }));
    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
    // Health failed → the authed probe is never sent.
    expect(gateway.requests.some((r) => r.url === relayAuthCheckUrl(GATEWAY, 'pc_alpha'))).toBe(
      false
    );
  });

  it('rejects a non-2xx health response', async () => {
    const gateway = createMockGateway({ baseUrl: GATEWAY });
    gateway.on('GET', '/t/pc_alpha/api/health', () => ({
      status: 503,
      body: { error: 'offline' },
    }));
    await expect(
      verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl: gateway.fetchImpl })
    ).resolves.toBe(false);
  });

  it('returns false (never throws) on a network error', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await expect(verifyTunnelAddress(GATEWAY, 'pc_alpha', 'dt', { fetchImpl })).resolves.toBe(
      false
    );
  });
});

describe('connectToPc', () => {
  it('returns no-token when this device never linked the PC (no first-connection report)', async () => {
    await clearDeviceToken('pc_alpha');
    const verify = jest.fn();
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: false, deviceToken: null, reason: 'no-token' });
    expect(verify).not.toHaveBeenCalled();
    expect(reportFirstConnection).not.toHaveBeenCalled();
  });

  it('connects straight (ready) when a stored token health-validates AND reports the first connection once', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const verify = jest.fn().mockResolvedValue(true);
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(verify).toHaveBeenCalledWith(GATEWAY, 'pc_alpha', 'stored-dt');
    expect(result).toEqual({ ready: true, deviceToken: 'stored-dt' });
    // Fire-and-forget activation report (D37) fired EXACTLY once with the pcId.
    expect(reportFirstConnection).toHaveBeenCalledTimes(1);
    expect(reportFirstConnection).toHaveBeenCalledWith('pc_alpha');
  });

  it('still returns ready even if the first-connection report throws (never blocks the connect)', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const reportFirstConnection = jest.fn(() => {
      throw new Error('report boom');
    });
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify: async () => true,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: true, deviceToken: 'stored-dt' });
    expect(reportFirstConnection).toHaveBeenCalledTimes(1);
  });

  it('reports unhealthy when the stored token fails the health probe (no first-connection report)', async () => {
    await saveDeviceToken('pc_alpha', 'stored-dt');
    const verify = jest.fn().mockResolvedValue(false);
    const reportFirstConnection = jest.fn();
    const result = await connectToPc('pc_alpha', {
      gatewayBase: GATEWAY,
      verify,
      reportFirstConnection,
    });
    expect(result).toEqual({ ready: false, deviceToken: 'stored-dt', reason: 'unhealthy' });
    expect(reportFirstConnection).not.toHaveBeenCalled();
  });
});
