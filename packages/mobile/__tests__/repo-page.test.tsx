/**
 * RepoPage shell + Overview dashboard / Branches tabs.
 *
 * Drives the repository detail shell through the authed TanStack Query layer
 * with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore (sandbox URL + authToken), and an in-memory MMKV (the chat-store
 * draft backend the branch-comparison default seeds). Verifies:
 *
 *   1. the tab bar exposes ONLY the wired tab set, in the canonical order with the
 *      display labels (`PRs`, `Details`);
 *   2. an unknown `?tab=` param is ignored and falls back to the wired default
 *      (`overview`), per the allowed-tabs guard;
 *   3. the Overview tab renders the `RepoHomeTab` dashboard: the
 *      "Work on {repo}..." input, quick-action pills, the git status bar, and
 *      the lazily expanding file tree (file tap → file viewer route) when the
 *      repo is cloned — and the Clone-to-Local card when it is not;
 *   4. the Branches tab lists branches with last-commit dates (`/branches`) and
 *      exposes a per-branch comparison action.
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

// react-native-mmkv backs the chat-store (the branch-comparison default seeds a draft).
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

// The Overview ViewModel reaches the socket barrel (chat hand-off) — back the
// shared `createSocket` with the recording mock so the real ESM transport never
// loads (the documented virtual-mock rule).
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// Other repo tabs render Markdown (PR/issue bodies) — mock the renderer to a
// plain Text marker so the real markdown-it parser never loads.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: string }) => <Text>{children}</Text>,
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { BranchWithDate, GitStatus } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { RepoPageScreen, REPO_TABS, REPO_TAB_KEYS } from '../src/features/repo';
import { SocketProvider } from '../src/features/socket';
import type { AppStateLike } from '../src/features/socket/lifecycle';
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

function detailsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}?skipGitOperations=true`;
}
function gitStatusUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/git-status`;
}
function quickActionsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/quick-actions`;
}
function treeUrl(path = ''): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/tree/${path}`;
}
function branchesUrl(page = 1): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/branches?page=${page}&per_page=30`;
}
function commandsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/commands`;
}
function cloneUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/clone`;
}
function chatsUrl(): string {
  return `${SANDBOX_BASE}/api/chats`;
}

/** Bare repo-details payload (`GET /api/repos/:o/:r?skipGitOperations=true`). */
function repoDetails(overrides: Record<string, unknown> = {}) {
  return {
    name: REPO,
    full_name: `${OWNER}/${REPO}`,
    description: 'A test repo',
    homepage: null,
    default_branch: 'main',
    owner: { login: OWNER, avatar_url: 'https://avatars.test/octocat.png' },
    isLocal: true,
    ...overrides,
  };
}

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    insertions: 0,
    deletions: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    ...overrides,
  };
}

function makeBranch(name: string, lastCommitDate?: string): BranchWithDate {
  return {
    name,
    protected: false,
    commit: { sha: `sha-${name}`, url: '' },
    lastCommitDate,
    lastCommitMessage: `Update ${name}`,
    lastCommitAuthor: 'octocat',
  };
}

