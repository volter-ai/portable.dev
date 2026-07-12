/**
 * portable.dev#17 — Multi-lane commit graph renderer + commit detail.
 *
 * Two layers:
 *   1. `computeCommitLanes` PURE unit tests — linear history, a branch+merge, and
 *      multiple parallel branches (the AC's three shapes), asserting columns +
 *      converging-collapse + the merge fan-out edges + `splitDiffByFile`.
 *   2. `CommitGraphView` + `CommitDetailScreen` component tests through the authed
 *      TanStack Query layer (`createMockGateway`) — the graph rows + ref badges
 *      render, tapping a commit fires the navigation seam, and the commit-detail
 *      screen lists changed files + expands a file's diff (UnifiedDiffView).
 *
 * Multi-node-text gotcha: diff lines / badge labels render as separate Text nodes
 * — assert content with REGEX matchers, never bare strings.
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

import type {
  CommitGraphNode,
  GetCommitDetailResponse,
  GetCommitGraphResponse,
} from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  CommitDetailScreen,
  CommitGraphView,
  computeCommitLanes,
  splitDiffByFile,
} from '../src/features/repo';
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

function node(overrides: Partial<CommitGraphNode> & Pick<CommitGraphNode, 'sha'>): CommitGraphNode {
  return {
    parents: [],
    refs: [],
    author: 'octocat',
    date: '2026-06-16T00:00:00Z',
    subject: `commit ${overrides.sha}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. computeCommitLanes — pure lane-layout unit tests.
// ---------------------------------------------------------------------------

describe('computeCommitLanes', () => {
  it('lays out a linear history in a single column', () => {
    const rows = computeCommitLanes([
      node({ sha: 'A', parents: ['B'] }),
      node({ sha: 'B', parents: ['C'] }),
      node({ sha: 'C', parents: [] }),
    ]);

    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    // Each gap (except the last) carries a single straight edge in column 0.
    expect(rows[0].edges).toEqual([{ fromCol: 0, toCol: 0, color: expect.any(String) }]);
    expect(rows[1].edges).toEqual([{ fromCol: 0, toCol: 0, color: expect.any(String) }]);
    expect(rows[2].edges).toEqual([]);
  });

  it('handles a branch + merge (fan-out then converge to the leftmost lane)', () => {
    // M(merge) ⟶ A, B ; A ⟶ Base ; B ⟶ Base ; Base(root)
    const rows = computeCommitLanes([
      node({ sha: 'M', parents: ['A', 'B'] }),
      node({ sha: 'A', parents: ['Base'] }),
      node({ sha: 'B', parents: ['Base'] }),
      node({ sha: 'Base', parents: [] }),
    ]);

    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 0]);

    // The merge fans a second parent lane out from the commit's own column (0→1).
    expect(rows[0].edges).toContainEqual(expect.objectContaining({ fromCol: 0, toCol: 1 }));
    // B's lane (column 1) converges back to Base in the leftmost lane (1→0).
    expect(rows[2].edges).toContainEqual(expect.objectContaining({ fromCol: 1, toCol: 0 }));
  });

  it('lays out multiple parallel branches in distinct columns', () => {
    // Two independent tips X and Y over a shared root R.
    //   X ⟶ R ; Y ⟶ R ; R(root). topo order: X, Y, R.
    const rows = computeCommitLanes([
      node({ sha: 'X', parents: ['R'] }),
      node({ sha: 'Y', parents: ['R'] }),
      node({ sha: 'R', parents: [] }),
    ]);

    // X claims lane 0; Y is a fresh tip → lane 1; R collapses both to lane 0.
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0]);
    // Y's lane converges into R at column 0.
    expect(rows[1].edges).toContainEqual(expect.objectContaining({ fromCol: 1, toCol: 0 }));
  });
});

describe('splitDiffByFile', () => {
  it('splits a multi-file commit diff into per-file patches keyed by new path', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+added',
    ].join('\n');

    const byPath = splitDiffByFile(diff);
    expect(Object.keys(byPath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(byPath['src/a.ts']).toContain('+new');
    expect(byPath['src/b.ts']).toContain('+added');
  });
});

// ---------------------------------------------------------------------------
// 2. CommitGraphView + CommitDetailScreen — component tests.
// ---------------------------------------------------------------------------

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}
function graphUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/graph`;
}
function commitUrl(sha: string): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/commit/${sha}`;
}

describe('CommitGraphView + CommitDetailScreen', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mountGraph(qc: QueryClient, onSelectCommit?: (n: CommitGraphNode) => void) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <CommitGraphView owner={OWNER} repo={REPO} onSelectCommit={onSelectCommit} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  function mountDetail(qc: QueryClient, sha: string) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <CommitDetailScreen owner={OWNER} repo={REPO} sha={sha} />
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

  it('renders the commit rows with ref badges, subject + short SHA', async () => {
    const graph: GetCommitGraphResponse = {
      nodes: [
        node({
          sha: 'aaaaaaa1111111111111111111111111111111',
          parents: ['bbbbbbb'],
          subject: 'Add the feature',
          refs: [
            { name: 'main', type: 'head' },
            { name: 'origin/main', type: 'remote' },
          ],
        }),
        node({ sha: 'bbbbbbb', parents: [], subject: 'Initial commit' }),
      ],
    };
    gateway.on('GET', graphUrl(), () => ({ body: graph }));

    mountGraph(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('commit-graph-count').props.children).toBe(2));

    // Both rows render.
    expect(screen.getByTestId('commit-row-aaaaaaa1111111111111111111111111111111')).toBeTruthy();
    expect(screen.getByTestId('commit-row-bbbbbbb')).toBeTruthy();

    // Ref badges (HEAD + remote) render — regex matchers per the multi-node gotcha.
    expect(screen.getByTestId('commit-ref-head-main')).toHaveTextContent(/HEAD/);
    expect(screen.getByTestId('commit-ref-remote-origin/main')).toHaveTextContent(/origin\/main/);

    // Subject + 7-char short SHA.
    expect(screen.getByText('Add the feature')).toBeTruthy();
    expect(screen.getByText('aaaaaaa')).toBeTruthy();
  });

  it('fires the navigation seam with the tapped commit', async () => {
    const onSelectCommit = jest.fn();
    gateway.on('GET', graphUrl(), () => ({
      body: { nodes: [node({ sha: 'c0ffee0', parents: [] })] } as GetCommitGraphResponse,
    }));

    mountGraph(newQueryClient(), onSelectCommit);

    await waitFor(() => expect(screen.getByTestId('commit-row-c0ffee0')).toBeTruthy());
    fireEvent.press(screen.getByTestId('commit-row-c0ffee0'));

    expect(onSelectCommit).toHaveBeenCalledTimes(1);
    expect(onSelectCommit).toHaveBeenCalledWith(expect.objectContaining({ sha: 'c0ffee0' }));
  });

  it('shows the empty state for a repo with no commits', async () => {
    gateway.on('GET', graphUrl(), () => ({ body: { nodes: [] } as GetCommitGraphResponse }));

    mountGraph(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('commit-graph-empty')).toBeTruthy());
    expect(screen.queryByTestId('commit-graph')).toBeNull();
  });

  it('lists a commit’s changed files and expands a file diff (UnifiedDiffView)', async () => {
    const detail: GetCommitDetailResponse = {
      sha: 'deadbeefcafe',
      stats: { additions: 3, deletions: 1 },
      files: [
        { path: 'src/a.ts', status: 'modified', staged: true, insertions: 2, deletions: 1 },
        { path: 'src/b.ts', status: 'added', staged: true, insertions: 1 },
      ],
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        '-old line',
        '+new line',
        'diff --git a/src/b.ts b/src/b.ts',
        '@@ -0,0 +1 @@',
        '+brand new',
      ].join('\n'),
    };
    gateway.on('GET', commitUrl('deadbeefcafe'), () => ({ body: detail }));

    mountDetail(newQueryClient(), 'deadbeefcafe');

    await waitFor(() => expect(screen.getByTestId('commit-detail')).toBeTruthy());
    expect(screen.getByTestId('commit-detail-title').props.children).toEqual([
      'Commit ',
      'deadbee',
    ]);
    expect(screen.getByTestId('commit-file-src/a.ts')).toBeTruthy();
    expect(screen.getByTestId('commit-file-src/b.ts')).toBeTruthy();

    // Expand the first file → its diff slice renders in a UnifiedDiffView.
    fireEvent.press(screen.getByTestId('commit-file-src/a.ts'));
    await waitFor(() => expect(screen.getByTestId('commit-file-diff-src/a.ts')).toBeTruthy());
    expect(screen.getByTestId('commit-file-diff-src/a.ts')).toHaveTextContent(/\+new line/);
  });

  it('pull-to-refresh re-reads the graph and renders a commit made on the PC', async () => {
    let calls = 0;
    gateway.on('GET', graphUrl(), () => {
      calls += 1;
      return {
        body:
          calls === 1
            ? { nodes: [node({ sha: 'bbbbbbb', parents: [], subject: 'Initial commit' })] }
            : {
                nodes: [
                  node({ sha: 'ccccccc', parents: ['bbbbbbb'], subject: 'Committed on the PC' }),
                  node({ sha: 'bbbbbbb', parents: [], subject: 'Initial commit' }),
                ],
              },
      };
    });

    mountGraph(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('commit-graph-count').props.children).toBe(1));

    // Drive the RefreshControl's onRefresh (the tasks-page precedent —
    // RefreshControl isn't reachable by testID under the test renderer).
    const refreshControl = screen.UNSAFE_getByType(RefreshControl as never) as unknown as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    // The pull re-read the log and rendered the commit made ON THE PC.
    await waitFor(() => expect(screen.getByTestId('commit-row-ccccccc')).toBeTruthy());
    expect(screen.getByTestId('commit-graph-count').props.children).toBe(2);
  });
});
