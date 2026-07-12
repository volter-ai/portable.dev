/**
 * portable.dev#17 — Source Control Worktrees tab (read-only list + per-worktree changes).
 *
 * Drives `WorktreesView` + `WorktreesTab` through the authed TanStack Query layer
 * with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory SecureStore
 * (sandbox URL + authToken), and an in-memory MMKV (the theme store the components
 * read via `useAppTheme`). Verifies, per the AC:
 *
 *   1. the list renders a row per worktree (folder/path, branch-or-"detached",
 *      HEAD short-sha) with main/locked/prunable/bare badges + a hidden count;
 *   2. tapping a worktree fires the navigation seam;
 *   3. only-main shows the "No additional worktrees yet" note;
 *   4. distinct loading / error / empty testIDs (retry:false → one request);
 *   5. the tab gates on the clone-first state, then opens a worktree's changes
 *      scoped via GET …/status?worktree=<path>.
 */

// In-memory keychain for expo-secure-store (sandbox URL + authToken live here).
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

// react-native-mmkv backs the theme store (the components read useAppTheme).
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

// The native NetInfo module must never load under Jest.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { GetWorktreesResponse, Worktree } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { WorktreesTab, WorktreesView } from '../src/features/repo';
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

function worktreesUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/worktrees`;
}
function detailsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}?skipGitOperations=true`;
}
function statusUrl(worktree?: string): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/status${
    worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''
  }`;
}

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'path' | 'head'>): Worktree {
  return {
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: false,
    ...overrides,
  };
}

function worktreesBody(worktrees: Worktree[]): GetWorktreesResponse {
  return { worktrees };
}

const MAIN = worktree({
  path: '/workspace/octocat/hello-world',
  head: 'aaaaaaaaaaaa1111',
  branch: 'main',
  isMain: true,
});
const FEATURE = worktree({
  path: '/workspace/octocat/hello-world-wt/feature',
  head: 'bbbbbbbbbbbb2222',
  branch: 'feature/login',
});

describe('Source Control Worktrees tab', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mountView(qc: QueryClient, onSelectWorktree?: (w: Worktree) => void) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <WorktreesView owner={OWNER} repo={REPO} onSelectWorktree={onSelectWorktree} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  function mountTab(qc: QueryClient) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <WorktreesTab owner={OWNER} repo={REPO} />
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

  it('lists worktrees with the branch, short-sha, badges, and a hidden count', async () => {
    const locked = worktree({
      path: '/workspace/octocat/hello-world-wt/hotfix',
      head: 'cccccccccccc3333',
      branch: 'hotfix/1',
      locked: true,
    });
    gateway.on('GET', worktreesUrl(), () => ({ body: worktreesBody([MAIN, FEATURE, locked]) }));

    mountView(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('worktrees-count').props.children).toBe(3));

    // A row per worktree (keyed by absolute path).
    expect(screen.getByTestId(`worktree-${MAIN.path}`)).toBeTruthy();
    expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toBeTruthy();

    // The main worktree carries the "main" badge; the locked one a "locked" badge.
    expect(screen.getByTestId(`worktree-${MAIN.path}-badge-main`)).toBeTruthy();
    expect(screen.getByTestId(`worktree-${locked.path}-badge-locked`)).toBeTruthy();

    // Branch + short-sha render on the feature row.
    expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toHaveTextContent(/feature\/login/);
    expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toHaveTextContent(/bbbbbbb/);

    // More than one worktree → no "only main" note.
    expect(screen.queryByTestId('worktrees-only-main-note')).toBeNull();
  });

  it('fires the navigation seam when a worktree row is tapped', async () => {
    const onSelect = jest.fn();
    gateway.on('GET', worktreesUrl(), () => ({ body: worktreesBody([MAIN, FEATURE]) }));

    mountView(newQueryClient(), onSelect);

    await waitFor(() => expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toBeTruthy());
    fireEvent.press(screen.getByTestId(`worktree-${FEATURE.path}`));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: FEATURE.path }));
  });

  it('shows the "No additional worktrees yet" note when only the main worktree exists', async () => {
    gateway.on('GET', worktreesUrl(), () => ({ body: worktreesBody([MAIN]) }));

    mountView(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('worktrees-only-main-note')).toBeTruthy());
    expect(screen.getByTestId('worktrees-count').props.children).toBe(1);
    expect(screen.getByTestId(`worktree-${MAIN.path}`)).toBeTruthy();
  });

  it('renders a "detached" branch label for a detached HEAD worktree', async () => {
    const detached = worktree({
      path: '/workspace/octocat/hello-world-wt/detached',
      head: 'dddddddddddd4444',
      detached: true,
    });
    gateway.on('GET', worktreesUrl(), () => ({ body: worktreesBody([MAIN, detached]) }));

    mountView(newQueryClient());

    await waitFor(() => expect(screen.getByTestId(`worktree-${detached.path}`)).toBeTruthy());
    expect(screen.getByTestId(`worktree-${detached.path}`)).toHaveTextContent(/detached/);
  });

  it('shows the error state when the worktrees read fails (retry:false)', async () => {
    gateway.on('GET', worktreesUrl(), () => ({ status: 500, body: { error: 'boom' } }));

    mountView(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('worktrees-list-error')).toBeTruthy());
    // retry:false → exactly one request.
    expect(gateway.requests.filter((r) => r.url === worktreesUrl())).toHaveLength(1);
  });

  it('gates on the clone-first state, then opens a worktree changes scoped via ?worktree=', async () => {
    gateway.on('GET', detailsUrl(), () => ({ body: { name: REPO, isLocal: true } }));
    gateway.on('GET', worktreesUrl(), () => ({ body: worktreesBody([MAIN, FEATURE]) }));
    gateway.on('GET', statusUrl(FEATURE.path), () => ({
      body: {
        branch: 'feature/login',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [{ path: 'src/login.ts', status: 'modified', staged: false }],
        untracked: [],
        conflicted: [],
      },
    }));

    mountTab(newQueryClient());

    // Cloned → the tab wrapper + the list render.
    await waitFor(() => expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toBeTruthy());
    expect(screen.queryByTestId('worktrees-clone-gate')).toBeNull();

    // Tap a worktree → its changes screen, fed by GET …/status?worktree=<path>.
    fireEvent.press(screen.getByTestId(`worktree-${FEATURE.path}`));

    await waitFor(() => expect(screen.getByTestId('worktree-changes-screen')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('source-control-changes-count').props.children).toBe(1)
    );
    expect(screen.getByTestId('source-control-file-unstaged-src/login.ts')).toBeTruthy();
    // The scoped status endpoint was hit (worktree path in the query string).
    expect(gateway.requests.some((r) => r.url === statusUrl(FEATURE.path))).toBe(true);

    // Back returns to the list.
    fireEvent.press(screen.getByTestId('worktree-changes-back'));
    await waitFor(() => expect(screen.getByTestId('worktrees-list')).toBeTruthy());
  });

  it('shows the clone-first gate when the repo is not cloned locally', async () => {
    gateway.on('GET', detailsUrl(), () => ({ body: { name: REPO, isLocal: false } }));

    mountTab(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('worktrees-clone-gate')).toBeTruthy());
    expect(screen.queryByTestId('worktrees-tab')).toBeNull();
  });

  it('pull-to-refresh re-reads the list and renders a worktree added on the PC', async () => {
    let calls = 0;
    gateway.on('GET', worktreesUrl(), () => {
      calls += 1;
      return { body: worktreesBody(calls === 1 ? [MAIN] : [MAIN, FEATURE]) };
    });

    mountView(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('worktrees-count').props.children).toBe(1));

    // Drive the RefreshControl's onRefresh (the tasks-page precedent —
    // RefreshControl isn't reachable by testID under the test renderer).
    const refreshControl = screen.UNSAFE_getByType(RefreshControl as never) as unknown as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    // The pull re-read the list and rendered the worktree created ON THE PC.
    await waitFor(() => expect(screen.getByTestId(`worktree-${FEATURE.path}`)).toBeTruthy());
    expect(screen.getByTestId('worktrees-count').props.children).toBe(2);
  });
});
