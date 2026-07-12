/**
 * portable.dev#17 — source-control focus refresh.
 *
 * `useSourceControlFocusRefresh` re-kicks the ACTIVE source-control queries
 * whenever the repo route REGAINS focus (returning from the pushed diff /
 * commit-detail screens, which keep the repo page mounted underneath — no
 * remount, so `staleTime: 0` alone can't cover it). The hook lives at the
 * ROUTE SHELL, so this suite mounts a probe route via `renderRouter` (the
 * tasks-page precedent — `useFocusEffect` needs a real navigation context):
 *
 *   1. the first focus (the route's own mount) does NOT double-fetch — the
 *      queries' own mount fetch owns it;
 *   2. pushing another route and coming BACK re-reads the status and renders
 *      the change made on the PC while the route was blurred.
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
    set: (k: string, v: string) => store.set(k, String(v)),
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
import { act, screen, waitFor } from '@testing-library/react-native';
import { Slot, router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ChangedFile, GetWorkingTreeChangesResponse } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { ChangesView, useSourceControlFocusRefresh } from '../src/features/repo';
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

function statusUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/status`;
}

function changed(
  overrides: Partial<ChangedFile> & Pick<ChangedFile, 'path' | 'status'>
): ChangedFile {
  return { staged: false, ...overrides };
}

function statusBody(
  overrides: Partial<GetWorkingTreeChangesResponse> = {}
): GetWorkingTreeChangesResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

// The route-shell shape under test: the focus hook + a live status consumer.
function RepoProbe() {
  useSourceControlFocusRefresh(OWNER, REPO);
  return <ChangesView owner={OWNER} repo={REPO} />;
}

describe('useSourceControlFocusRefresh', () => {
  let gateway: MockGateway;
  let queryClient: QueryClient | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    queryClient?.clear();
    queryClient = undefined;
    onlineManager.setOnline(true);
  });

  function mountRoutes() {
    const gwClient = new GatewayClient({
      gatewayUrl: gateway.baseUrl,
      fetchImpl: gateway.fetchImpl,
    });
    const client = new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
    queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const qc = queryClient;

    function ProvidersLayout() {
      return (
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
            <Slot />
          </ApiProvider>
        </SafeAreaProvider>
      );
    }

    renderRouter(
      {
        _layout: ProvidersLayout,
        index: RepoProbe,
        other: () => <Text testID="other-route">other</Text>,
      },
      { initialUrl: '/' }
    );
  }

  it('regaining focus re-reads the status; the first focus does not double-fetch', async () => {
    let calls = 0;
    gateway.on('GET', statusUrl(), () => {
      calls += 1;
      return {
        body:
          calls === 1
            ? statusBody()
            : statusBody({ unstaged: [changed({ path: 'src/pc.ts', status: 'modified' })] }),
      };
    });
    const statusReads = () =>
      gateway.requests.filter((r) => r.method === 'GET' && r.url === statusUrl()).length;

    mountRoutes();

    // Mount = first focus: exactly ONE read (no focus double-fetch).
    await waitFor(() => expect(screen.getByTestId('source-control-changes-empty')).toBeTruthy());
    expect(statusReads()).toBe(1);

    // Blur (push another route)…
    act(() => router.push('/other'));
    await waitFor(() => expect(screen.getByTestId('other-route')).toBeTruthy());
    expect(statusReads()).toBe(1);

    // …then RE-focus: the hook invalidates → the active status query re-reads
    // and renders the change made on the PC while we were away.
    act(() => router.back());
    await waitFor(() => expect(statusReads()).toBe(2));
    await waitFor(() => expect(screen.getByTestId('source-control-group-unstaged')).toBeTruthy());
  });
});
