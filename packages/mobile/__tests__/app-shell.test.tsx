/**
 * Root app shell: the local-first gate ladder.
 *
 * A router-level test (`renderRouter`) that drives the full {@link AppShell}
 * ladder (VersionGate → StartupGate → PcConnectGateHost → SandboxSessionBoundary →
 * StartupHealthGate → ApiProvider + SocketProvider → SessionReadyLayer) through the
 * boot states after the local-first pivot
 * (the unwrapped OnboardingGate + the gateway provisioning gate; the
 * PC-connect gate replaces them):
 *
 *   1. NO token              → StartupGate redirects to `/sign-in`.
 *   2. token + a connected PC → the authenticated children render (`index`
 *      marker), with the inner providers composed underneath.
 *   3. token + NO connected PC → the QR scanner shows; a scanned (valid) QR links a
 *      PC and flips the gate through to the authenticated children.
 *
 * Plus the death flows: a server-side session end (or guard exhaustion)
 * clears the legacy sandbox URL and remounts the subtree via the epoch bump — the
 * connected PC + device token are PRESERVED, so the ladder reconnects to the SAME
 * stable relay endpoint (no re-pick / no QR re-link); the terminal
 * ConnectionFailed screen REPLACES the subtree and "Try again" remounts.
 *
 * The real `@clerk/clerk-expo` import leaves async handles open and hangs Jest,
 * so it is mocked to a passthrough provider. Every gate's I/O is injected so the
 * ladder runs with mocked HTTP / socket / health / PC-connect and no native
 * modules.
 */

// ── Native-module mocks (hoisted above imports) ──────────────────────────────
jest.mock('@clerk/clerk-expo', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ getToken: async () => null }),
}));

jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) },
}));

// The PC-connect gate is SCAN-ONLY — the live camera (expo-camera) is
// device-only, so mock the lazily-loaded reader to expose its `onScan` to the test.
let mockPcScan: ((raw: string) => void) | undefined;
jest.mock('../src/features/pc-connect/QrCameraScanner', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ onScan }: { onScan: (raw: string) => void }) => {
      mockPcScan = onScan;
      return React.createElement(View, { testID: 'qr-camera' });
    },
  };
});

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useSegments, Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Text, View } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { onlineManager } from '@tanstack/react-query';
import { SERVER_EVENTS } from '@vgit2/shared/socket';

import { AppShell, type AppShellProps } from '../src/features/shell';
import { createQueryClient } from '../src/features/api';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { useConnectionFailedStore } from '../src/features/health/connectionFailedStore';
import { useSandboxSessionStore } from '../src/features/health/sandboxSessionStore';
import { useStartupHealthStore } from '../src/features/health/startupHealthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { useAuthStore } from '../src/features/state/authStore';
import { useSocketStore } from '../src/features/socket/socketStore';
import { useSystemWarningsStore } from '../src/features/socket/systemWarningsStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockSocket } from '../src/test';

import type { CreateSocketOptions, SocketLike } from '@vgit2/shared/socket';
import type { NetInfoLike, AppStateLike, AppStateStatus } from '../src/features/socket';
import type { PcConnectConfig } from '../src/features/pc-connect';
import type { MockSocketController } from '../src/test';
import type { QueryClient } from '@tanstack/react-query';

// In-memory SecureStore handle for seeding the auth token / sandbox URL.
const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SANDBOX_URL = 'https://sandbox.modal.run';
const CONNECTED_PC = 'pc-shell';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Inert NetInfo / AppState controllers (no real native lifecycle). */
const inertNetInfo: NetInfoLike = { addEventListener: () => () => {} };
const inertAppState: AppStateLike = {
  currentState: 'active' as AppStateStatus,
  addEventListener: () => ({ remove: () => {} }),
};

// Pin the startup checks (fresh-install marker + auth preflight) to their
// happy path: this suite covers the gate LADDER; the stale-credential behavior
// has its own suite (`stale-auth-cleanup.test.tsx`).
const STARTUP_OK = {
  isFreshInstall: () => false,
  preflight: async () => 'valid' as const,
};

// Pin the VersionGate (the outermost gate) to its happy path: a 0.0.0 minimum
// means any app version meets it → the gate resolves "ok" on the first attempt
// (no fetch, no retry timers).
const VERSION_OK: AppShellProps['version'] = { getMinimumVersion: async () => '0.0.0' };

let queryClient: QueryClient;

