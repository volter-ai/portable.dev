/**
 * Regression: the Socket.IO handshake must be addressed through the PC relay
 * (`<gatewayBase>/t/<pcId>/socket.io`), NOT the gateway root (`<gatewayBase>/socket.io`).
 *
 * In local-first mode `getRelayUrl()` returns the path-PREFIXED relay base
 * `<gatewayBase>/t/<pcId>`. socket.io-client treats a URL's pathname as the
 * connection NAMESPACE and keeps the engine.io path on the `path` option, so
 * passing the prefixed URL straight to `io()` sent the handshake to
 * `<gatewayBase>/socket.io` (which the relay does not route to the PC) on
 * namespace `/t/<pcId>` (which the PC rejects) — the socket never connected.
 * `relaySocketTarget` + `buildSocket` move the `/t/<pcId>` prefix into the
 * engine.io `path` and connect to the origin, so the handshake reaches the PC.
 */

// In-memory mock keychain (module-scope reads by the socket import graph).
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

import { relaySocketTarget } from '../src/features/socket/relaySocketTarget';
import { useNativeSocket } from '../src/features/socket/useNativeSocket';
import type { AppStateLike, NetInfoLike } from '../src/features/socket/lifecycle';
import { createMockSocket } from '../src/test';

const staticAppState: AppStateLike = { addEventListener: () => ({ remove: () => {} }) };
const staticNetInfo: NetInfoLike = { addEventListener: () => () => {} };

describe('relaySocketTarget()', () => {
  it('splits the relay base into the gateway origin + the prefixed socket.io path', () => {
    expect(relaySocketTarget('https://app.portable.dev/t/pc-123')).toEqual({
      origin: 'https://app.portable.dev',
      path: '/t/pc-123/socket.io',
    });
  });

  it('keeps a percent-encoded pcId encoded (the gateway decodes it)', () => {
    expect(relaySocketTarget('https://app.portable.dev/t/pc%40host')).toEqual({
      origin: 'https://app.portable.dev',
      path: '/t/pc%40host/socket.io',
    });
  });

  it('honours an explicit port', () => {
    expect(relaySocketTarget('http://localhost:3501/t/dev-pc')).toEqual({
      origin: 'http://localhost:3501',
      path: '/t/dev-pc/socket.io',
    });
  });

  it('tolerates a trailing slash on the relay base', () => {
    expect(relaySocketTarget('https://app.portable.dev/t/pc-123/')).toEqual({
      origin: 'https://app.portable.dev',
      path: '/t/pc-123/socket.io',
    });
  });
});

describe('useNativeSocket — relay handshake addressing', () => {
  it('builds the socket against the gateway origin with the /t/<pcId>/socket.io path', async () => {
    const built: { url: string; opts?: CreateSocketOptions }[] = [];
    const recordingFactory = (
      _token: string | null,
      url: string,
      opts?: CreateSocketOptions
    ): SocketLike => {
      built.push({ url, opts });
      return createMockSocket().socket;
    };

    const { unmount } = renderHook(() =>
      useNativeSocket({
        getAuthToken: async () => 'jwt',
        getRelayUrl: async () => 'https://app.portable.dev/t/pc-123',
        createSocketImpl:
          recordingFactory as unknown as typeof import('@vgit2/shared/socket').createSocket,
        appState: staticAppState,
        netInfo: staticNetInfo,
        getAppVersion: () => '1.5.0',
        // No device on this synthetic mount → deviceName omitted (jest-expo's
        // expo-device auto-mock otherwise reports "mock mock"); this test asserts the
        // relay addressing + the token/appVersion auth, not the device label.
        getDeviceName: () => undefined,
      })
    );

    await waitFor(() => expect(built).toHaveLength(1));
    // Origin only → namespace stays '/'; the relay prefix lives in `path`.
    expect(built[0].url).toBe('https://app.portable.dev');
    expect(built[0].opts?.path).toBe('/t/pc-123/socket.io');
    expect(built[0].opts?.auth).toEqual({ token: 'jwt', appVersion: '1.5.0' });
    unmount();
  });
});
