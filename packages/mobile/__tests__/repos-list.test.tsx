/**
 * Repos list (search, filter, paginate).
 *
 * Drives the repository list screen end-to-end through the authed TanStack Query
 * layer with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore, and an in-memory MMKV (the repos-store UI-prefs backend). Verifies
 * (per the story's acceptance criteria):
 *
 *   1. infinite scroll fetches the next page up to `hasMore`/`total_count`, paging
 *      across the three endpoints (`/api/repos/cached` page 1 → `/api/repos` page 2);
 *   2. a debounced search query + the language filter (filters panel →
 *      SelectorSheet) narrow the rendered cards, with the "Found N" results count;
 *   3. the sort select rides as the `sort=` query param;
 *   4. the empty-states show when nothing matches (bare vs. filtered + clear-all);
 *   5. pull-to-refresh re-fetches via `/api/repos/refresh`, and loading vs. error
 *      render as DISTINCT states.
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

// react-native-mmkv backs the repos-store (search/language UI prefs).
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
import { FlatList, Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { GetReposResponse, QrLinkPayload, RepositoryWithLocal } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { RepoListScreen } from '../src/features/repos';
import { useBlockedOrgsStore } from '../src/features/settings/sections/organizations/blockedOrgsStore';
import { useReposStore } from '../src/features/state';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Always-online NetInfo (connectivity isn't under test here). */
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

/** Minimal repo fixture — only the fields the card + filters read. */
function makeRepo(id: number, overrides: Partial<RepositoryWithLocal> = {}): RepositoryWithLocal {
  return {
    id,
    name: `repo-${id}`,
    full_name: `octocat/repo-${id}`,
    owner: { login: 'octocat', id: 1, avatar_url: '', html_url: '', type: 'User' },
    private: false,
    description: `Description ${id}`,
    homepage: null,
    html_url: `https://github.com/octocat/repo-${id}`,
    fork: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    size: 1,
    stargazers_count: id,
    watchers_count: 0,
    language: 'TypeScript',
    forks_count: 0,
    open_issues_count: 0,
    default_branch: 'main',
    ...overrides,
  };
}

/** Build the deterministic sandbox URL the ViewModel issues (param order is fixed). */
function reposUrl(
  endpoint: 'cached' | 'refresh' | 'list',
  page: number,
  extra = '',
  sort = 'updated'
): string {
  const path =
    endpoint === 'cached'
      ? '/api/repos/cached'
      : endpoint === 'refresh'
        ? '/api/repos/refresh'
        : '/api/repos';
  // The Repos tab lists the full GitHub account list (cloned + uncloned) — no localOnly.
  return `${SANDBOX_BASE}${path}?page=${page}&per_page=20&sort=${sort}&skipGitOperations=true${extra}`;
}

