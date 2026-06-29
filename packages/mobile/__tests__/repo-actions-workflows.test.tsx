/**
 * Actions & Workflows (RepoPage tabs).
 *
 * Drives the Actions and Workflows tabs through the authed TanStack Query layer
 * with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore (sandbox URL + authToken), and an in-memory MMKV. Verifies, per
 * the story's acceptance criteria:
 *
 *   1. the Actions tab lists workflow runs and opens a workflow-run detail
 *      showing logs (job steps), status, and timing;
 *   2. the Workflows tab lists workflow files and exposes view + create/update/
 *      delete (where supported).
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

// react-native-mmkv backs the chat-store (transitively imported by the screen).
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

// The Overview tab (transitively imported by the screen) renders Markdown.
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

import type { WorkflowRun } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { RepoPageScreen } from '../src/features/repo';
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

function runsUrl(page = 1): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/actions/runs?page=${page}&per_page=20`;
}
function runDetailUrl(id: number): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/actions/runs/${id}`;
}
function workflowsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/workflows`;
}
function workflowFileUrl(path: string): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/workflows/file?path=${encodeURIComponent(path)}`;
}
function workflowFileBaseUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/workflows/file`;
}

function makeRun(id: number, name: string): WorkflowRun {
  return {
    id,
    name,
    head_branch: 'main',
    head_sha: 'abc123',
    status: 'completed',
    conclusion: 'success',
    workflow_id: 100,
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:05:00Z',
    run_number: id,
    event: 'push',
    html_url: '',
    display_title: name,
  };
}

describe('Actions & Workflows', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(qc: QueryClient, tab: 'actions' | 'workflows') {
    const client = buildClient(gateway);
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <RepoPageScreen owner={OWNER} repo={REPO} tab={tab} navigate={() => {}} />
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

  it('lists workflow runs and opens a run detail with logs/status/timing', async () => {
    gateway.on('GET', runsUrl(), () => ({
      body: {
        runs: [makeRun(1, 'CI'), makeRun(2, 'Deploy')],
        total_count: 2,
        has_more_pages: false,
      },
    }));
    gateway.on('GET', runDetailUrl(1), () => ({
      body: {
        run: makeRun(1, 'CI'),
        jobs: [
          {
            id: 71,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-05-01T10:00:30Z',
            completed_at: '2026-05-01T10:04:00Z',
            html_url: '',
            steps: [
              {
                name: 'Checkout',
                status: 'completed',
                conclusion: 'success',
                number: 1,
                started_at: '2026-05-01T10:00:31Z',
                completed_at: '2026-05-01T10:00:35Z',
              },
              {
                name: 'Run tests',
                status: 'completed',
                conclusion: 'success',
                number: 2,
                started_at: '2026-05-01T10:00:36Z',
                completed_at: '2026-05-01T10:04:00Z',
              },
            ],
          },
        ],
      },
    }));

    mount(newQueryClient(), 'actions');

    // The list renders both runs.
    await waitFor(() => expect(screen.getByTestId('repo-action-open-1')).toBeTruthy());
    expect(screen.getByTestId('repo-actions-count').props.children).toBe(2);

    // Open the run detail — status, timing, and the job step "logs".
    fireEvent.press(screen.getByTestId('repo-action-open-1'));

    await waitFor(() => expect(screen.getByTestId('repo-action-detail-title')).toBeTruthy());
    expect(screen.getByTestId('repo-action-detail-status')).toBeTruthy();
    expect(screen.getByTestId('repo-action-detail-timing')).toBeTruthy();
    expect(screen.getByTestId('repo-action-jobs-count').props.children).toBe(1);
    expect(screen.getByTestId('repo-action-job-71')).toBeTruthy();
    expect(screen.getByTestId('repo-action-job-timing-71')).toBeTruthy();
    // Step breakdown (the run's logs).
    expect(screen.getByTestId('repo-action-step-71-1')).toBeTruthy();
    expect(screen.getByTestId('repo-action-step-71-2')).toBeTruthy();
  });

  it('lists workflow files and supports view, create, update, and delete', async () => {
    const WF_PATH = '.github/workflows/ci.yml';
    gateway.on('GET', workflowsUrl(), () => ({
      body: {
        total_count: 1,
        workflows: [{ id: 9, name: 'CI', path: WF_PATH, state: 'active' }],
      },
    }));
    gateway.on('GET', workflowFileUrl(WF_PATH), () => ({
      body: { content: 'name: CI\non: [push]\n', sha: 'sha-1', path: WF_PATH },
    }));
    gateway.on('POST', workflowFileBaseUrl(), () => ({ body: { commit: { sha: 'new' } } }));
    gateway.on('PUT', workflowFileBaseUrl(), () => ({ body: { commit: { sha: 'upd' } } }));
    gateway.on('DELETE', workflowFileBaseUrl(), () => ({ body: { commit: { sha: 'del' } } }));

    mount(newQueryClient(), 'workflows');

    // The list renders the workflow file.
    await waitFor(() => expect(screen.getByTestId('repo-workflow-open-9')).toBeTruthy());
    expect(screen.getByTestId('repo-workflows-count').props.children).toBe(1);

    // --- VIEW: open the file → its content loads into the editor.
    fireEvent.press(screen.getByTestId('repo-workflow-open-9'));
    await waitFor(() => expect(screen.getByTestId('repo-workflow-file-content')).toBeTruthy());
    expect(screen.getByTestId('repo-workflow-file-content').props.value).toContain('name: CI');

    // --- UPDATE: edit content → save → PUT .../workflows/file { path, content, sha }.
    fireEvent.changeText(
      screen.getByTestId('repo-workflow-file-content'),
      'name: CI\non: [push, pull_request]\n'
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-workflow-file-update'));
    });
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'PUT' && r.url === workflowFileBaseUrl())
      ).toBeTruthy()
    );
    const put = gateway.requests.find((r) => r.method === 'PUT' && r.url === workflowFileBaseUrl());
    expect(put?.body).toEqual({
      path: WF_PATH,
      content: 'name: CI\non: [push, pull_request]\n',
      sha: 'sha-1',
    });

    // --- DELETE: delete the viewed file → DELETE .../workflows/file { path, sha }.
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-workflow-file-delete'));
    });
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'DELETE' && r.url === workflowFileBaseUrl())
      ).toBeTruthy()
    );
    const del = gateway.requests.find(
      (r) => r.method === 'DELETE' && r.url === workflowFileBaseUrl()
    );
    expect(del?.body).toEqual({ path: WF_PATH, sha: 'sha-1' });

    // Deleting returns to the list.
    await waitFor(() => expect(screen.getByTestId('repo-workflows-list')).toBeTruthy());

    // --- CREATE: open the new-workflow form → fill + submit → POST .../workflows/file.
    fireEvent.press(screen.getByTestId('repo-workflows-new'));
    await waitFor(() => expect(screen.getByTestId('repo-workflow-create-path')).toBeTruthy());
    fireEvent.changeText(
      screen.getByTestId('repo-workflow-create-path'),
      '.github/workflows/release.yml'
    );
    fireEvent.changeText(screen.getByTestId('repo-workflow-create-content'), 'name: Release\n');
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-workflow-create-submit'));
    });
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'POST' && r.url === workflowFileBaseUrl())
      ).toBeTruthy()
    );
    const post = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === workflowFileBaseUrl()
    );
    expect(post?.body).toEqual({
      path: '.github/workflows/release.yml',
      content: 'name: Release\n',
    });
  });
});