afterEach(() => {
  queryClient?.clear();
  onlineManager.setOnline(true);
  act(() => {
    useAuthStore.getState().reset();
    useSocketStore.getState().reset();
    useSystemWarningsStore.getState().reset();
    useConnectionFailedStore.setState({ visible: false, reason: 'pc-down' });
    useSandboxSessionStore.getState().reset();
    useStartupHealthStore.getState().reset();
  });
  secureStore.clear();
});

/** A PC-connect config whose device is ALREADY connected (gate passes through). */
function connectedPcConfig(): PcConnectConfig {
  return {
    getConnectedPcId: async () => CONNECTED_PC,
    onConnect: async () => true,
    onLink: async () => {},
  };
}

/** A complete, deterministic set of AppShell deps for the connected-PC ladder. */
function fullShellDeps(): Partial<AppShellProps> {
  queryClient = createQueryClient();
  return {
    startup: STARTUP_OK,
    pcConnect: connectedPcConfig(),
    health: { getRelayUrl: async () => SANDBOX_URL, runCheck: async () => {} },
    api: {
      client: new RelayApiClient({
        gateway: new GatewayClient({ gatewayUrl: 'https://gw.test' }),
      }),
      queryClient,
      netInfo: inertNetInfo,
    },
    socket: {
      getAuthToken: async () => 'jwt',
      getRelayUrl: async () => SANDBOX_URL,
      appState: inertAppState,
      netInfo: inertNetInfo,
    },
    recovery: {
      netInfo: inertNetInfo,
      healthMonitor: {
        // No PC URL for the steady-state monitor → no polling, no timers.
        getRelayUrl: async () => null,
        appState: inertAppState,
        netInfo: inertNetInfo,
      },
    },
  };
}

/** A recording socket factory so death/recovery flows can assert socket rebuilds. */
function recordingSocket() {
  const builds: { url: string; controller: MockSocketController }[] = [];
  const factory = (_token: string | null, url: string, _opts?: CreateSocketOptions): SocketLike => {
    const controller = createMockSocket({ connected: false });
    builds.push({ url, controller });
    return controller.socket;
  };
  return { builds, factory };
}

/** Build a renderRouter route map whose `_layout` mounts AppShell with `deps`. */
function routerWith(deps: Partial<AppShellProps>) {
  function Layout() {
    const segments = useSegments();
    const onPublic = segments[0] === 'sign-in';
    const stack = <Stack screenOptions={{ headerShown: false }} />;
    return (
      <SafeAreaProvider initialMetrics={METRICS}>
        {onPublic ? (
          stack
        ) : (
          <AppShell version={VERSION_OK} {...deps}>
            {stack}
          </AppShell>
        )}
      </SafeAreaProvider>
    );
  }
  return {
    _layout: Layout,
    index: () => (
      <View testID="index-marker">
        <Text>Home</Text>
      </View>
    ),
    'sign-in': () => (
      <View testID="sign-in-marker">
        <Text>Sign in</Text>
      </View>
    ),
  };
}

