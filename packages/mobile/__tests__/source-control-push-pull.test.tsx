/**
 * portable.dev#17 — Source Control push / pull header.
 *
 * Drives `PushPullHeader` through the authed TanStack Query layer with a mocked
 * sandbox HTTP layer (`createMockGateway`), an in-memory SecureStore (sandbox URL
 * + authToken), and an in-memory MMKV (the theme store via `useAppTheme`).
 * Verifies, per the AC:
 *
 *   1. the header surfaces the branch + ahead/behind from GET …/status;
 *   2. pressing Push POSTs to …/push and the invalidated status re-read refreshes
 *      ahead/behind (stateful mock-gateway handler);
 *   3. pressing Pull POSTs to …/pull;
 *   4. a push failure surfaces the error message clearly.
 *
 * The token is resolved + sent SERVER-SIDE (the route calls authService); the
 * client body is empty — there is nothing token-related to assert here (that is
 * the backend test's job).
 */

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

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { PushPullHeader } from '../src/features/repo';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const OWNER = 'octocat';
const REPO = 'hello-world';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

const statusUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/status`;
const pushUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/push`;
const pullUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/pull`;

function statusBody(ahead: number, behind: number) {
  return {
    branch: 'main',
    ahead,
    behind,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

describe('Source Control push / pull header', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(qc: QueryClient) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <PushPullHeader owner={OWNER} repo={REPO} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('surfaces the branch + ahead/behind from the status read', async () => {
    gateway.on('GET', statusUrl(), () => ({ body: statusBody(2, 1) }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-ahead').props.children).toBe(2));
    expect(screen.getByTestId('source-control-behind').props.children).toBe(1);
    expect(screen.getByTestId('source-control-branch').props.children).toBe('main');
  });

  it('pushes via POST …/push and refreshes ahead/behind on the invalidated re-read', async () => {
    // Stateful status: ahead=2 until a push lands, then 0.
    let pushed = false;
    gateway.on('GET', statusUrl(), () => ({ body: statusBody(pushed ? 0 : 2, 0) }));
    gateway.on('POST', pushUrl(), () => {
      pushed = true;
      return { body: { pushed: true, branch: 'main', ahead: 0, behind: 0 } };
    });

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-ahead').props.children).toBe(2));

    fireEvent.press(screen.getByTestId('source-control-push'));

    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === pushUrl());
      expect(post).toBeTruthy();
    });
    await waitFor(() => expect(screen.getByTestId('source-control-ahead').props.children).toBe(0));
  });

  it('pulls via POST …/pull', async () => {
    gateway.on('GET', statusUrl(), () => ({ body: statusBody(0, 3) }));
    gateway.on('POST', pullUrl(), () => ({
      body: { pulled: true, branch: 'main', ahead: 0, behind: 0 },
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-behind').props.children).toBe(3));

    fireEvent.press(screen.getByTestId('source-control-pull'));

    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === pullUrl());
      expect(post).toBeTruthy();
    });
  });

  it('surfaces a clear error when the push fails', async () => {
    gateway.on('GET', statusUrl(), () => ({ body: statusBody(1, 0) }));
    gateway.on('POST', pushUrl(), () => ({ status: 500, body: { error: 'remote rejected' } }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-ahead').props.children).toBe(1));

    fireEvent.press(screen.getByTestId('source-control-push'));

    await waitFor(() => expect(screen.getByTestId('source-control-push-pull-error')).toBeTruthy());
  });

  it('with a worktree selected the actions stay visible and push/pull POST the worktree in the body', async () => {
    const worktree = '/ws/hello-world/.worktrees/17';
    const scopedStatusUrl = `${statusUrl()}?worktree=${encodeURIComponent(worktree)}`;
    gateway.on('GET', scopedStatusUrl, () => ({
      body: { ...statusBody(1, 0), branch: 'feat/17-x' },
    }));
    gateway.on('POST', pushUrl(), () => ({
      body: { pushed: true, branch: 'feat/17-x', ahead: 0, behind: 0 },
    }));
    gateway.on('POST', pullUrl(), () => ({
      body: { pulled: true, branch: 'feat/17-x', ahead: 0, behind: 0 },
    }));

    const client = buildClient(gateway);
    const qc = newQueryClient();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <PushPullHeader owner={OWNER} repo={REPO} worktree={worktree} />
        </ApiProvider>
      </SafeAreaProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('feat/17-x')
    );

    fireEvent.press(screen.getByTestId('source-control-push'));
    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === pushUrl());
      expect(post).toBeTruthy();
      expect((post!.body as { worktree?: string }).worktree).toBe(worktree);
    });

    fireEvent.press(screen.getByTestId('source-control-pull'));
    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === pullUrl());
      expect(post).toBeTruthy();
      expect((post!.body as { worktree?: string }).worktree).toBe(worktree);
    });
  });

  it('blocks Push (disabled + warning, no POST) while the tree has conflicts — e.g. after a conflicting pull', async () => {
    gateway.on('GET', statusUrl(), () => ({
      body: {
        ...statusBody(1, 1),
        conflicted: [{ path: 'src/app.ts', status: 'conflicted', staged: false }],
      },
    }));
    gateway.on('POST', pushUrl(), () => ({
      body: { pushed: true, branch: 'main', ahead: 0, behind: 0 },
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-ahead').props.children).toBe(1));

    // The conflict warning is visible and Push is disabled.
    expect(screen.getByTestId('source-control-conflict-warning')).toBeTruthy();
    expect(screen.getByTestId('source-control-push').props.accessibilityState?.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('source-control-push'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      gateway.requests.find((r) => r.method === 'POST' && r.url === pushUrl())
    ).toBeUndefined();

    // Pull stays available (resolving usually means pulling/merging first is fine).
    expect(screen.getByTestId('source-control-pull')).toBeTruthy();
  });
});