describe('repos list (search, filter, paginate)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(qc: QueryClient, debounceMs = 10) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <RepoListScreen debounceMs={debounceMs} navigate={() => {}} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    act(() => {
      useReposStore.setState({ searchQuery: '', languageFilter: null });
      useBlockedOrgsStore.setState({ blockedOrgs: [] });
    });
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('sends the blockedOrgs filter param when orgs are blocked (Settings → Organizations)', async () => {
    // sorted JSON array, exactly as useBlockedOrgsParam encodes it
    const extra = `&blockedOrgs=${encodeURIComponent(JSON.stringify(['acme']))}`;
    gateway.on('GET', reposUrl('cached', 1, extra), () => ({
      body: { repos: [makeRepo(0)], hasMore: false, total_count: 1 } satisfies GetReposResponse,
    }));
    act(() => {
      useBlockedOrgsStore.setState({ blockedOrgs: ['acme'] });
    });

    mount(newQueryClient());

    // The list query carries the blockedOrgs filter…
    await waitFor(() =>
      expect(gateway.requests.some((r) => r.url === reposUrl('cached', 1, extra))).toBe(true)
    );
    // …and never the unfiltered URL.
    expect(gateway.requests.some((r) => r.url === reposUrl('cached', 1))).toBe(false);
  });

  it('paginates with infinite scroll across cached → list endpoints (hasMore/total_count)', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: {
        repos: Array.from({ length: 20 }, (_, i) => makeRepo(i)),
        hasMore: true,
        total_count: 21,
      } satisfies GetReposResponse,
    }));
    gateway.on('GET', reposUrl('list', 2), () => ({
      body: { repos: [makeRepo(20)], hasMore: false, total_count: 21 } satisfies GetReposResponse,
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(20));
    expect(gateway.requests.filter((r) => r.url === reposUrl('cached', 1))).toHaveLength(1);

    fireEvent.press(screen.getByTestId('repo-list-load-more'));
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === reposUrl('list', 2))).toHaveLength(1)
    );
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(21));
  });

  it('narrows the list with a debounced search query and a language-filter chip', async () => {
    // Unfiltered page 1: two languages so the TypeScript chip appears.
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: {
        repos: [makeRepo(0), makeRepo(1, { language: 'Go' })],
        hasMore: false,
        total_count: 2,
      } satisfies GetReposResponse,
    }));
    // Debounced search "repo-0" → server narrows to one card.
    gateway.on('GET', reposUrl('cached', 1, '&search=repo-0'), () => ({
      body: { repos: [makeRepo(0)], hasMore: false, total_count: 1 } satisfies GetReposResponse,
    }));
    // Language filter "Go" → server narrows to the Go repo.
    gateway.on('GET', reposUrl('cached', 1, '&language=Go'), () => ({
      body: {
        repos: [makeRepo(1, { language: 'Go' })],
        hasMore: false,
        total_count: 1,
      } satisfies GetReposResponse,
    }));

    mount(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(2));

    // Debounced search narrows to one card (+ the "Found N" results count).
    fireEvent.changeText(screen.getByTestId('repo-search-input'), 'repo-0');
    await waitFor(() =>
      expect(gateway.requests.some((r) => r.url === reposUrl('cached', 1, '&search=repo-0'))).toBe(
        true
      )
    );
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(1));
    expect(screen.getByTestId('repo-card-0')).toBeTruthy();
    expect(screen.getByTestId('repo-results-count')).toHaveTextContent(/Found 1 repository/);

    // Clear search, then apply the language filter via the filters panel sheet.
    fireEvent.changeText(screen.getByTestId('repo-search-input'), '');
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(2));

    fireEvent.press(screen.getByTestId('repo-filters-toggle'));
    fireEvent.press(screen.getByTestId('repo-language-select'));
    fireEvent.press(screen.getByTestId('repo-language-Go'));
    await waitFor(() =>
      expect(gateway.requests.some((r) => r.url === reposUrl('cached', 1, '&language=Go'))).toBe(
        true
      )
    );
    await waitFor(() => expect(screen.getByTestId('repo-card-1')).toBeTruthy());
    expect(screen.queryByTestId('repo-card-0')).toBeNull();
  });

  it('changes the sort order via the filters panel (rides as the sort= param)', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: {
        repos: [makeRepo(0), makeRepo(1)],
        hasMore: false,
        total_count: 2,
      } satisfies GetReposResponse,
    }));
    gateway.on('GET', reposUrl('cached', 1, '', 'stars'), () => ({
      body: {
        repos: [makeRepo(1), makeRepo(0)],
        hasMore: false,
        total_count: 2,
      } satisfies GetReposResponse,
    }));

    mount(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(2));

    fireEvent.press(screen.getByTestId('repo-filters-toggle'));
    fireEvent.press(screen.getByTestId('repo-sort-select'));
    fireEvent.press(screen.getByTestId('repo-sort-stars'));

    await waitFor(() =>
      expect(gateway.requests.some((r) => r.url === reposUrl('cached', 1, '', 'stars'))).toBe(true)
    );
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(2));
  });

  it('shows the empty-state when no repos match', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: { repos: [], hasMore: false, total_count: 0 } satisfies GetReposResponse,
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-list-empty')).toBeTruthy());
    expect(screen.queryByTestId('repo-list-loading')).toBeNull();
    expect(screen.queryByTestId('repo-list-error')).toBeNull();
    // Bare empty state (no filters) has no clear-all affordance.
    expect(screen.queryByTestId('repo-list-empty-clear')).toBeNull();
  });

  it('shows the filtered empty-state with "Clear all filters" restoring the list', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: { repos: [makeRepo(0)], hasMore: false, total_count: 1 } satisfies GetReposResponse,
    }));
    gateway.on('GET', reposUrl('cached', 1, '&search=zzz'), () => ({
      body: { repos: [], hasMore: false, total_count: 0 } satisfies GetReposResponse,
    }));

    mount(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(1));

    fireEvent.changeText(screen.getByTestId('repo-search-input'), 'zzz');
    await waitFor(() => expect(screen.getByTestId('repo-list-empty-clear')).toBeTruthy());

    fireEvent.press(screen.getByTestId('repo-list-empty-clear'));
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(1));
    expect(screen.queryByTestId('repo-list-empty')).toBeNull();
  });

  it('renders the local-clone status from the backend (never shells out to git)', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: {
        repos: [
          makeRepo(0, { isLocal: true, localStatus: 'cloned', gitStatus: undefined }),
          makeRepo(1, { isLocal: false }),
          makeRepo(2, {
            isLocal: true,
            localStatus: 'cloned',
            gitStatus: {
              branch: 'feat/x',
              ahead: 2,
              behind: 0,
              insertions: 5,
              deletions: 1,
              staged: 0,
              modified: 3,
              untracked: 0,
            },
          }),
        ],
        hasMore: false,
        total_count: 3,
      } satisfies GetReposResponse,
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-cloned-0')).toBeTruthy());
    expect(screen.queryByTestId('repo-cloned-1')).toBeNull();
    // Non-local card's second line = default branch; local + gitStatus = the
    // compact git-status line (branch • +ins/-del • ↑ahead • M count).
    expect(screen.getByTestId('repo-branch-1')).toHaveTextContent(/main/);
    const gitLine = screen.getByTestId('repo-git-status-2');
    expect(gitLine).toHaveTextContent(/feat\/x/);
    expect(gitLine).toHaveTextContent(/\+5/);
    expect(gitLine).toHaveTextContent(/-1/);
    expect(gitLine).toHaveTextContent(/↑2/);
    expect(gitLine).toHaveTextContent(/3M/);
  });

  it('tapping a CLONED repo opens it; tapping an UNCLONED remote clones it then opens it', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: {
        repos: [
          makeRepo(0, { isLocal: true, localStatus: 'cloned' }),
          makeRepo(1, { isLocal: false, localStatus: 'not_cloned' }),
        ],
        hasMore: false,
        total_count: 2,
      } satisfies GetReposResponse,
    }));
    const cloneUrl = `${SANDBOX_BASE}/api/repos/octocat/repo-1/clone`;
    gateway.on('POST', cloneUrl, () => ({ body: { success: true, path: '/ws/octocat/repo-1' } }));

    const navigate = jest.fn();
    const client = buildClient(gateway);
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={newQueryClient()} netInfo={onlineNetInfo}>
          <RepoListScreen debounceMs={10} navigate={navigate} />
        </ApiProvider>
      </SafeAreaProvider>
    );

    // The uncloned remote shows the "Clone" affordance, the cloned one the "Cloned" badge.
    await waitFor(() => expect(screen.getByTestId('repo-clone-1')).toBeTruthy());
    expect(screen.getByTestId('repo-cloned-0')).toBeTruthy();

    // Tapping the cloned repo opens it directly — no clone request.
    fireEvent.press(screen.getByTestId('repo-card-0'));
    expect(navigate).toHaveBeenCalledWith('/repos/octocat/repo-0');
    expect(gateway.requests.some((r) => r.url === cloneUrl)).toBe(false);

    // Tapping the uncloned remote clones it to the workspace, then opens it.
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-card-1'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        gateway.requests.filter((r) => r.method === 'POST' && r.url === cloneUrl)
      ).toHaveLength(1)
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/repos/octocat/repo-1'));
  });

  it('pull-to-refresh force-fetches via /api/repos/refresh', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      body: { repos: [makeRepo(0)], hasMore: false, total_count: 1 } satisfies GetReposResponse,
    }));
    gateway.on('GET', reposUrl('refresh', 1), () => ({
      body: {
        repos: [makeRepo(0), makeRepo(1)],
        hasMore: false,
        total_count: 2,
      } satisfies GetReposResponse,
    }));

    mount(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(1));

    const flatList = screen.UNSAFE_getByType(FlatList as never);
    await act(async () => {
      flatList.props.onRefresh();
    });

    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === reposUrl('refresh', 1))).toHaveLength(1)
    );
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(2));
  });

  it('renders a DISTINCT error state (not loading, not empty) on a failed load', async () => {
    gateway.on('GET', reposUrl('cached', 1), () => ({
      status: 500,
      body: { error: 'boom' },
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-list-error')).toBeTruthy());
    expect(screen.queryByTestId('repo-list-loading')).toBeNull();
    expect(screen.queryByTestId('repo-list-empty')).toBeNull();
    expect(screen.queryByTestId('repo-list-flatlist')).toBeNull();
  });

  it('error state offers "Connect PC" → settled QR re-scan closes the modal and refetches', async () => {
    // The list fails (broken PC connection) until the (mocked) re-connect runs.
    let failing = true;
    gateway.on('GET', reposUrl('cached', 1), () =>
      failing
        ? { status: 500, body: { error: 'pc connection lost' } }
        : {
            body: {
              repos: [makeRepo(0)],
              hasMore: false,
              total_count: 1,
            } satisfies GetReposResponse,
          }
    );

    const link = jest.fn(async () => {});
    const connect = jest.fn(async () => {
      failing = false;
      return { ready: true as const, deviceToken: 'jwt' };
    });
    const pcConnect = {
      link,
      connect,
      renderScanner: ({ onPayload }: { onPayload: (p: QrLinkPayload) => void }) => (
        <Pressable
          testID="fake-scan"
          onPress={() =>
            onPayload({ gatewayBase: 'https://app.portable.dev', pcId: 'pc_x', token: 'jwt' })
          }
        >
          <Text>scan</Text>
        </Pressable>
      ),
    };

    const client = buildClient(gateway);
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={newQueryClient()} netInfo={onlineNetInfo}>
          <RepoListScreen debounceMs={10} navigate={() => {}} pcConnect={pcConnect} />
        </ApiProvider>
      </SafeAreaProvider>
    );

    await waitFor(() => expect(screen.getByTestId('repo-list-error')).toBeTruthy());

    // The error state is no longer a dead end: Connect PC opens the QR re-scan modal.
    fireEvent.press(screen.getByTestId('repo-list-connect-pc'));
    await waitFor(() => expect(screen.getByTestId('fake-scan')).toBeTruthy());

    // Scanning links the JWT + connects (mocked ready) → list recovers.
    await act(async () => {
      fireEvent.press(screen.getByTestId('fake-scan'));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        gatewayBase: 'https://app.portable.dev',
        pcId: 'pc_x',
        token: 'jwt',
      })
    );
    expect(connect).toHaveBeenCalledWith('pc_x');

    // Settled flow → modal closes, the list refetches and recovers.
    await waitFor(() => expect(screen.queryByTestId('pc-connect-modal')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('repo-list-count').props.children).toBe(1));
    expect(screen.queryByTestId('repo-list-error')).toBeNull();
  });
});