describe('AppShell gate ladder', () => {
  it('redirects to /sign-in when there is no token', async () => {
    // No persisted authToken → StartupGate resolves needs-sign-in → redirect.
    renderRouter(routerWith({}), { initialUrl: '/' });

    expect(await screen.findByTestId('sign-in-marker')).toBeTruthy();
  });

  it('renders the authenticated children when a PC is connected and the sandbox is healthy', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt');
    secureStore.set(RELAY_URL_KEY, SANDBOX_URL);

    renderRouter(routerWith(fullShellDeps()), { initialUrl: '/' });

    // PC connected → the picker is skipped → StartupHealthGate ready → providers
    // + recovery → children render.
    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-marker')).toBeNull();
    expect(screen.queryByTestId('pc-picker')).toBeNull();
  });

  it('shows the QR scanner when no PC is connected, and a scanned QR links then renders the app', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt');
    secureStore.set(RELAY_URL_KEY, SANDBOX_URL);

    const onConnect = jest.fn(async () => true);
    const onLink = jest.fn(async () => {});
    const pcConnect: PcConnectConfig = {
      // No PC connected yet → the QR scanner shows (QR-only).
      getConnectedPcId: async () => null,
      onConnect,
      onLink,
    };

    renderRouter(routerWith({ ...fullShellDeps(), pcConnect }), { initialUrl: '/' });

    // The connect landing is shown (NOT the camera); the app is NOT rendered yet.
    expect(await screen.findByTestId('pc-connect-landing')).toBeTruthy();
    expect(screen.queryByTestId('qr-camera')).toBeNull();
    expect(screen.queryByTestId('index-marker')).toBeNull();

    // Tap "Scan QR code" → the live camera opens.
    fireEvent.press(screen.getByTestId('pc-connect-landing-scan'));
    await screen.findByTestId('qr-camera');

    // Scan a valid pairing QR → onLink saves the JWT → onConnect connects → the gate
    // flips to the authenticated tree.
    const qr = JSON.stringify({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'pc-1',
      token: 'pc-minted-jwt',
    });
    act(() => mockPcScan!(qr));

    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    expect(onLink).toHaveBeenCalledWith({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'pc-1',
      token: 'pc-minted-jwt',
    });
    expect(onConnect).toHaveBeenCalledWith('pc-1');
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('a server-side session end clears the legacy URL and remounts the subtree, reconnecting', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt');
    secureStore.set(RELAY_URL_KEY, SANDBOX_URL);

    const { builds, factory } = recordingSocket();
    const deps = fullShellDeps();
    deps.socket = {
      ...deps.socket,
      getRelayUrl: async () => SANDBOX_URL,
      createSocketImpl: factory as unknown as typeof import('@vgit2/shared/socket').createSocket,
    };

    renderRouter(routerWith(deps), { initialUrl: '/' });

    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    await waitFor(() => expect(builds).toHaveLength(1));
    expect(builds[0].url).toBe(SANDBOX_URL);
    act(() => builds[0].controller.setConnected(true));
    expect(useSocketStore.getState().connected).toBe(true);

    // The sandbox session ends server-side → the SystemWarnings hand-off fires
    // the boundary's death handler: the legacy URL is CLEARED and the epoch bump
    // remounts the subtree (the connected PC + device token are preserved, so the
    // ladder reconnects to the SAME stable relay endpoint — no provisioning SSE).
    act(() => {
      builds[0].controller.emitServerEvent(SERVER_EVENTS.SESSION_EXPIRED, {
        reason: 'Idle for more than 5 minutes',
      });
    });

    // A fresh socket is built against the (same) stable base after the remount.
    await waitFor(() => expect(builds.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    expect(secureStore.has(RELAY_URL_KEY)).toBe(false);
    // The OLD socket was torn down by the unmount (io manager stopped).
    await waitFor(() => expect(builds[0].controller.socket.connected).toBe(false));
    // No overlay leak; the reprovisioning flag was cleared by the remount.
    expect(screen.queryByTestId('system-reprovisioning')).toBeNull();
    expect(useSandboxSessionStore.getState().reprovisioning).toBe(false);
  });

  it('the terminal ConnectionFailed screen replaces the subtree; "Try again" remounts the ladder', async () => {
    secureStore.set(AUTH_TOKEN_KEY, 'jwt');
    secureStore.set(RELAY_URL_KEY, SANDBOX_URL);

    const { builds, factory } = recordingSocket();
    const deps = fullShellDeps();
    deps.socket = {
      ...deps.socket,
      getRelayUrl: async () => SANDBOX_URL,
      createSocketImpl: factory as unknown as typeof import('@vgit2/shared/socket').createSocket,
    };

    renderRouter(routerWith(deps), { initialUrl: '/' });
    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    await waitFor(() => expect(builds).toHaveLength(1));
    act(() => builds[0].controller.setConnected(true));

    // The guard window exhausts → the boundary REPLACES the subtree with the
    // terminal screen. The dead socket unmounts with it (manager stopped).
    act(() => useConnectionFailedStore.getState().show('pc-down'));
    expect(await screen.findByTestId('connection-failed-screen')).toBeTruthy();
    expect(screen.queryByTestId('index-marker')).toBeNull();
    await waitFor(() => expect(builds[0].controller.socket.connected).toBe(false));

    // "Try again" → reset the window → clear the URL → epoch remount into the
    // authenticated ladder (reconnecting to the same stable endpoint).
    fireEvent.press(screen.getByTestId('connection-failed-try-again'));
    await waitFor(() => expect(screen.queryByTestId('connection-failed-screen')).toBeNull());
    expect(await screen.findByTestId('index-marker')).toBeTruthy();
    expect(secureStore.has(RELAY_URL_KEY)).toBe(false);
    await waitFor(() => expect(builds.length).toBeGreaterThanOrEqual(2));
  });
});
