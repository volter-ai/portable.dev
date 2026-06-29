/**
 * Stable per-PC connect + gateway-owned reconnection.
 *
 * Proves the local-first base-URL model: the app talks to ONE stable endpoint
 * per chosen PC, `<gatewayBase>/t/<pcId>`, derived from the connected PC id (NOT a
 * rotating sandbox URL). Because the base never changes from the app's POV, a
 * transport drop reconnects to the SAME endpoint — the gateway re-points by `pcId`
 * with no re-resolve and no QR re-link. A confirmed re-provision
 * PRESERVES the connected PC + its device token, so it too reconnects rather than
 * re-links. Switching PCs = `connectToPc(otherPcId)`.
 *
 * Imports the FILES (not the pc-connect barrel) so only the in-memory
 * `expo-secure-store` mock is needed; `getGatewayUrl()` degrades to the prod
 * default under jest (dev-mode MMKV is lazy + try/catch'd).
 */

// In-memory mock keychain for expo-secure-store (the connected-pc + device-token
// + legacy-sandbox-url store).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

// `sandboxSessionStore` lazy-requires `authStore` (→ state/storage → MMKV) on
// `requestReprovision`; back it with the documented in-memory mock.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

import { getGatewayUrl } from '../src/features/auth/gatewayConfig';
import {
  CONNECTED_PC_KEY,
  clearConnectedPcId,
  getConnectedPcId,
  relayBaseForPc,
  saveConnectedPcId,
} from '../src/features/pc-connect/connectedPcStore';
import { connectToPc } from '../src/features/pc-connect/connectToPc';
import { useSandboxSessionStore } from '../src/features/health/sandboxSessionStore';
import { RELAY_URL_KEY, getRelayUrl, saveRelayUrl } from '../src/features/api/relayUrlStore';

