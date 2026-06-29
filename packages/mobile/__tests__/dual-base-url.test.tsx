/**
 * Dual base-URL resolution (fixed Gateway + mutable Sandbox).
 *
 * Proves the single source-of-truth resolver (`BaseUrlResolver`) routes by path
 * to the correct backend and — critically — holds NO cached URL, so a sandbox
 * re-point (recovery) is observed immediately by BOTH the HTTP fetcher
 * (`RelayApiClient`) and a freshly-built Socket.IO client.
 *
 * The "mocked SecureStore holding a gateway URL and a sandbox URL" is the
 * in-memory `expo-secure-store` mock below: the resolver reads the Gateway URL
 * via an injected reader backed by the store and the Sandbox URL via the real
 * `getRelayUrl` (SecureStore). After `saveRelayUrl(newUrl)`, the very next
 * resolution returns the new URL with no invalidation step.
 */

// In-memory mock keychain for expo-secure-store (the only credential store).
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

// `useNativeSocket` imports the shared socket core, which imports
// `socket.io-client`; back it with the virtual mock so the real ESM transport is
// never loaded (the socket factory itself is injected per-test).
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { renderHook, waitFor } from '@testing-library/react-native';

import type { CreateSocketOptions, SocketLike } from '@vgit2/shared/socket';

import {
  BaseUrlResolver,
  GATEWAY_PATH_PREFIXES,
  targetForPath,
} from '../src/features/api/baseUrls';
import { RelayApiClient } from '../src/features/api/relayClient';
import { RELAY_URL_KEY, saveRelayUrl } from '../src/features/api/relayUrlStore';
import { useNativeSocket } from '../src/features/socket/useNativeSocket';
import type { AppStateLike, NetInfoLike } from '../src/features/socket/lifecycle';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockSocket } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}

const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

/** Test-only SecureStore key standing in for the fixed Gateway URL. */
const GATEWAY_URL_KEY = 'portable.gatewayUrl.test';
const GATEWAY_BASE = 'https://gateway.portable.test';
const SANDBOX_BASE = 'https://sandbox-a.portable.test';
const SANDBOX_BASE_2 = 'https://sandbox-b.portable.test';

/** A resolver whose BOTH base URLs are backed by the mocked SecureStore. */
function makeResolver(): BaseUrlResolver {
  return new BaseUrlResolver({
    getGatewayUrl: () => secureStore.__store.get(GATEWAY_URL_KEY) ?? '',
    getRelayUrl: async () => secureStore.__store.get(RELAY_URL_KEY) ?? null,
  });
}

/** A no-op AppState that registers a listener but never fires. */
const staticAppState: AppStateLike = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};

/** A no-op NetInfo that registers a listener but never fires. */
const staticNetInfo: NetInfoLike = {
  addEventListener: () => () => {},
};

beforeEach(() => {
  secureStore.__store.clear();
  secureStore.__store.set(GATEWAY_URL_KEY, GATEWAY_BASE);
  secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
});

describe('routing table — everything routes to the per-PC relay', () => {
  it('routes ALL relative paths to the Sandbox (relay) — the gateway prefix set is empty', () => {
    // Local-first: there is no relative gateway path anymore (provisioning is
    // gone; discovery/link use GatewayClient absolute URLs).
    expect(targetForPath('/api/chats')).toBe('sandbox');
    expect(targetForPath('/api/repos')).toBe('sandbox');
    expect(targetForPath('api/user')).toBe('sandbox'); // leading slash optional
    expect(targetForPath('/socket.io')).toBe('sandbox');
    // The pre-pivot provisioning prefixes no longer route to the gateway.
    expect(targetForPath('/auth/mobile/react-native/config')).toBe('sandbox');
    expect(targetForPath('/redis/progress/user-123')).toBe('sandbox');
    // The allow-list is now empty.
    expect(GATEWAY_PATH_PREFIXES).toEqual([]);
  });
});

describe('dual base-URL resolver', () => {
  it('resolves a /api/* chat fetch to the Sandbox (relay) base', async () => {
    const resolver = makeResolver();

    await expect(resolver.resolveUrl('/api/chats')).resolves.toBe(`${SANDBOX_BASE}/api/chats`);
    // The base used is read from the sandbox source (the per-PC relay base).
    expect(await resolver.baseUrlForPath('/api/chats')).toBe(SANDBOX_BASE);
    expect(await resolver.baseUrlForPath('/socket.io')).toBe(SANDBOX_BASE);
  });

  it('observes a new sandbox URL on the next resolution — no stale cached URL', async () => {
    const resolver = makeResolver();
    expect(await resolver.baseUrlForPath('/api/chats')).toBe(SANDBOX_BASE);

    // A re-point updates the sandbox base.
    await saveRelayUrl(SANDBOX_BASE_2);

    // Same resolver instance — proves nothing is cached.
    await expect(resolver.resolveUrl('/api/chats')).resolves.toBe(`${SANDBOX_BASE_2}/api/chats`);
  });

  it('re-points the RelayApiClient fetcher AND a fresh Socket.IO client after recovery', async () => {
    // The HTTP fetcher (defaults its sandbox reader to SecureStore `getRelayUrl`).
    const gateway = new GatewayClient({ gatewayUrl: GATEWAY_BASE });
    const fetcher = new RelayApiClient({ gateway });
    expect(await fetcher.resolveUrl('/api/chats')).toBe(`${SANDBOX_BASE}/api/chats`);

    // Recovery writes a new sandbox URL.
    await saveRelayUrl(SANDBOX_BASE_2);

    // The fetcher reads the updated value with no stale cache.
    expect(await fetcher.resolveUrl('/api/chats')).toBe(`${SANDBOX_BASE_2}/api/chats`);

    // A FRESH Socket.IO client (new mount) is built against the updated URL.
    const built: { token: string | null; url: string }[] = [];
    const recordingFactory = (
      token: string | null,
      url: string,
      _opts?: CreateSocketOptions
    ): SocketLike => {
      built.push({ token, url });
      return createMockSocket().socket;
    };

    const { unmount } = renderHook(() =>
      useNativeSocket({
        getAuthToken: async () => 'tok',
        getRelayUrl: async () => secureStore.__store.get(RELAY_URL_KEY) ?? null,
        createSocketImpl:
          recordingFactory as unknown as typeof import('@vgit2/shared/socket').createSocket,
        appState: staticAppState,
        netInfo: staticNetInfo,
      })
    );

    await waitFor(() => expect(built).toHaveLength(1));
    expect(built[0]?.url).toBe(SANDBOX_BASE_2);
    unmount();
  });
});
