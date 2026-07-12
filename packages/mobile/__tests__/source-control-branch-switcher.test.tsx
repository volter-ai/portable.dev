/**
 * portable.dev#17 — Source Control branch/worktree switcher.
 *
 * Drives `SourceControlTab` through the authed TanStack Query layer with a
 * mocked sandbox HTTP layer (`createMockGateway`), an in-memory SecureStore
 * (sandbox URL + authToken), and an in-memory MMKV (the theme store via
 * `useAppTheme`). Verifies:
 *
 *   1. tapping the header's branch label opens the searchable switcher sheet
 *      listing every worktree by its checked-out branch;
 *   2. typing in the search box filters the options (type-to-find a worktree);
 *   3. selecting a worktree re-scopes the header status read via `?worktree=`
 *      (the label shows THAT worktree's branch) and hides Push / Pull
 *      (main-checkout-only actions);
 *   4. selecting the main checkout again restores the unscoped read + actions.
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

import type { GetWorktreesResponse, Worktree } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SourceControlTab } from '../src/features/repo';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const OWNER = 'octocat';
const REPO = 'hello-world';

const MAIN_PATH = '/Users/dev/hello-world';
const WT_PATH = '/Users/dev/hello-world/.worktrees/17';
const WT_BRANCH = 'feat/17-mobile-source-control';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

const detailsUrl = () => `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}?skipGitOperations=true`;
const graphUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/graph`;
const worktreesUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/worktrees`;
const statusUrl = () => `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/status`;
const scopedStatusUrl = () => `${statusUrl()}?worktree=${encodeURIComponent(WT_PATH)}`;

function makeWorktree(overrides: Partial<Worktree> & Pick<Worktree, 'path' | 'head'>): Worktree {
  return {
    branch: undefined,
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: false,
    ...overrides,
  };
}

const WORKTREES: GetWorktreesResponse = {
  worktrees: [
    makeWorktree({ path: MAIN_PATH, head: 'a'.repeat(40), branch: 'main', isMain: true }),
    makeWorktree({ path: WT_PATH, head: 'b'.repeat(40), branch: WT_BRANCH }),
  ],
};

function statusBody(branch: string, ahead = 0, behind = 0) {
  return {
    branch,
    ahead,
    behind,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

describe('Source Control branch/worktree switcher', () => {
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
          <SourceControlTab owner={OWNER} repo={REPO} />
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
    gateway.on('GET', detailsUrl(), () => ({ body: { isLocal: true } }));
    gateway.on('GET', graphUrl(), () => ({ body: { nodes: [] } }));
    gateway.on('GET', worktreesUrl(), () => ({ body: WORKTREES }));
    gateway.on('GET', statusUrl(), () => ({ body: statusBody('main', 2, 1) }));
    gateway.on('GET', scopedStatusUrl(), () => ({ body: statusBody(WT_BRANCH) }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('opens the searchable switcher from the branch label and filters by typing', async () => {
    mount(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );

    fireEvent.press(screen.getByTestId('source-control-branch-switch'));

    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    expect(screen.getByTestId(`source-control-branch-option-${MAIN_PATH}`)).toBeTruthy();
    expect(screen.getByTestId(`source-control-branch-option-${WT_PATH}`)).toBeTruthy();

    // Type-to-filter: "feat" keeps only the worktree's branch row.
    fireEvent.changeText(screen.getByTestId('source-control-branch-sheet-search'), 'feat');
    expect(screen.queryByTestId(`source-control-branch-option-${MAIN_PATH}`)).toBeNull();
    expect(screen.getByTestId(`source-control-branch-option-${WT_PATH}`)).toBeTruthy();
  });

  it('selecting a worktree re-scopes the status read and keeps Push/Pull (worktree-scoped)', async () => {
    mount(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );
    expect(screen.getByTestId('source-control-push')).toBeTruthy();

    fireEvent.press(screen.getByTestId('source-control-branch-switch'));
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`source-control-branch-option-${WT_PATH}`));

    // The header re-reads scoped to the worktree and shows ITS branch.
    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe(WT_BRANCH)
    );
    const scoped = gateway.requests.find((r) => r.method === 'GET' && r.url === scopedStatusUrl());
    expect(scoped).toBeTruthy();

    // Push / Pull stay available — scoped to the worktree (the mutation body
    // carries the worktree path; covered by the push-pull header suite).
    expect(screen.getByTestId('source-control-push')).toBeTruthy();
    expect(screen.getByTestId('source-control-pull')).toBeTruthy();

    // The sheet closed on selection.
    expect(screen.queryByTestId('source-control-branch-sheet')).toBeNull();
  });

  it('selecting the main checkout restores the unscoped read + Push/Pull', async () => {
    mount(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );

    // Into the worktree…
    fireEvent.press(screen.getByTestId('source-control-branch-switch'));
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`source-control-branch-option-${WT_PATH}`));
    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe(WT_BRANCH)
    );

    // …and back to main.
    fireEvent.press(screen.getByTestId('source-control-branch-switch'));
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`source-control-branch-option-${MAIN_PATH}`));

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );
    expect(screen.getByTestId('source-control-push')).toBeTruthy();
    expect(screen.getByTestId('source-control-pull')).toBeTruthy();
  });

  it('opening the switcher re-reads the worktree list (PC-side worktrees appear)', async () => {
    mount(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );
    const worktreeReads = () =>
      gateway.requests.filter((r) => r.method === 'GET' && r.url === worktreesUrl()).length;
    expect(worktreeReads()).toBe(1);

    fireEvent.press(screen.getByTestId('source-control-branch-switch'));

    // The sheet opens AND the list is re-read so out-of-band worktrees appear.
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    await waitFor(() => expect(worktreeReads()).toBe(2));
  });

  it('re-selecting a scope re-reads its status (staleTime 0 — no stale cache)', async () => {
    mount(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe('main')
    );
    const unscopedReads = () =>
      gateway.requests.filter((r) => r.method === 'GET' && r.url === statusUrl()).length;
    expect(unscopedReads()).toBe(1);

    // Into the worktree…
    fireEvent.press(screen.getByTestId('source-control-branch-switch'));
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`source-control-branch-option-${WT_PATH}`));
    await waitFor(() =>
      expect(screen.getByTestId('source-control-branch').props.children).toBe(WT_BRANCH)
    );

    // …and back to main: the cached main status must NOT be trusted — the PC
    // may have changed the tree while we were scoped elsewhere.
    fireEvent.press(screen.getByTestId('source-control-branch-switch'));
    await waitFor(() => expect(screen.getByTestId('source-control-branch-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId(`source-control-branch-option-${MAIN_PATH}`));

    await waitFor(() => expect(unscopedReads()).toBe(2));
  });
});