interface SecureStoreMock {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const PC = 'pc_alpha';
const DEVICE_TOKEN = 'dev-token-alpha';

beforeEach(() => {
  secureStore.__store.clear();
  useSandboxSessionStore.getState().reset();
});

describe('relayBaseForPc — stable per-PC endpoint', () => {
  it('builds <gatewayBase>/t/<pcId> (trailing slash trimmed, pcId encoded)', () => {
    expect(relayBaseForPc('https://app.portable.dev', 'pc_alpha')).toBe(
      'https://app.portable.dev/t/pc_alpha'
    );
    // A trailing slash on the gateway base is normalized.
    expect(relayBaseForPc('https://app.portable.dev/', 'pc_alpha')).toBe(
      'https://app.portable.dev/t/pc_alpha'
    );
    // An exotic id is path-safe.
    expect(relayBaseForPc('https://g.test', 'pc a/b')).toBe('https://g.test/t/pc%20a%2Fb');
  });
});

describe('getRelayUrl — derives the stable per-PC base', () => {
  it('returns <gatewayBase>/t/<pcId> once a PC is connected', async () => {
    await saveConnectedPcId(PC);
    const expected = relayBaseForPc(getGatewayUrl(), PC);
    expect(await getRelayUrl()).toBe(expected);
    expect(expected).toContain(`/t/${PC}`);
  });

  it('the connected PC wins over a stale legacy sandbox URL', async () => {
    await saveRelayUrl('https://old-sandbox.modal.run');
    await saveConnectedPcId(PC);
    expect(await getRelayUrl()).toBe(relayBaseForPc(getGatewayUrl(), PC));
  });

  it('falls back to the legacy sandbox URL when no PC is connected', async () => {
    await saveRelayUrl('https://old-sandbox.modal.run');
    expect(await getRelayUrl()).toBe('https://old-sandbox.modal.run');
  });

  it('is null when neither a connected PC nor a legacy URL exists', async () => {
    expect(await getRelayUrl()).toBeNull();
  });
});

describe('rotation = silent reconnect — the app never sees a rotating URL', () => {
  it('resolves the SAME stable base on every read regardless of the PC tunnel rotating', async () => {
    await saveConnectedPcId(PC);
    const first = await getRelayUrl();
    // The PC's underlying cloudflared tunnel rotated server-side (the gateway
    // re-points by pcId). The app holds no rotating URL, so its base is unchanged.
    const second = await getRelayUrl();
    const third = await getRelayUrl();
    expect(first).toBe(relayBaseForPc(getGatewayUrl(), PC));
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe('connectToPc — points the app at the PC on ready', () => {
  it('persists the connected pcId on a healthy connect (→ getRelayUrl resolves to it)', async () => {
    await saveConnectedPcId('pc_other'); // app currently on another PC
    const res = await connectToPc(PC, {
      gatewayBase: 'https://g.test',
      getToken: async () => DEVICE_TOKEN,
      verify: async () => true,
    });
    expect(res).toEqual({ ready: true, deviceToken: DEVICE_TOKEN });
    // The app is now pointed at PC — switching PCs = pick another from the list.
    expect(await getConnectedPcId()).toBe(PC);
    expect(await getRelayUrl()).toBe(relayBaseForPc(getGatewayUrl(), PC));
  });

  it('does NOT point the app at an unhealthy PC (re-pick, not auto re-link)', async () => {
    await saveConnectedPcId('pc_other');
    const res = await connectToPc(PC, {
      gatewayBase: 'https://g.test',
      getToken: async () => DEVICE_TOKEN,
      verify: async () => false,
    });
    expect(res).toEqual({ ready: false, deviceToken: DEVICE_TOKEN, reason: 'unhealthy' });
    // The connected PC is untouched (no silent switch to a dead PC).
    expect(await getConnectedPcId()).toBe('pc_other');
  });

  it('reports no-token (→ QR scanner) without persisting a connected PC', async () => {
    const res = await connectToPc(PC, {
      gatewayBase: 'https://g.test',
      getToken: async () => null,
      verify: async () => true,
    });
    expect(res).toEqual({ ready: false, deviceToken: null, reason: 'no-token' });
    expect(await getConnectedPcId()).toBeNull();
  });
});

describe('requestReprovision — reconnect, not re-link (device token + PC preserved)', () => {
  it('PRESERVES the connected PC + its device token across a re-provision', async () => {
    await saveConnectedPcId(PC);
    // A device token for the PC (the relay data-path credential, kept on re-provision).
    secureStore.__store.set('portable.deviceToken.pc_alpha', DEVICE_TOKEN);
    const before = useSandboxSessionStore.getState().epoch;

    await useSandboxSessionStore.getState().requestReprovision();

    // The epoch bumped (the subtree remounts), but the stable base survives →
    // the remounted gate reconnects to the SAME endpoint, no QR re-link.
    expect(useSandboxSessionStore.getState().epoch).toBe(before + 1);
    expect(await getConnectedPcId()).toBe(PC);
    expect(secureStore.__store.get('portable.deviceToken.pc_alpha')).toBe(DEVICE_TOKEN);
    expect(await getRelayUrl()).toBe(relayBaseForPc(getGatewayUrl(), PC));
  });

  it('clears only the LEGACY sandbox URL (the connected PC is unaffected)', async () => {
    await saveConnectedPcId(PC);
    await saveRelayUrl('https://old-sandbox.modal.run');

    await useSandboxSessionStore.getState().requestReprovision();

    expect(secureStore.__store.has(RELAY_URL_KEY)).toBe(false);
    expect(secureStore.__store.get(CONNECTED_PC_KEY)).toBe(PC);
  });
});

describe('clearConnectedPcId — explicit re-pick / sign-out', () => {
  it('forgets the connected PC so getRelayUrl falls back', async () => {
    await saveConnectedPcId(PC);
    await clearConnectedPcId();
    expect(await getConnectedPcId()).toBeNull();
    expect(await getRelayUrl()).toBeNull();
  });
});
