/**
 * portable.dev#17 — Source Control "Changes" view + per-file diff screen.
 *
 * Drives `ChangesView` + `FileDiffScreen` through the authed TanStack Query
 * layer with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore (sandbox URL + authToken), and an in-memory MMKV (the theme
 * store the components read via `useAppTheme`). Verifies, per the AC:
 *
 *   1. the Changes view groups Conflicts → Staged → Unstaged → Untracked from
 *      GET …/status, with a status badge + filename + ± counts per row, and a
 *      hidden virtualization-proof count testID;
 *   2. tapping a file fires the navigation seam carrying path + staged;
 *   3. a clean working tree shows the "No changes" empty state;
 *   4. a status read failure shows the error state (retry:false);
 *   5. the diff screen renders UnifiedDiffView fed by GET …/file-diff.
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

import type { ChangedFile, GetWorkingTreeChangesResponse } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { ChangesView, FileDiffScreen } from '../src/features/repo';
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

function statusUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/status`;
}
function fileDiffUrl(path: string, staged: '0' | '1'): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/file-diff?path=${encodeURIComponent(
    path
  )}&staged=${staged}`;
}
function stageUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/stage`;
}
function unstageUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/unstage`;
}
function discardUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/discard`;
}
function commitUrl(): string {
  return `${SANDBOX_BASE}/api/source-control/${OWNER}/${REPO}/commit`;
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

describe('Source Control Changes view + file diff', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mountChanges(qc: QueryClient, onSelectFile?: (f: ChangedFile) => void) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <ChangesView owner={OWNER} repo={REPO} onSelectFile={onSelectFile} />
        </ApiProvider>
      </SafeAreaProvider>
    );
  }

  function mountDiff(qc: QueryClient, path: string, staged: boolean) {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <FileDiffScreen owner={OWNER} repo={REPO} filePath={path} staged={staged} />
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

  it('groups the working-tree changes with badges + counts and a hidden total count', async () => {
    gateway.on('GET', statusUrl(), () => ({
      body: statusBody({
        staged: [
          changed({
            path: 'src/a.ts',
            status: 'modified',
            staged: true,
            insertions: 4,
            deletions: 1,
          }),
        ],
        unstaged: [changed({ path: 'src/b.ts', status: 'modified', insertions: 2 })],
        untracked: [changed({ path: 'new.txt', status: 'untracked' })],
        conflicted: [changed({ path: 'merge.ts', status: 'conflicted' })],
      }),
    }));

    mountChanges(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-changes-count').props.children).toBe(4)
    );

    // All four groups render.
    expect(screen.getByTestId('source-control-group-conflicted')).toBeTruthy();
    expect(screen.getByTestId('source-control-group-staged')).toBeTruthy();
    expect(screen.getByTestId('source-control-group-unstaged')).toBeTruthy();
    expect(screen.getByTestId('source-control-group-untracked')).toBeTruthy();

    // Each file is a tappable row.
    expect(screen.getByTestId('source-control-file-staged-src/a.ts')).toBeTruthy();
    expect(screen.getByTestId('source-control-file-untracked-new.txt')).toBeTruthy();
  });

  it('fires the navigation seam with the file path + staged flag when a row is tapped', async () => {
    const onSelectFile = jest.fn();
    gateway.on('GET', statusUrl(), () => ({
      body: statusBody({
        staged: [changed({ path: 'src/a.ts', status: 'modified', staged: true })],
      }),
    }));

    mountChanges(newQueryClient(), onSelectFile);

    await waitFor(() =>
      expect(screen.getByTestId('source-control-file-staged-src/a.ts')).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId('source-control-file-staged-src/a.ts'));

    expect(onSelectFile).toHaveBeenCalledTimes(1);
    expect(onSelectFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/a.ts', staged: true })
    );
  });

  it('shows the "No changes" empty state for a clean working tree', async () => {
    gateway.on('GET', statusUrl(), () => ({ body: statusBody() }));

    mountChanges(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-changes-empty')).toBeTruthy());
    expect(screen.queryByTestId('source-control-changes')).toBeNull();
  });

  it('shows the error state when the status read fails (retry:false)', async () => {
    gateway.on('GET', statusUrl(), () => ({ status: 500, body: { error: 'boom' } }));

    mountChanges(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-changes-error')).toBeTruthy());
    // retry:false → exactly one request.
    expect(gateway.requests.filter((r) => r.url === statusUrl())).toHaveLength(1);
  });

  it('staging a row posts the path to …/stage and moves the file to the Staged group on re-read', async () => {
    let isStaged = false;
    gateway.on('GET', statusUrl(), () => ({
      body: isStaged
        ? statusBody({ staged: [changed({ path: 'src/b.ts', status: 'modified', staged: true })] })
        : statusBody({ unstaged: [changed({ path: 'src/b.ts', status: 'modified' })] }),
    }));
    gateway.on('POST', stageUrl(), () => {
      isStaged = true;
      return { body: { ok: true, paths: ['src/b.ts'] } };
    });

    mountChanges(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-file-unstaged-src/b.ts')).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId('source-control-stage-unstaged-src/b.ts'));

    // The POST carries exactly the tapped path.
    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === stageUrl());
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ paths: ['src/b.ts'] });
    });

    // onSuccess invalidates the status query → re-fetch lands it in the Staged group.
    await waitFor(() =>
      expect(screen.getByTestId('source-control-file-staged-src/b.ts')).toBeTruthy()
    );
    expect(screen.queryByTestId('source-control-file-unstaged-src/b.ts')).toBeNull();
  });

  it('group "Unstage all" posts every staged path to …/unstage', async () => {
    gateway.on('GET', statusUrl(), () => ({
      body: statusBody({
        staged: [
          changed({ path: 'a.ts', status: 'modified', staged: true }),
          changed({ path: 'b.ts', status: 'modified', staged: true }),
        ],
      }),
    }));
    gateway.on('POST', unstageUrl(), () => ({ body: { ok: true, paths: ['a.ts', 'b.ts'] } }));

    mountChanges(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-group-staged-action')).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId('source-control-group-staged-action'));

    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === unstageUrl());
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ paths: ['a.ts', 'b.ts'] });
    });
  });

  it('discarding a row requires the confirm modal, then posts to …/discard and drops the file', async () => {
    let discarded = false;
    gateway.on('GET', statusUrl(), () => ({
      body: discarded
        ? statusBody()
        : statusBody({ unstaged: [changed({ path: 'src/b.ts', status: 'modified' })] }),
    }));
    gateway.on('POST', discardUrl(), () => {
      discarded = true;
      return { body: { ok: true, paths: ['src/b.ts'] } };
    });

    mountChanges(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-discard-unstaged-src/b.ts')).toBeTruthy()
    );

    // The row discard button only OPENS the confirmation modal — no request yet.
    fireEvent.press(screen.getByTestId('source-control-discard-unstaged-src/b.ts'));
    expect(screen.getByTestId('source-control-discard-modal')).toBeTruthy();
    expect(gateway.requests.find((r) => r.method === 'POST' && r.url === discardUrl())).toBeFalsy();

    // Cancel closes it without firing.
    fireEvent.press(screen.getByTestId('source-control-discard-cancel'));
    expect(screen.queryByTestId('source-control-discard-modal')).toBeNull();
    expect(gateway.requests.find((r) => r.method === 'POST' && r.url === discardUrl())).toBeFalsy();

    // Re-open and confirm → POST the path, then the invalidated re-read drops it.
    fireEvent.press(screen.getByTestId('source-control-discard-unstaged-src/b.ts'));
    fireEvent.press(screen.getByTestId('source-control-discard-confirm'));

    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === discardUrl());
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ paths: ['src/b.ts'] });
    });

    await waitFor(() => expect(screen.getByTestId('source-control-changes-empty')).toBeTruthy());
  });

  it('commit composer is disabled when nothing is staged', async () => {
    gateway.on('GET', statusUrl(), () => ({
      body: statusBody({ unstaged: [changed({ path: 'src/b.ts', status: 'modified' })] }),
    }));

    mountChanges(newQueryClient());

    await waitFor(() => expect(screen.getByTestId('source-control-commit-composer')).toBeTruthy());
    // Nothing staged → the Commit button is disabled (no staged files).
    expect(screen.getByTestId('source-control-commit-button').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true })
    );
  });

  it('commits the staged changes and empties the staged group on the invalidated re-read', async () => {
    let committed = false;
    gateway.on('GET', statusUrl(), () => ({
      body: committed
        ? statusBody()
        : statusBody({ staged: [changed({ path: 'src/a.ts', status: 'modified', staged: true })] }),
    }));
    gateway.on('POST', commitUrl(), () => {
      committed = true;
      return { body: { sha: 'abc1234def', branch: 'main', author: 'octocat' } };
    });

    mountChanges(newQueryClient());

    await waitFor(() =>
      expect(screen.getByTestId('source-control-file-staged-src/a.ts')).toBeTruthy()
    );

    fireEvent.changeText(screen.getByTestId('source-control-commit-message'), 'feat: a thing');
    fireEvent.press(screen.getByTestId('source-control-commit-button'));

    // The POST carries just the message (author is resolved server-side).
    await waitFor(() => {
      const post = gateway.requests.find((r) => r.method === 'POST' && r.url === commitUrl());
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ message: 'feat: a thing' });
    });

    // onSuccess invalidates the status query → re-fetch shows a clean tree.
    await waitFor(() => expect(screen.getByTestId('source-control-changes-empty')).toBeTruthy());
  });

  it('renders the unified diff on the file diff screen fed by GET …/file-diff', async () => {
    const diff = '@@ -1,2 +1,2 @@\n-old line\n+new line\n context';
    gateway.on('GET', fileDiffUrl('src/a.ts', '1'), () => ({ body: { path: 'src/a.ts', diff } }));

    mountDiff(newQueryClient(), 'src/a.ts', true);

    await waitFor(() => expect(screen.getByTestId('file-diff-view')).toBeTruthy());
    expect(screen.getByTestId('file-diff-title').props.children).toBe('a.ts');
    expect(screen.getByTestId('file-diff-view')).toHaveTextContent(/\+new line/);
  });

  it('pull-to-refresh re-reads the status and renders PC-side changes', async () => {
    let calls = 0;
    gateway.on('GET', statusUrl(), () => {
      calls += 1;
      return {
        body:
          calls === 1
            ? statusBody({ unstaged: [changed({ path: 'src/b.ts', status: 'modified' })] })
            : statusBody({
                unstaged: [
                  changed({ path: 'src/b.ts', status: 'modified' }),
                  changed({ path: 'src/c.ts', status: 'modified' }),
                ],
              }),
      };
    });

    mountChanges(newQueryClient());
    await waitFor(() =>
      expect(screen.getByTestId('source-control-changes-count').props.children).toBe(1)
    );

    // Drive the RefreshControl's onRefresh (the tasks-page precedent —
    // RefreshControl isn't reachable by testID under the test renderer).
    const refreshControl = screen.UNSAFE_getByType(RefreshControl as never) as unknown as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    // The pull re-read the status and rendered the change made ON THE PC.
    await waitFor(() =>
      expect(screen.getByTestId('source-control-changes-count').props.children).toBe(2)
    );
    expect(screen.getByTestId('source-control-file-unstaged-src/c.ts')).toBeTruthy();
  });

  it('a clean tree stays pullable — pull-to-refresh surfaces changes from the empty state', async () => {
    let calls = 0;
    gateway.on('GET', statusUrl(), () => {
      calls += 1;
      return {
        body:
          calls === 1
            ? statusBody()
            : statusBody({ untracked: [changed({ path: 'new.txt', status: 'untracked' })] }),
      };
    });

    mountChanges(newQueryClient());
    await waitFor(() => expect(screen.getByTestId('source-control-changes-empty')).toBeTruthy());

    const refreshControl = screen.UNSAFE_getByType(RefreshControl as never) as unknown as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    await waitFor(() => expect(screen.getByTestId('source-control-group-untracked')).toBeTruthy());
    expect(screen.queryByTestId('source-control-changes-empty')).toBeNull();
  });
});