describe('RepoPage shell + Overview dashboard/Branches tabs', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(
    qc: QueryClient,
    props: Partial<React.ComponentProps<typeof RepoPageScreen>> = {}
  ) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <RepoPageScreen owner={OWNER} repo={REPO} navigate={() => {}} {...props} />
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
    // The Overview dashboard fetches details + git status + quick actions + the
    // tree root as it mounts — register cloned-repo defaults.
    gateway.on('GET', detailsUrl(), () => ({ body: repoDetails() }));
    gateway.on('GET', gitStatusUrl(), () => ({ body: gitStatus() }));
    gateway.on('GET', quickActionsUrl(), () => ({ body: { quickActions: [] } }));
    gateway.on('GET', treeUrl(), () => ({ body: { contents: [] } }));
    gateway.on('GET', branchesUrl(1), () => ({
      body: { branches: [], total_count: 0, has_more_pages: false },
    }));
    // The Overview "Work on…" input loads the repo's slash commands for its `/` picker.
    gateway.on('GET', commandsUrl(), () => ({ body: { commands: [] } }));
    // The Overview "Continue chats" preview reads the chat list — default empty
    // (the section renders nothing), overridden per-test.
    gateway.on('GET', chatsUrl(), () => ({ body: { chats: [] } }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('exposes ONLY the wired tab set, in the canonical order with the display labels', async () => {
    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-overview')).toBeTruthy());

    // Every wired tab is present…
    for (const key of REPO_TAB_KEYS) {
      expect(screen.getByTestId(`repo-tab-${key}`)).toBeTruthy();
    }
    // …and the count of rendered tab buttons equals the wired set (no extras).
    expect(REPO_TAB_KEYS).toHaveLength(8);
    expect(screen.queryByTestId('repo-tab-webhooks')).toBeNull();
    expect(screen.queryByTestId('repo-tab-routines')).toBeNull();
    expect(screen.queryByTestId('repo-tab-bogus')).toBeNull();

    // Canonical order + display labels: PRs / Details, branches second-to-last.
    expect(REPO_TABS.map((t) => t.key)).toEqual([
      'overview',
      'issues',
      'prs',
      'actions',
      'workflows',
      'generations',
      'branches',
      'settings',
    ]);
    expect(REPO_TABS.find((t) => t.key === 'prs')?.label).toBe('PRs');
    expect(REPO_TABS.find((t) => t.key === 'settings')?.label).toBe('Details');
  });

  it('ignores an unknown ?tab= param and falls back to the wired default (overview)', async () => {
    mount(newQueryClient(), { tab: 'totally-not-a-tab' });

    expect(screen.getByTestId('repo-active-tab').props.children).toBe('overview');
    await waitFor(() => expect(screen.getByTestId('repo-overview')).toBeTruthy());
  });

  it('honors a known ?tab= param (branches)', async () => {
    mount(newQueryClient(), { tab: 'branches' });

    expect(screen.getByTestId('repo-active-tab').props.children).toBe('branches');
    await waitFor(() => expect(screen.getByTestId('repo-branches-list')).toBeTruthy());
  });

  it('renders the working dashboard for a cloned repo (input, quick actions, git bar, tree)', async () => {
    gateway.on('GET', gitStatusUrl(), () => ({
      body: gitStatus({ ahead: 2, behind: 1, staged: 1, modified: 1, untracked: 1 }),
    }));
    gateway.on('GET', quickActionsUrl(), () => ({
      body: {
        quickActions: [
          {
            id: 'start-dev',
            label: 'Start dev server',
            type: 'message',
            prompt: 'Start the dev server',
            hasStatusDot: true,
            statusDotColor: 'green',
          },
        ],
      },
    }));
    gateway.on('GET', treeUrl(), () => ({
      body: {
        contents: [
          { name: 'src', path: 'src', type: 'directory', hasChildren: true, isHidden: false },
          {
            name: 'package.json',
            path: 'package.json',
            type: 'file',
            size: 120,
            lastModified: Date.now() - 60_000,
            isHidden: false,
          },
        ],
      },
    }));

    mount(newQueryClient());

    // The "Work on {repo}..." input (ChatInputField slot).
    await waitFor(() => expect(screen.getByTestId('repo-overview-input')).toBeTruthy());
    expect(screen.getByPlaceholderText(`Work on ${REPO}...`)).toBeTruthy();
    // No clone card for an already-cloned repo.
    expect(screen.queryByTestId('repo-overview-clone')).toBeNull();

    // Quick-action pill.
    await waitFor(() => expect(screen.getByTestId('repo-quick-action-start-dev')).toBeTruthy());

    // Git status bar: branch chip + ↑2 ↓1 + 3 changed (staged+modified+untracked).
    await waitFor(() => expect(screen.getByTestId('repo-overview-branch')).toBeTruthy());
    expect(screen.getByTestId('repo-overview-branch')).toHaveTextContent(/main/);
    expect(screen.getByTestId('repo-git-ahead')).toHaveTextContent(/2/);
    expect(screen.getByTestId('repo-git-behind')).toHaveTextContent(/1/);
    expect(screen.getByTestId('repo-git-changed')).toHaveTextContent(/3 changed/);
    expect(screen.queryByTestId('repo-git-up-to-date')).toBeNull();

    // File tree rows (dirs first — backend ordering preserved).
    await waitFor(() => expect(screen.getByTestId('repo-tree-node-src')).toBeTruthy());
    expect(screen.getByTestId('repo-tree-node-package.json')).toBeTruthy();
  });

  it('renders the "Continue chats" preview with only THIS repo\'s chats (above the file tree)', async () => {
    const chat = (over: Record<string, unknown>) => ({
      id: 'c1',
      type: 'claude_code',
      title: 'A chat',
      lastUpdated: Date.now(),
      ...over,
    });
    gateway.on('GET', chatsUrl(), () => ({
      body: {
        chats: [
          chat({ id: 'mine', repoFullName: `${OWNER}/${REPO}`, firstMessagePreview: 'Fix login' }),
          chat({ id: 'other', repoFullName: 'someone/else', firstMessagePreview: 'Unrelated' }),
          chat({ id: 'archived', repoFullName: `${OWNER}/${REPO}`, archived: true }),
        ],
      },
    }));

    mount(newQueryClient());

    // This repo's active chat appears in the preview…
    await waitFor(() => expect(screen.getByTestId('home-chat-mine')).toBeTruthy());
    // …another repo's chat and this repo's archived chat do NOT.
    expect(screen.queryByTestId('home-chat-other')).toBeNull();
    expect(screen.queryByTestId('home-chat-archived')).toBeNull();
    // The file tree still renders below the preview.
    expect(screen.getByTestId('repo-tree')).toBeTruthy();
  });

  it('shows ✓ up to date when the working tree is clean', async () => {
    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-git-up-to-date')).toBeTruthy());
    expect(screen.getByTestId('repo-git-up-to-date')).toHaveTextContent(/up to date/);
    expect(screen.queryByTestId('repo-git-changed')).toBeNull();
  });

  it('expands a folder lazily and opens a file in the file viewer', async () => {
    gateway.on('GET', treeUrl(), () => ({
      body: {
        contents: [
          { name: 'src', path: 'src', type: 'directory', hasChildren: true, isHidden: false },
        ],
      },
    }));
    gateway.on('GET', treeUrl('src'), () => ({
      body: {
        contents: [
          {
            name: 'index.ts',
            path: 'src/index.ts',
            type: 'file',
            size: 64,
            lastModified: Date.now() - 3_600_000,
            isHidden: false,
          },
        ],
      },
    }));

    const navigate = jest.fn();
    mount(newQueryClient(), { navigate });

    await waitFor(() => expect(screen.getByTestId('repo-tree-node-src')).toBeTruthy());
    // The child level is NOT fetched until the folder expands.
    expect(
      gateway.requests.find((r) => r.method === 'GET' && r.url === treeUrl('src'))
    ).toBeUndefined();

    fireEvent.press(screen.getByTestId('repo-tree-node-src'));
    await waitFor(() => expect(screen.getByTestId('repo-tree-node-src/index.ts')).toBeTruthy());

    fireEvent.press(screen.getByTestId('repo-tree-node-src/index.ts'));
    expect(navigate).toHaveBeenCalledWith(`/repos/${OWNER}/${REPO}/file/src/index.ts`);
  });

  it('refresh control gives visible feedback and re-fetches the root + expanded folders', async () => {
    gateway.on('GET', treeUrl(), () => ({
      body: {
        contents: [
          { name: 'src', path: 'src', type: 'directory', hasChildren: true, isHidden: false },
        ],
      },
    }));
    gateway.on('GET', treeUrl('src'), () => ({
      body: {
        contents: [
          { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 64, isHidden: false },
        ],
      },
    }));

    mount(newQueryClient());

    // Expand a folder so its level is mounted (a separate useRepoTree instance).
    await waitFor(() => expect(screen.getByTestId('repo-tree-node-src')).toBeTruthy());
    fireEvent.press(screen.getByTestId('repo-tree-node-src'));
    await waitFor(() => expect(screen.getByTestId('repo-tree-node-src/index.ts')).toBeTruthy());

    const rootBefore = gateway.requests.filter(
      (r) => r.method === 'GET' && r.url === treeUrl()
    ).length;
    const childBefore = gateway.requests.filter(
      (r) => r.method === 'GET' && r.url === treeUrl('src')
    ).length;

    // Tapping refresh shows in-progress feedback IMMEDIATELY (AC #1/#2): the
    // in-place activity indicator appears and the control is marked busy — even
    // though the cached refetch returns instantly.
    fireEvent.press(screen.getByTestId('repo-tree-refresh'));
    expect(screen.getByTestId('repo-tree-refreshing')).toBeTruthy();
    expect(screen.getByTestId('repo-tree-refresh').props.accessibilityState?.busy).toBe(true);

    // Both the root tree AND the expanded folder level are re-fetched (AC #3 —
    // the old root-only refetch left subfolders stale).
    await waitFor(() => {
      expect(
        gateway.requests.filter((r) => r.method === 'GET' && r.url === treeUrl()).length
      ).toBeGreaterThan(rootBefore);
      expect(
        gateway.requests.filter((r) => r.method === 'GET' && r.url === treeUrl('src')).length
      ).toBeGreaterThan(childBefore);
    });

    // The feedback clears after the perceptible min-hold + the refetch settles.
    await waitFor(() => expect(screen.queryByTestId('repo-tree-refreshing')).toBeNull(), {
      timeout: 2000,
    });
    expect(screen.getByTestId('repo-tree-refresh').props.accessibilityState?.busy).toBe(false);
    // The list stays rendered throughout (the body never blanks to a spinner on refresh).
    expect(screen.getByTestId('repo-tree-node-src')).toBeTruthy();
  });

  it('shows the Clone-to-Local card for a not-cloned repo and fires the clone', async () => {
    gateway.on('GET', detailsUrl(), () => ({ body: repoDetails({ isLocal: false }) }));
    gateway.on('POST', cloneUrl(), () => ({
      body: { success: true, path: `/workspace/${OWNER}/${REPO}` },
    }));

    const qc = newQueryClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    mount(qc);

    await waitFor(() => expect(screen.getByTestId('repo-overview-clone')).toBeTruthy());
    // The local-only surfaces stay hidden.
    expect(screen.queryByTestId('repo-overview-input')).toBeNull();
    expect(screen.queryByTestId('repo-tree')).toBeNull();
    expect(screen.queryByTestId('repo-overview-git')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-overview-clone'));
    });

    await waitFor(() =>
      expect(gateway.requests.find((r) => r.method === 'POST' && r.url === cloneUrl())).toBeTruthy()
    );

    // Cloning flips this repo's local status, so the repos LIST + the home project
    // dropdown caches must flush too — otherwise the "Cloned" badge / the new
    // local project stay hidden behind the stale cache until an app restart.
    await waitFor(() => {
      const keys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
      expect(keys).toContainEqual(['repos']);
      expect(keys).toContainEqual(['recent-projects']);
    });
  });

  it('renders the homepage link bar when the repo has a homepage', async () => {
    gateway.on('GET', detailsUrl(), () => ({
      body: repoDetails({ homepage: 'https://example.dev' }),
    }));

    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-overview-homepage')).toBeTruthy());
    expect(screen.getByTestId('repo-overview-homepage')).toHaveTextContent(/example\.dev/);
  });

  it('routes the branch chip to the Branches tab (v1 — no dropdown)', async () => {
    mount(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('repo-overview-branch')).toBeTruthy());

    fireEvent.press(screen.getByTestId('repo-overview-branch'));

    expect(screen.getByTestId('repo-active-tab').props.children).toBe('branches');
    await waitFor(() => expect(screen.getByTestId('repo-branches-list')).toBeTruthy());
  });

  it('lists branches with last-commit dates and exposes a comparison action', async () => {
    gateway.on('GET', branchesUrl(1), () => ({
      body: {
        branches: [
          makeBranch('main', '2026-05-01T12:00:00Z'),
          makeBranch('feature/x', '2026-05-10T09:30:00Z'),
        ],
        total_count: 2,
        has_more_pages: false,
      },
    }));

    const onCompareBranch = jest.fn();
    mount(newQueryClient(), { tab: 'branches', onCompareBranch });

    await waitFor(() => expect(screen.getByTestId('repo-branch-main')).toBeTruthy());

    // Last-commit dates are rendered for each branch.
    expect(screen.getByTestId('repo-branch-date-main')).toBeTruthy();
    expect(screen.getByTestId('repo-branch-date-feature/x')).toBeTruthy();

    // The comparison action is exposed and fires with the branch.
    fireEvent.press(screen.getByTestId('repo-branch-compare-feature/x'));
    expect(onCompareBranch).toHaveBeenCalledTimes(1);
    expect(onCompareBranch.mock.calls[0][0].name).toBe('feature/x');
  });

  it('seeds the home chat draft when comparing a branch (default action)', async () => {
    gateway.on('GET', branchesUrl(1), () => ({
      body: {
        branches: [makeBranch('release', '2026-05-05T00:00:00Z')],
        total_count: 1,
        has_more_pages: false,
      },
    }));

    const navigate = jest.fn();
    mount(newQueryClient(), { tab: 'branches', navigate });

    await waitFor(() => expect(screen.getByTestId('repo-branch-release')).toBeTruthy());

    act(() => {
      fireEvent.press(screen.getByTestId('repo-branch-compare-release'));
    });

    // Default action navigates to the chat composer — the Home tab at `/`
    // (bottom-tab navigation) — with the draft seeded in chat-store.
    expect(navigate).toHaveBeenCalledWith('/');
    const { useChatStore } = require('../src/features/state');
    expect(useChatStore.getState().drafts.__home__).toMatch(
      /compare the branch "release" with main/
    );
  });

  // Regression — the "Work on {repo}..." send button must ENABLE as soon as there
  // is text and the socket PROVIDER is mounted; it no longer waits for a live
  // `connect` (the home-composer `!!socket` parity). The SocketProvider below is
  // mounted but NEVER connected, which is exactly the not-yet-connected scenario
  // that used to leave the button permanently disabled even with text to send.
  it('enables the Work-on send button with text even before the socket connects', async () => {
    const inertAppState: AppStateLike = {
      currentState: 'active',
      addEventListener: () => ({ remove: () => {} }),
    };
    const socketNetInfo = { addEventListener: () => () => {} };
    const client = buildClient(gateway);

    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={newQueryClient()} netInfo={onlineNetInfo}>
          <SocketProvider
            getAuthToken={async () => 'good-token'}
            getRelayUrl={async () => SANDBOX_BASE}
            appState={inertAppState}
            netInfo={socketNetInfo}
          >
            <RepoPageScreen owner={OWNER} repo={REPO} navigate={() => {}} />
          </SocketProvider>
        </ApiProvider>
      </SafeAreaProvider>
    );

    // Flush the async socket build (getAuthToken/getRelayUrl) — the socket stays
    // DISCONNECTED (no `connect` event is ever emitted by the mock).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('repo-overview-input')).toBeTruthy());

    // Empty input → the shared short-form widget shows the VOICE mic in the trailing slot
    // (same behavior as the home composer); there is no send button to enable yet.
    expect(screen.getByTestId('repo-overview-voice')).toBeTruthy();
    expect(screen.queryByTestId('repo-overview-send')).toBeNull();

    // Type a message → the slot becomes the Send button, ENABLED, despite the socket never
    // having connected.
    fireEvent.changeText(screen.getByTestId('repo-overview-input'), 'fix the login bug');
    expect(screen.getByTestId('repo-overview-send')).toBeEnabled();
  });
});
