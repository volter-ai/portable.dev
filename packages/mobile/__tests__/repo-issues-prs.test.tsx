/**
 * Issues & Pull Requests (RepoPage tabs).
 *
 * Drives the Issues and Pull Requests tabs through the authed TanStack Query
 * layer with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore (sandbox URL + authToken), and an in-memory MMKV. Verifies, per
 * the story's acceptance criteria:
 *
 *   1. the Issues list renders and the open/closed filter narrows it;
 *   2. an issue detail renders its comments and posts a new comment via
 *      `POST .../issues/:number/comments`;
 *   3. assignee add/remove fire the correct mutations
 *      (`PUT`/`DELETE .../issues/:number/assignees`);
 *   4. the Pull Requests list opens a PR detail.
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

import type { GitHubUser, Issue, PullRequest } from '@vgit2/shared/types';

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

function issuesUrl(state: 'open' | 'closed', page = 1): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/issues?state=${state}&page=${page}&per_page=20`;
}
function issueDetailUrl(n: number): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/issues/${n}`;
}
function commentsUrl(n: number): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/issues/${n}/comments`;
}
function assigneesUrl(n: number): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/issues/${n}/assignees`;
}
function labelsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/labels`;
}
function collaboratorsUrl(): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/collaborators`;
}
/** A filtered issues request (default open) with extra query params appended. */
function filteredIssuesUrl(extra: string, state: 'open' | 'closed' = 'open'): string {
  return `${issuesUrl(state)}&${extra}`;
}
function pullsUrl(state: 'open' | 'closed', page = 1): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/pulls?state=${state}&page=${page}&per_page=20`;
}
function pullDetailUrl(n: number): string {
  return `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/pulls/${n}`;
}

function makeUser(login: string): GitHubUser {
  return {
    login,
    id: login.length,
    avatar_url: '',
    html_url: '',
    type: 'User',
  };
}

function makeIssue(number: number, title: string, state: 'open' | 'closed' = 'open'): Issue {
  return {
    id: number * 100,
    number,
    title,
    state,
    user: makeUser('reporter'),
    labels: [],
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    closed_at: null,
    body: `Body of #${number}`,
    html_url: '',
  };
}

function makePull(number: number, title: string): PullRequest {
  return {
    id: number * 100,
    number,
    title,
    state: 'open',
    user: makeUser('contributor'),
    labels: [],
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    closed_at: null,
    merged_at: null,
    body: `PR body #${number}`,
    html_url: '',
    head: { ref: 'feature/x', sha: 'aaa', repo: null },
    base: { ref: 'main', sha: 'bbb', repo: null as never },
    draft: false,
  };
}

