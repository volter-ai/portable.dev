/**
 * First-PC-connection activation report (D37/D38).
 *
 * On the FIRST successful `connectToPc → ready`, the app fires a Bearer-authed
 * `POST /auth/mobile/react-native/first-pc-connection` so the gateway marks the
 * user's activation signal. The report is one-shot-guarded per pcId by an MMKV flag
 * store and is fire-and-forget (best-effort). This proves the reporter:
 *
 *   - fires the gateway POST once, then no-ops for the SAME pcId (idempotent guard);
 *   - still reports a DIFFERENT pcId (the guard is keyed by pcId);
 *   - no-ops with no auth token (never an anonymous request);
 *   - leaves the guard UNSET on a gateway failure (so a later connect retries).
 *
 * MMKV backs the guard store and `react-native-mmkv` is mocked in-memory; the
 * gateway is interposed at the `fetch` boundary via `createMockGateway`.
 */

// In-memory MMKV (the guard store hydrates at module load).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k) ?? undefined,
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// `reportFirstPcConnection` statically imports `getAuthToken` (expo-secure-store).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { useFirstPcConnectionStore } from '../src/features/pc-connect/firstPcConnectionStore';
import { reportFirstPcConnection } from '../src/features/pc-connect/reportFirstPcConnection';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway } from '../src/test/mockGateway';

const GATEWAY = 'https://app.portable.dev';

beforeEach(() => {
  useFirstPcConnectionStore.getState().reset();
});

function gatewayFor(handler: Parameters<ReturnType<typeof createMockGateway>['onRn']>[2]) {
  const gw = createMockGateway({ baseUrl: GATEWAY });
  gw.onRn('POST', '/first-pc-connection', handler);
  return {
    gw,
    gateway: new GatewayClient({ gatewayUrl: GATEWAY, fetchImpl: gw.fetchImpl }),
  };
}

describe('reportFirstPcConnection (D37 — one-shot per pcId)', () => {
  it('fires the gateway POST once (Bearer + {pcId}, cookies omitted), then no-ops for the same pcId', async () => {
    const seen: Array<{ pcId: unknown; auth: string }> = [];
    const { gw, gateway } = gatewayFor((req) => {
      seen.push({
        pcId: (req.body as { pcId?: unknown }).pcId,
        auth: req.headers.Authorization ?? req.headers.authorization ?? '',
      });
      expect(req.credentials).toBe('omit');
      return { status: 200, body: { ok: true } };
    });

    const first = await reportFirstPcConnection('pc_alpha', {
      gateway,
      getToken: async () => 'tok',
    });
    expect(first).toBe(true);
    expect(seen).toEqual([{ pcId: 'pc_alpha', auth: 'Bearer tok' }]);
    expect(useFirstPcConnectionStore.getState().hasReported('pc_alpha')).toBe(true);

    // A healthy reconnect to the SAME PC must not re-fire the report.
    const second = await reportFirstPcConnection('pc_alpha', {
      gateway,
      getToken: async () => 'tok',
    });
    expect(second).toBe(false);
    expect(gw.requests.filter((r) => r.path.endsWith('/first-pc-connection'))).toHaveLength(1);
  });

  it('reports a DIFFERENT pcId even after one is already reported', async () => {
    let count = 0;
    const { gateway } = gatewayFor(() => {
      count += 1;
      return { status: 200, body: { ok: true } };
    });

    await reportFirstPcConnection('pc_alpha', { gateway, getToken: async () => 'tok' });
    await reportFirstPcConnection('pc_beta', { gateway, getToken: async () => 'tok' });

    expect(count).toBe(2);
    expect(useFirstPcConnectionStore.getState().hasReported('pc_alpha')).toBe(true);
    expect(useFirstPcConnectionStore.getState().hasReported('pc_beta')).toBe(true);
  });

  it('no-ops (no request, guard unset) when there is no auth token', async () => {
    let count = 0;
    const { gateway } = gatewayFor(() => {
      count += 1;
      return { status: 200, body: { ok: true } };
    });

    const res = await reportFirstPcConnection('pc_alpha', { gateway, getToken: async () => null });

    expect(res).toBe(false);
    expect(count).toBe(0);
    expect(useFirstPcConnectionStore.getState().hasReported('pc_alpha')).toBe(false);
  });

  it('leaves the guard UNSET on a gateway failure (so the next connect retries)', async () => {
    let count = 0;
    const { gateway } = gatewayFor(() => {
      count += 1;
      return { status: 500, body: { error: 'boom' } };
    });

    const res = await reportFirstPcConnection('pc_alpha', { gateway, getToken: async () => 'tok' });

    expect(res).toBe(false);
    expect(count).toBe(1);
    expect(useFirstPcConnectionStore.getState().hasReported('pc_alpha')).toBe(false);
  });
});
