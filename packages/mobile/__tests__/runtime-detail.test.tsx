/**
 * Runtime detail screens — tunnel / process.
 *
 * Asserts:
 *   1. Tunnel detail — Android embeds the dev-server URL via react-native-webview;
 *      iOS NEVER embeds (renders "Open in browser" + a header open button) →
 *      Apple App Store compliance. Not-found when the tunnel is gone.
 *   2. Process detail — renders the ANSI terminal output from the inline stdout;
 *      not-found when the process is gone.
 *   3. Tunnels list — iOS direct-open vs Android navigate-to-detail.
 */

jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string | number | boolean) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));
// Detail screens read route params + RuntimeHeader uses router.back — explicit
// props win, so params can be empty.
jest.mock('expo-router', () => ({
  __esModule: true,
  useLocalSearchParams: () => ({}),
  router: { back: jest.fn(), push: jest.fn() },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ProcessData, TunnelData } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  ProcessDetailScreen,
  TunnelDetailScreen,
  TunnelsListScreen,
  type WebViewLike,
} from '../src/features/runtime';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, AppStateStatus, NetInfoLike } from '../src/features/socket';
import { useRuntimeStore } from '../src/features/state/runtimeStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway, type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;
const secureStore = jest.requireMock('expo-secure-store') as { __store: Map<string, string> };

const SANDBOX_BASE = 'https://sandbox.portable.test';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const FakeWebView: ComponentType<WebViewLike> = ({ source, testID }) => (
  <Text testID={testID}>{source.uri}</Text>
);

const TUNNEL: TunnelData = {
  port: 3000,
  url: 'https://abc.trycloudflare.com',
  name: 'dev',
  createdAt: 1,
  active: true,
};
const PROCESS: ProcessData = {
  id: 'proc-1',
  command: 'bun run dev',
  status: 'running',
  description: 'dev server',
  startedAt: 1,
  chatId: 'chat-1',
  stdout: '\x1b[32mServer ready on :3000\x1b[0m',
};
function appStateCtl(): AppStateLike {
  return { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
}
function netInfoCtl(): NetInfoLike {
  return { addEventListener: () => () => {} };
}
function buildClient(gateway: MockGateway): RelayApiClient {
  const gw = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gw, fetchImpl: gateway.fetchImpl });
}

let gateway: MockGateway;
let queryClient: QueryClient | undefined;

function render_(node: React.ReactNode) {
  queryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ApiProvider client={buildClient(gateway)} queryClient={queryClient} netInfo={netInfoCtl()}>
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appStateCtl()}
          netInfo={netInfoCtl()}
        >
          {node}
        </SocketProvider>
      </ApiProvider>
    </SafeAreaProvider>
  );
}

async function flushSocket(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  secureStore.__store.clear();
  secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
  secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
  gateway = createMockGateway();
  onlineManager.setOnline(true);
});

afterEach(() => {
  act(() => {
    useSocketStore.getState().reset();
    useRuntimeStore.getState().reset();
  });
  controller.reset();
  queryClient?.clear();
  queryClient = undefined;
  onlineManager.setOnline(true);
});

describe('TunnelDetailScreen — Apple compliance', () => {
  it('Android embeds the tunnel URL via react-native-webview', async () => {
    act(() => useRuntimeStore.getState().setTunnels([TUNNEL]));
    render_(<TunnelDetailScreen port={3000} platform="android" WebViewComponent={FakeWebView} />);
    await flushSocket();

    const webview = screen.getByTestId('tunnel-webview');
    expect(webview).toHaveTextContent('https://abc.trycloudflare.com');
    expect(screen.queryByTestId('tunnel-open-external')).toBeNull();
    expect(screen.getByTestId('tunnel-detail-url')).toHaveTextContent('abc.trycloudflare.com');
  });

  it('iOS NEVER embeds — opens externally via the body button + header open', async () => {
    const openExternal = jest.fn();
    act(() => useRuntimeStore.getState().setTunnels([TUNNEL]));
    render_(<TunnelDetailScreen port={3000} platform="ios" openExternal={openExternal} />);
    await flushSocket();

    expect(screen.queryByTestId('tunnel-webview')).toBeNull();
    fireEvent.press(screen.getByTestId('tunnel-open-external'));
    expect(openExternal).toHaveBeenCalledWith('https://abc.trycloudflare.com');

    fireEvent.press(screen.getByTestId('tunnel-detail-open'));
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('shows a not-found state when the tunnel is gone', async () => {
    render_(<TunnelDetailScreen port={9999} platform="android" WebViewComponent={FakeWebView} />);
    await flushSocket();
    expect(screen.getByTestId('tunnel-detail-not-found')).toBeTruthy();
  });
});

describe('ProcessDetailScreen', () => {
  it('renders the ANSI terminal output + status from the inline stdout', async () => {
    act(() => useRuntimeStore.getState().setProcesses([PROCESS]));
    render_(<ProcessDetailScreen id="proc-1" />);
    await flushSocket();

    expect(screen.getByTestId('process-detail-status')).toHaveTextContent(/Running/);
    expect(screen.getByTestId('process-detail-command')).toHaveTextContent(/bun run dev/);
    expect(screen.getByTestId('process-output')).toHaveTextContent('Server ready on :3000');
    expect(screen.getByTestId('process-detail-live')).toBeTruthy();
  });

  it('shows a not-found state for an unknown process', async () => {
    render_(<ProcessDetailScreen id="nope" />);
    await flushSocket();
    expect(screen.getByTestId('process-detail-not-found')).toBeTruthy();
  });
});

describe('TunnelsListScreen — iOS direct open', () => {
  it('iOS: tapping a tunnel card opens the SYSTEM browser directly (no detail hop)', async () => {
    const openExternal = jest.fn();
    const navigate = jest.fn();
    act(() => useRuntimeStore.getState().setTunnels([TUNNEL]));
    render_(<TunnelsListScreen platform="ios" openExternal={openExternal} navigate={navigate} />);
    await flushSocket();

    fireEvent.press(screen.getByTestId('tunnel-open-3000'));
    expect(openExternal).toHaveBeenCalledWith('https://abc.trycloudflare.com');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Android: a tunnel-card tap navigates to the detail screen', async () => {
    const navigate = jest.fn();
    act(() => useRuntimeStore.getState().setTunnels([TUNNEL]));
    render_(<TunnelsListScreen platform="android" navigate={navigate} />);
    await flushSocket();

    fireEvent.press(screen.getByTestId('tunnel-open-3000'));
    expect(navigate).toHaveBeenCalledWith('/runtime/tunnel/3000');
  });
});