describe('Issues & Pull Requests', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  function mount(qc: QueryClient, tab: 'issues' | 'prs') {
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

  it('lists issues and the open/closed filter narrows the list', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: {
        issues: [makeIssue(1, 'First bug'), makeIssue(2, 'Second bug')],
        total_count: 2,
        has_more_pages: false,
      },
    }));
    gateway.on('GET', issuesUrl('closed'), () => ({
      body: {
        issues: [makeIssue(3, 'Fixed bug', 'closed')],
        total_count: 1,
        has_more_pages: false,
      },
    }));

    mount(newQueryClient(), 'issues');

    // Open issues (default filter) — two of them.
    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());
    expect(screen.getByTestId('repo-issues-count').props.children).toBe(2);

    // Toggling to "closed" narrows the list to one.
    fireEvent.press(screen.getByTestId('repo-issues-filter-closed'));
    await waitFor(() => expect(screen.getByTestId('repo-issues-count').props.children).toBe(1));
    expect(screen.getByTestId('repo-issue-open-3')).toBeTruthy();
    expect(screen.queryByTestId('repo-issue-open-1')).toBeNull();
  });

  it('opens an issue detail, renders comments, and posts a new comment', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', issueDetailUrl(1), () => ({
      body: {
        issue: makeIssue(1, 'First bug'),
        timeline: [
          {
            id: 555,
            event: 'commented',
            body: 'I can reproduce this.',
            user: makeUser('alice'),
            created_at: '2026-05-02T00:00:00Z',
          },
          { id: 1, event: 'labeled' },
        ],
      },
    }));
    gateway.on('POST', commentsUrl(1), () => ({ body: { success: true, comment: { id: 999 } } }));

    mount(newQueryClient(), 'issues');

    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('repo-issue-open-1'));

    // Detail renders the existing comment (labeled events are filtered out).
    await waitFor(() => expect(screen.getByTestId('repo-issue-comment-555')).toBeTruthy());
    expect(screen.getByTestId('repo-issue-comments-count').props.children).toBe(1);

    // Post a new comment.
    fireEvent.changeText(screen.getByTestId('repo-issue-comment-input'), 'Looks good!');
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-issue-comment-submit'));
    });

    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'POST' && r.url === commentsUrl(1))
      ).toBeTruthy()
    );
    const post = gateway.requests.find((r) => r.method === 'POST' && r.url === commentsUrl(1));
    expect(post?.body).toEqual({ body: 'Looks good!' });
  });

  it('fires the correct mutations for assignee add and remove', async () => {
    const assigned = makeIssue(1, 'First bug');
    assigned.assignees = [makeUser('octocat')];

    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', issueDetailUrl(1), () => ({ body: { issue: assigned, timeline: [] } }));
    gateway.on('PUT', assigneesUrl(1), () => ({ body: assigned }));
    gateway.on('DELETE', assigneesUrl(1), () => ({ body: makeIssue(1, 'First bug') }));

    mount(newQueryClient(), 'issues');

    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('repo-issue-open-1'));

    // The current assignee renders with a remove control.
    await waitFor(() => expect(screen.getByTestId('repo-issue-assignee-octocat')).toBeTruthy());

    // Add a new assignee → PUT .../assignees { assignees: ['newdev'] }.
    fireEvent.changeText(screen.getByTestId('repo-issue-assignee-input'), 'newdev');
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-issue-assignee-add'));
    });
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'PUT' && r.url === assigneesUrl(1))
      ).toBeTruthy()
    );
    const put = gateway.requests.find((r) => r.method === 'PUT' && r.url === assigneesUrl(1));
    expect(put?.body).toEqual({ assignees: ['newdev'] });

    // Remove the current assignee → DELETE .../assignees { assignees: ['octocat'] }.
    await act(async () => {
      fireEvent.press(screen.getByTestId('repo-issue-assignee-remove-octocat'));
    });
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.method === 'DELETE' && r.url === assigneesUrl(1))
      ).toBeTruthy()
    );
    const del = gateway.requests.find((r) => r.method === 'DELETE' && r.url === assigneesUrl(1));
    expect(del?.body).toEqual({ assignees: ['octocat'] });
  });

  // ── GitHub-style filter bar (labels, assignees, search, sort) ──────

  it('filters by label via the label dropdown and shows a dismissible pill', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', labelsUrl(), () => ({
      body: {
        labels: [
          { id: 1, name: 'bug', color: 'd73a4a', description: null },
          { id: 2, name: 'enhancement', color: 'a2eeef', description: null },
        ],
      },
    }));
    gateway.on('GET', filteredIssuesUrl('labels=bug'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));

    mount(newQueryClient(), 'issues');
    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());

    // Open the label sheet — its options come from the new /labels endpoint.
    fireEvent.press(screen.getByTestId('repo-issues-filter-label'));
    await waitFor(() => expect(screen.getByTestId('repo-issues-label-option-bug')).toBeTruthy());

    // Toggle "bug" and close the sheet → the list refetches with labels=bug.
    fireEvent.press(screen.getByTestId('repo-issues-label-option-bug'));
    fireEvent.press(screen.getByTestId('repo-issues-label-done'));

    await waitFor(() =>
      expect(gateway.requests.find((r) => r.url === filteredIssuesUrl('labels=bug'))).toBeTruthy()
    );
    expect(screen.getByTestId('repo-issues-pill-label-bug')).toBeTruthy();

    // The pill is dismissible.
    fireEvent.press(screen.getByTestId('repo-issues-pill-label-bug'));
    expect(screen.queryByTestId('repo-issues-pill-label-bug')).toBeNull();
  });

  it('filters by assignee via the assignee dropdown (collaborators)', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', collaboratorsUrl(), () => ({
      body: {
        team_members: [
          { name: 'Octo Cat', username: 'octocat' },
          { name: '', username: 'devbot' },
        ],
      },
    }));
    gateway.on('GET', filteredIssuesUrl('assignee=octocat'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));

    mount(newQueryClient(), 'issues');
    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('repo-issues-filter-assignee'));
    await waitFor(() =>
      expect(screen.getByTestId('repo-issues-assignee-option-octocat')).toBeTruthy()
    );
    fireEvent.press(screen.getByTestId('repo-issues-assignee-option-octocat'));

    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.url === filteredIssuesUrl('assignee=octocat'))
      ).toBeTruthy()
    );
    expect(screen.getByTestId('repo-issues-pill-assignee')).toBeTruthy();
  });

  it('sorts issues via the sort dropdown (oldest → sort=created&direction=asc)', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', filteredIssuesUrl('sort=created&direction=asc'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));

    mount(newQueryClient(), 'issues');
    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('repo-issues-filter-sort'));
    await waitFor(() => expect(screen.getByTestId('repo-issues-sort-option-oldest')).toBeTruthy());
    fireEvent.press(screen.getByTestId('repo-issues-sort-option-oldest'));

    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.url === filteredIssuesUrl('sort=created&direction=asc'))
      ).toBeTruthy()
    );
    expect(screen.getByTestId('repo-issues-pill-sort')).toBeTruthy();
  });

  it('searches issues by title (debounced) via the text param', async () => {
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));
    gateway.on('GET', filteredIssuesUrl('text=crash'), () => ({
      body: { issues: [makeIssue(1, 'First bug')], total_count: 1, has_more_pages: false },
    }));

    mount(newQueryClient(), 'issues');
    await waitFor(() => expect(screen.getByTestId('repo-issue-open-1')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('repo-issues-search'), 'crash');

    await waitFor(
      () =>
        expect(
          gateway.requests.find((r) => r.url === filteredIssuesUrl('text=crash'))
        ).toBeTruthy(),
      { timeout: 3000 }
    );
    expect(screen.getByTestId('repo-issues-pill-text')).toBeTruthy();
  });

  it('renders label color-dots and assignee avatars on issue rows', async () => {
    const labeled = makeIssue(1, 'First bug');
    labeled.labels = [{ id: 1, name: 'bug', color: 'd73a4a', description: null }];
    labeled.assignees = [
      {
        login: 'octocat',
        id: 1,
        avatar_url: 'https://example.com/octo.png',
        html_url: '',
        type: 'User',
      },
    ];
    gateway.on('GET', issuesUrl('open'), () => ({
      body: { issues: [labeled], total_count: 1, has_more_pages: false },
    }));

    mount(newQueryClient(), 'issues');

    await waitFor(() => expect(screen.getByTestId('repo-issue-label-1-bug')).toBeTruthy());
    expect(screen.getByTestId('repo-issue-assignee-avatar-1-octocat')).toBeTruthy();
  });

  it('lists pull requests and opens a PR detail', async () => {
    gateway.on('GET', pullsUrl('open'), () => ({
      body: {
        pulls: [makePull(7, 'Add feature'), makePull(8, 'Fix bug')],
        totalCount: 2,
        hasMore: false,
        canCreatePR: false,
        commitsAhead: 0,
        currentBranch: 'main',
        defaultBranch: 'main',
        upstreamBranch: null,
      },
    }));
    gateway.on('GET', pullDetailUrl(7), () => ({
      body: {
        pr: makePull(7, 'Add feature'),
        timeline: [
          {
            id: 42,
            event: 'commented',
            body: 'Nice work!',
            user: makeUser('reviewer'),
            created_at: '2026-05-03T00:00:00Z',
          },
        ],
        files: [{ filename: 'src/app.ts', status: 'modified', additions: 10, deletions: 2 }],
      },
    }));

    mount(newQueryClient(), 'prs');

    await waitFor(() => expect(screen.getByTestId('repo-pr-open-7')).toBeTruthy());
    expect(screen.getByTestId('repo-prs-count').props.children).toBe(2);

    fireEvent.press(screen.getByTestId('repo-pr-open-7'));

    await waitFor(() => expect(screen.getByTestId('repo-pr-detail-title')).toBeTruthy());
    expect(screen.getByTestId('repo-pr-detail-title').props.children).toContain('Add feature');
    expect(screen.getByTestId('repo-pr-comment-42')).toBeTruthy();
    expect(screen.getByTestId('repo-pr-file-src/app.ts')).toBeTruthy();
  });
});
