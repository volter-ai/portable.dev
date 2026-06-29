/**
 * Tasks page — integration tests for the native `TasksScreen`
 * + unit tests for the pure grouping helpers.
 *
 * Mounts the screen via `renderRouter` (the chat-directory precedent — the
 * ViewModel's `useFocusEffect` re-focus refresh needs a real navigation
 * context) under `SafeAreaProvider` + `ApiProvider` (mock-gateway
 * `RelayApiClient`); `openUrl` is the injected navigation seam and `now` is
 * pinned so the Done-Today midnight window is deterministic. Endpoints are
 * registered by FULL URL on `createMockGateway`:
 *
 *   GET {sandbox}/api/user/tasks/cached?view=my|all   (cached-first load)
 *   GET {sandbox}/api/user/tasks/refresh?view=my|all  (background refresh)
 *
 * Covered behaviors: cached→refresh replacement, the In Review PR→issue
 * resolution (linked issue + related-PR chip vs PR-as-issue rows) + the
 * PR-count header, Todo exclusions (linked + backlog), the owner/backlog/
 * state/repo/assignee/label(AND) filter chain (incl. the
 * Done-Today-needs-state-filter quirk and the no-`full_name` repo-filter
 * pass-through), Clear-all preserving owner+backlog, the instant my↔all
 * switch, pull-to-refresh, and the error+retry path. (Re-focus refresh is
 * covered end-to-end in tab-navigation.test.tsx, where real tab switches
 * exist.)
 */

// ── Native-module mocks (hoisted above imports) ──────────────────────────────
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? (store.get(k) as string) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

// useAppTheme → themeStore → MMKV at import (the documented theme gotcha).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => (store.has(k) ? store.get(k) : undefined),
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) },
}));

// The item viewer pulls the socket barrel (useViewerChat → socket.io-client at
// module scope) and MarkdownText (react-native-markdown-display) — both must be
// mocked wherever the tasks feature is in the import graph (documented pattern).
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { RefreshControl } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  applyIssueFilters,
  applyPrFilters,
  buildInReview,
  deriveFilterOptions,
  filterDoneToday,
  formatTimeAgo,
  getContrastColor,
  getPriority,
  groupTasks,
  repoKeyOf,
  DEFAULT_TASK_FILTERS,
  TasksScreen,
  type TaskIssue,
  type TaskPr,
  type TasksResponse,
} from '../src/features/tasks';
import {
  issueChatPrompt,
  issueChatTitle,
  quickFixPrompt,
  quickMergePrompt,
  reviewPrPrompt,
} from '../src/features/tasks/viewer/viewerPrompts';
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
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

const tasksUrl = (kind: 'cached' | 'refresh', view: 'my' | 'all') =>
  `${SANDBOX_BASE}/api/user/tasks/${kind}?view=${view}`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ADA = { login: 'ada', avatar_url: 'https://github.com/ada.png' };
/** Pinned clock: fixtures AND the injected `now` seam share this instant, so the
 * device-local Done-Today midnight window can't flip mid-suite. */
const FIXED_NOW = Date.now();
const NOW_ISO = new Date(FIXED_NOW).toISOString();

function repoRef(owner: string, name: string) {
  return { full_name: `${owner}/${name}`, owner: { login: owner }, name };
}
function repoUrl(owner: string, name: string) {
  return `https://api.github.com/repos/${owner}/${name}`;
}

function issue(partial: Partial<TaskIssue> & { number: number }): TaskIssue {
  return {
    id: partial.number,
    title: `Issue ${partial.number}`,
    state: 'open',
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: null,
    html_url: `https://github.com/acme/widget/issues/${partial.number}`,
    comments: 0,
    labels: [],
    assignees: [],
    user: null,
    repository: repoRef('acme', 'widget'),
    repository_url: repoUrl('acme', 'widget'),
    ...partial,
  };
}

const issueAssigned = issue({
  number: 1,
  title: 'Fix the widget crash',
  assignees: [ADA],
  labels: [{ name: 'bug', color: 'd73a4a' }],
  comments: 2,
});
const issueAuthored = issue({
  number: 2,
  title: 'Improve the landing copy',
  user: ADA,
  repository: repoRef('beta', 'site'),
  repository_url: repoUrl('beta', 'site'),
  html_url: 'https://github.com/beta/site/issues/2',
});
const issueBacklog = issue({
  number: 3,
  title: 'Someday refactor',
  assignees: [ADA],
  labels: [{ name: 'backlog', color: 'ededed' }],
});
const issueLinked = issue({
  number: 4,
  title: 'Widget needs a fix',
  assignees: [ADA],
  html_url: 'https://github.com/acme/widget/issues/4',
});
const issueDoneToday = issue({
  number: 5,
  title: 'Shipped fix',
  state: 'closed',
  closed_at: NOW_ISO,
  assignees: [ADA],
});

const pr99: TaskPr = {
  id: 99,
  number: 99,
  title: 'Fix widget crash for good',
  state: 'open',
  draft: true,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  html_url: 'https://github.com/acme/widget/pull/99',
  comments: 1,
  labels: [],
  user: { login: 'bob', avatar_url: 'https://github.com/bob.png' },
  assignees: [],
  reviewers: [],
  base: {
    ref: 'main',
    repo: { nameWithOwner: 'acme/widget', name: 'widget', owner: { login: 'acme' } },
  },
  repository_url: repoUrl('acme', 'widget'),
  linked_issue_numbers: [4],
};
const pr50: TaskPr = {
  id: 50,
  number: 50,
  title: 'New landing page',
  state: 'open',
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  html_url: 'https://github.com/beta/site/pull/50',
  comments: 0,
  labels: [],
  user: { login: 'bob', avatar_url: 'https://github.com/bob.png' },
  assignees: [],
  reviewers: [],
  base: {
    ref: 'main',
    repo: { nameWithOwner: 'beta/site', name: 'site', owner: { login: 'beta' } },
  },
  repository_url: repoUrl('beta', 'site'),
  linked_issue_numbers: [],
};

function myResponse(overrides: Partial<TasksResponse> = {}): TasksResponse {
  return {
    open_issues: [issueAssigned, issueAuthored, issueBacklog, issueLinked],
    closed_today: [issueDoneToday],
    prs: [pr99, pr50],
    total_open: 4,
    total_closed_today: 1,
    total_prs: 2,
    user: ADA,
    view: 'my',
    cached: false,
    cacheTimestamp: Date.now(),
    ...overrides,
  };
}

function allResponse(overrides: Partial<TasksResponse> = {}): TasksResponse {
  return {
    open_issues: [
      issueAssigned,
      issue({ number: 7, title: 'Unassigned chore', assignees: [] }),
      issue({ number: 8, title: 'Carol task', assignees: [{ login: 'carol' }] }),
    ],
    closed_today: [],
    prs: [],
    total_open: 3,
    total_closed_today: 0,
    total_prs: 0,
    user: ADA,
    view: 'all',
    cached: false,
    cacheTimestamp: Date.now(),
    ...overrides,
  };
}

/** Register happy-path handlers for all four endpoints. */
function registerHappyPath(
  gateway: MockGateway,
  bodies: {
    cachedMy?: TasksResponse;
    refreshMy?: TasksResponse;
    cachedAll?: TasksResponse;
    refreshAll?: TasksResponse;
  } = {}
) {
  gateway.on('GET', tasksUrl('cached', 'my'), () => ({
    body: bodies.cachedMy ?? myResponse({ cached: true }),
  }));
  gateway.on('GET', tasksUrl('refresh', 'my'), () => ({ body: bodies.refreshMy ?? myResponse() }));
  gateway.on('GET', tasksUrl('cached', 'all'), () => ({
    body: bodies.cachedAll ?? allResponse({ cached: true }),
  }));
  gateway.on('GET', tasksUrl('refresh', 'all'), () => ({
    body: bodies.refreshAll ?? allResponse(),
  }));
}

describe('TasksScreen', () => {
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

  function renderTasks(
    openUrl: jest.Mock = jest.fn(),
    extraProps: Partial<Parameters<typeof TasksScreen>[0]> = {}
  ) {
    const gwClient = new GatewayClient({
      gatewayUrl: gateway.baseUrl,
      fetchImpl: gateway.fetchImpl,
    });
    const client = new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
    queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const qc = queryClient;

    // Real router context (chat-directory precedent): the ViewModel's
    // useFocusEffect needs a navigator above it.
    function ProvidersLayout() {
      return (
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
            <Slot />
          </ApiProvider>
        </SafeAreaProvider>
      );
    }
    const TasksRoute = () => (
      <TasksScreen openUrl={openUrl} now={() => FIXED_NOW} {...extraProps} />
    );
    renderRouter({ _layout: ProvidersLayout, index: TasksRoute }, { initialUrl: '/' });
    return openUrl;
  }

  /** Wait until the initial cached load + the auto background refresh settled. */
  async function settle() {
    await screen.findByTestId('task-group-in-review');
    await waitFor(() => {
      const refreshes = gateway.requests.filter((r) => r.url.includes('/api/user/tasks/refresh'));
      expect(refreshes.length).toBeGreaterThanOrEqual(2);
    });
  }

  it('loads both views cached-first, kicks a background refresh, and renders the groups', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    // Both views were fetched in parallel, Bearer-only.
    const urls = gateway.requests.map((r) => r.url);
    expect(urls).toContain(tasksUrl('cached', 'my'));
    expect(urls).toContain(tasksUrl('cached', 'all'));
    expect(urls).toContain(tasksUrl('refresh', 'my'));
    expect(urls).toContain(tasksUrl('refresh', 'all'));
    const first = gateway.requests.find((r) => r.url === tasksUrl('cached', 'my'));
    expect(first?.headers.Authorization ?? first?.headers.authorization).toBe('Bearer good-token');
    expect(first?.credentials).toBe('omit');

    // my view: In Review (linked issue + PR row) + Todo (assigned + authored).
    // Done Today is EMPTY under the default state=open filter (quirk:
    // applyFilters runs on closed_today too) and backlog is hidden.
    expect(screen.getByTestId('tasks-count').props.children).toBe(4);
    expect(screen.getByTestId('task-group-in-review')).toBeTruthy();
    expect(screen.getByTestId('task-group-todo')).toBeTruthy();
    expect(screen.queryByTestId('task-group-done')).toBeNull();
    expect(screen.getByTestId('task-item-todo-acme/widget#1')).toBeTruthy();
    expect(screen.getByTestId('task-item-todo-beta/site#2')).toBeTruthy();
    expect(screen.queryByTestId('task-item-todo-acme/widget#3')).toBeNull(); // backlog
    expect(screen.queryByTestId('task-item-todo-acme/widget#4')).toBeNull(); // linked → In Review
  });

  it('replaces cached data with the background refresh result (and drops the Cached badge)', async () => {
    const extra = issue({ number: 9, title: 'Fresh from refresh', assignees: [ADA] });
    registerHappyPath(gateway, {
      cachedMy: myResponse({ cached: true }),
      refreshMy: myResponse({ open_issues: [issueAssigned, issueAuthored, extra] }),
    });
    renderTasks();

    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-acme/widget#9')).toBeTruthy();
    });
    // Refresh payload carries cached:false → no badge after it lands.
    expect(screen.queryByTestId('tasks-cached-badge')).toBeNull();
  });

  it('In Review rows open the right viewer: linked issue → issue viewer, chip/PR row → PR viewer', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/4`, () => ({
      body: { issue: { ...issueLinked, body: 'body' }, timeline: [] },
    }));
    const openUrl = renderTasks();
    await settle();

    // Linked issue #4 renders as the ISSUE with the PR chip — tap → issue viewer.
    fireEvent.press(screen.getByTestId('task-item-review-acme/widget#4'));
    expect(await screen.findByTestId('issue-viewer')).toBeTruthy();
    expect(screen.getByTestId('issue-viewer-title')).toHaveTextContent('Widget needs a fix');
    await act(async () => {
      fireEvent.press(screen.getByTestId('issue-viewer-dismiss'));
    });
    await waitFor(() => expect(screen.queryByTestId('issue-viewer')).toBeNull());

    // The related-PR chip opens the PR viewer (owner/repo parsed from the url).
    fireEvent.press(screen.getByTestId('task-item-review-acme/widget#4-related-pr'));
    expect(await screen.findByTestId('pull-viewer')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('pull-viewer-dismiss'));
    });
    await waitFor(() => expect(screen.queryByTestId('pull-viewer')).toBeNull());

    // PR #50 (no linked issues) renders as a PR-as-issue row → PR viewer.
    fireEvent.press(screen.getByTestId('task-item-review-beta/site#50'));
    expect(await screen.findByTestId('pull-viewer')).toBeTruthy();

    // The browser seam is reserved for underivable repos — never hit here.
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('shows Done Today only once the state filter allows closed issues (quirk), collapsed by default', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    expect(screen.queryByTestId('task-group-done')).toBeNull();

    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filter-state'));
    fireEvent.press(await screen.findByTestId('tasks-state-option-all'));

    expect(await screen.findByTestId('task-group-done')).toBeTruthy();
    // Collapsed by default — the body (and its item) mount on toggle.
    expect(screen.queryByTestId('task-group-done-body')).toBeNull();
    fireEvent.press(screen.getByTestId('task-group-done-toggle'));
    expect(screen.getByTestId('task-item-done-acme/widget#5')).toBeTruthy();
  });

  it('backlog items stay hidden until the Backlog toggle is pressed (with count)', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    expect(screen.queryByTestId('task-item-todo-acme/widget#3')).toBeNull();
    expect(screen.getByText('Backlog (1)')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tasks-backlog-toggle'));
    expect(await screen.findByTestId('task-item-todo-acme/widget#3')).toBeTruthy();
    expect(screen.getByText('✓ Backlog (1)')).toBeTruthy();
  });

  it('the owner filter narrows issues AND PRs; Clear all preserves owner + backlog', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('tasks-owner-filter'));
    fireEvent.press(await screen.findByTestId('tasks-owner-option-beta'));

    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-acme/widget#1')).toBeNull();
    });
    expect(screen.getByTestId('task-item-todo-beta/site#2')).toBeTruthy();
    // PR #99 (acme) filtered out; PR #50 (beta) stays.
    expect(screen.queryByTestId('task-item-review-acme/widget#4')).toBeNull();
    expect(screen.getByTestId('task-item-review-beta/site#50')).toBeTruthy();

    // Turn backlog on + add a state filter, then Clear all: state resets,
    // owner + backlog survive.
    fireEvent.press(screen.getByTestId('tasks-backlog-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filter-state'));
    fireEvent.press(await screen.findByTestId('tasks-state-option-closed'));
    expect(screen.getByTestId('tasks-chip-state')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tasks-clear-filters'));
    expect(screen.queryByTestId('tasks-chip-state')).toBeNull();
    expect(screen.getByText(/Owner: beta/)).toBeTruthy();
    expect(screen.getByText(/✓ Backlog/)).toBeTruthy();
  });

  it('label pill filters narrow the list with a removable chip (AND semantics unit-tested below)', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filter-label-bug'));

    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-beta/site#2')).toBeNull();
    });
    expect(screen.getByTestId('task-item-todo-acme/widget#1')).toBeTruthy();
    expect(screen.getByTestId('tasks-chip-label-bug')).toBeTruthy();
  });

  it('my-view repo select narrows BOTH issues AND In Review PRs, with a removable chip', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    // Both In Review groups are present up front (acme PR links issue #4, beta PR #50).
    expect(screen.getByTestId('task-item-review-acme/widget#4')).toBeTruthy();
    expect(screen.getByTestId('task-item-review-beta/site#50')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));

    // The repo filter is a discoverable SELECT in the my view too (not a bare
    // text input): pick beta/site from the searchable sheet.
    fireEvent.press(screen.getByTestId('tasks-filter-repo-select'));
    fireEvent.press(await screen.findByTestId('tasks-repo-option-beta/site'));

    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-acme/widget#1')).toBeNull();
    });
    expect(screen.getByTestId('task-item-todo-beta/site#2')).toBeTruthy();
    // divergence: the repo filter narrows In Review PRs too — acme's PR
    // (and its linked issue #4) is gone; beta's PR stays.
    expect(screen.queryByTestId('task-item-review-acme/widget#4')).toBeNull();
    expect(screen.getByTestId('task-item-review-beta/site#50')).toBeTruthy();

    // Chip-press clears it.
    fireEvent.press(screen.getByTestId('tasks-chip-repo'));
    await waitFor(() => {
      expect(screen.getByTestId('task-item-todo-acme/widget#1')).toBeTruthy();
    });
    expect(screen.getByTestId('task-item-review-acme/widget#4')).toBeTruthy();

    // Assignee substring filter (still a free-text input): #1 is assigned to
    // ada, #2 has no assignees.
    fireEvent.changeText(screen.getByTestId('tasks-filter-assignee'), 'ada');
    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-beta/site#2')).toBeNull();
    });
    expect(screen.getByTestId('task-item-todo-acme/widget#1')).toBeTruthy();
    expect(screen.getByTestId('tasks-chip-assignee')).toBeTruthy();
  });

  it('the repo picker is a type-to-filter autocomplete', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filter-repo-select'));

    // Both repos are offered before searching.
    expect(await screen.findByTestId('tasks-repo-option-acme/widget')).toBeTruthy();
    expect(screen.getByTestId('tasks-repo-option-beta/site')).toBeTruthy();

    // Typing narrows the option list to the matching repo, then a tap selects it.
    fireEvent.changeText(screen.getByTestId('tasks-repo-sheet-search'), 'beta');
    await waitFor(() => {
      expect(screen.queryByTestId('tasks-repo-option-acme/widget')).toBeNull();
    });
    fireEvent.press(screen.getByTestId('tasks-repo-option-beta/site'));

    await waitFor(() => {
      expect(screen.queryByTestId('task-item-todo-acme/widget#1')).toBeNull();
    });
    expect(screen.getByTestId('task-item-todo-beta/site#2')).toBeTruthy();
    expect(screen.getByTestId('tasks-chip-repo')).toBeTruthy();
  });

  it('switches to All Tasks instantly (prefetched) with assigned/unassigned splits', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();
    const requestCount = gateway.requests.length;

    fireEvent.press(screen.getByTestId('tasks-tab-all'));
    expect(await screen.findByTestId('task-group-todo-assigned')).toBeTruthy();
    expect(screen.getByTestId('tasks-active-view').props.children).toBe('all');

    // Unassigned group is collapsed by default.
    expect(screen.getByTestId('task-group-todo-unassigned')).toBeTruthy();
    expect(screen.queryByTestId('task-group-todo-unassigned-body')).toBeNull();
    fireEvent.press(screen.getByTestId('task-group-todo-unassigned-toggle'));
    expect(screen.getByTestId('task-item-todo-unassigned-acme/widget#7')).toBeTruthy();

    // No new fetches — the all view was loaded in parallel at mount.
    expect(gateway.requests.length).toBe(requestCount);
  });

  it('shows the filtered empty state with a working Clear filters action', async () => {
    // The all-view fixture has no PRs, so a state=closed filter empties every
    // group (on `my`, PRs only honor the owner filter — so In
    // Review would keep the page non-empty).
    registerHappyPath(gateway);
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('tasks-tab-all'));
    await screen.findByTestId('task-group-todo-assigned');

    fireEvent.press(screen.getByTestId('tasks-filters-toggle'));
    fireEvent.press(screen.getByTestId('tasks-filter-state'));
    fireEvent.press(await screen.findByTestId('tasks-state-option-closed'));

    expect(await screen.findByTestId('tasks-empty')).toBeTruthy();
    expect(screen.getByText('No tasks match your filters')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tasks-empty-clear'));
    expect(await screen.findByTestId('task-group-todo-assigned')).toBeTruthy();
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
  });

  it('pull-to-refresh forces /refresh on the active view', async () => {
    registerHappyPath(gateway);
    renderTasks();
    await settle();
    const refreshMyCount = () =>
      gateway.requests.filter((r) => r.url === tasksUrl('refresh', 'my')).length;
    const before = refreshMyCount();

    const refreshControl = screen.UNSAFE_getByType(RefreshControl as never) as unknown as {
      props: { onRefresh: () => void };
    };
    await act(async () => {
      refreshControl.props.onRefresh();
    });

    await waitFor(() => {
      expect(refreshMyCount()).toBe(before + 1);
    });
  });

  it('shows the error state when /cached fails and recovers via Try again', async () => {
    gateway.on('GET', tasksUrl('cached', 'my'), () => ({ status: 500, body: { error: 'boom' } }));
    gateway.on('GET', tasksUrl('cached', 'all'), () => ({ status: 500, body: { error: 'boom' } }));
    renderTasks();

    expect(await screen.findByTestId('tasks-error')).toBeTruthy();

    // Fix the backend, retry → cached re-fetch + background refresh → groups.
    registerHappyPath(gateway);
    fireEvent.press(screen.getByTestId('tasks-retry'));
    expect(await screen.findByTestId('task-group-in-review')).toBeTruthy();
  });

  it('shows the "clone a repo" guidance when the user has no cloned repos', async () => {
    const noRepos = (view: 'my' | 'all'): TasksResponse => ({
      open_issues: [],
      closed_today: [],
      prs: [],
      total_open: 0,
      total_closed_today: 0,
      total_prs: 0,
      user: ADA,
      view,
      noLocalRepos: true,
    });
    gateway.on('GET', tasksUrl('cached', 'my'), () => ({ body: noRepos('my') }));
    gateway.on('GET', tasksUrl('refresh', 'my'), () => ({ body: noRepos('my') }));
    gateway.on('GET', tasksUrl('cached', 'all'), () => ({ body: noRepos('all') }));
    gateway.on('GET', tasksUrl('refresh', 'all'), () => ({ body: noRepos('all') }));

    const onBrowseRepos = jest.fn();
    renderTasks(jest.fn(), { onBrowseRepos });

    // The guidance state — NOT the generic empty state.
    expect(await screen.findByTestId('tasks-empty-no-repos')).toBeTruthy();
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
    expect(screen.getByText('No cloned repositories')).toBeTruthy();

    // The CTA routes to the repos list so the user can clone a repository.
    fireEvent.press(screen.getByTestId('tasks-empty-browse-repos'));
    expect(onBrowseRepos).toHaveBeenCalledTimes(1);
  });

  it('tapping an issue row opens the in-app viewer with ALL the info', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`, () => ({
      body: {
        issue: {
          number: 1,
          title: 'Fix the widget crash',
          state: 'open',
          body: 'It crashes **hard** on launch.',
          user: { login: 'ada', avatar_url: 'https://github.com/ada.png' },
          created_at: NOW_ISO,
          updated_at: NOW_ISO,
          labels: [{ name: 'bug', color: 'd73a4a' }],
          assignees: [ADA],
        },
        timeline: [
          {
            id: 501,
            event: 'commented',
            body: 'Reproduced on iOS 19.',
            user: { login: 'bob', avatar_url: 'https://github.com/bob.png' },
            created_at: NOW_ISO,
          },
          {
            id: 502,
            event: 'labeled',
            actor: { login: 'ada' },
            label: { name: 'bug', color: 'd73a4a' },
            created_at: NOW_ISO,
          },
          {
            id: 503,
            event: 'cross-referenced',
            actor: { login: 'bob' },
            created_at: NOW_ISO,
            source: {
              issue: {
                number: 99,
                title: 'Fix widget crash for good',
                state: 'open',
                pull_request: {},
                repository: { full_name: 'acme/widget' },
              },
            },
          },
        ],
      },
    }));
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('task-item-todo-acme/widget#1'));
    expect(await screen.findByTestId('issue-viewer')).toBeTruthy();

    // Preloaded fast path renders immediately; the fetch hydrates the timeline.
    expect(screen.getByTestId('issue-viewer-title')).toHaveTextContent('Fix the widget crash');
    expect(screen.getByTestId('issue-viewer-state')).toHaveTextContent('open');
    expect(await screen.findByTestId('issue-viewer-comment-501')).toBeTruthy();
    expect(screen.getByTestId('issue-viewer-labels')).toBeTruthy();
    expect(screen.getByTestId('issue-viewer-assignees')).toHaveTextContent(/ada/);
    expect(screen.getByTestId('issue-viewer-comment-count')).toHaveTextContent('1');
    expect(screen.getByTestId('issue-viewer-event-labeled')).toBeTruthy();
    expect(screen.getByText('It crashes **hard** on launch.')).toBeTruthy(); // markdown mock passthrough

    // The AI actions exist but are gated on the live socket (none here).
    expect(screen.getByTestId('issue-viewer-start-chat')).toBeDisabled();
    expect(screen.getByTestId('issue-viewer-quick-fix')).toBeDisabled();
  });

  it('posts a comment and closes with a selected reason from the viewer', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`, () => ({
      body: { issue: { ...issueAssigned, body: 'body' }, timeline: [] },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1/comments`, () => ({
      body: { success: true, comment: { id: 600 } },
    }));
    gateway.on('PATCH', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`, () => ({
      body: { number: 1, state: 'closed' },
    }));
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('task-item-todo-acme/widget#1'));
    await screen.findByTestId('issue-viewer');

    // Plain comment submit.
    fireEvent.changeText(screen.getByTestId('issue-viewer-comment-input'), 'On it!');
    await act(async () => {
      fireEvent.press(screen.getByTestId('issue-viewer-comment-submit'));
    });
    await waitFor(() => {
      const post = gateway.requests.find(
        (r) =>
          r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/repos/acme/widget/issues/1/comments`
      );
      expect(post?.body).toEqual({ body: 'On it!' });
    });

    // Close with a non-default reason picked from the sheet.
    fireEvent.press(screen.getByTestId('issue-viewer-close-reason'));
    fireEvent.press(await screen.findByTestId('issue-viewer-reason-not_planned'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('issue-viewer-close'));
    });
    await waitFor(() => {
      const patch = gateway.requests.find(
        (r) => r.method === 'PATCH' && r.url === `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`
      );
      expect(patch?.body).toEqual({ state: 'closed', state_reason: 'not_planned' });
    });
  });

  it('cross-referenced timeline links swap to the PR viewer (modal hand-off)', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`, () => ({
      body: {
        issue: { ...issueAssigned, body: 'body' },
        timeline: [
          {
            id: 503,
            event: 'cross-referenced',
            actor: { login: 'bob' },
            created_at: NOW_ISO,
            source: {
              issue: {
                number: 99,
                title: 'Fix widget crash for good',
                state: 'open',
                pull_request: {},
                repository: { full_name: 'acme/widget' },
              },
            },
          },
        ],
      },
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/pulls/99`, () => ({
      body: {
        pr: {
          number: 99,
          title: 'Fix widget crash for good',
          state: 'open',
          body: 'Fixes #1',
          user: { login: 'bob', avatar_url: 'https://github.com/bob.png' },
          created_at: NOW_ISO,
          head: { ref: 'fix/1-crash' },
          base: { ref: 'main' },
          comments: 1,
          review_comments: 2,
          commits: 3,
          additions: 10,
          deletions: 2,
          changed_files: 1,
          draft: false,
        },
        timeline: [],
        files: [],
      },
    }));
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('task-item-todo-acme/widget#1'));
    await screen.findByTestId('issue-viewer');
    fireEvent.press(await screen.findByTestId('issue-viewer-xref-99'));

    expect(await screen.findByTestId('pull-viewer')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('pull-viewer-title')).toHaveTextContent(
        'Fix widget crash for good'
      );
    });
  });

  it('tapping a PR row opens the PR viewer with branches, stats and the Files tab', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/beta/site/pulls/50`, () => ({
      body: {
        pr: {
          number: 50,
          title: 'New landing page',
          state: 'open',
          body: 'A whole new landing.',
          user: { login: 'bob', avatar_url: 'https://github.com/bob.png' },
          created_at: NOW_ISO,
          head: { ref: 'feat/landing' },
          base: { ref: 'main' },
          comments: 1,
          review_comments: 2,
          commits: 3,
          additions: 10,
          deletions: 2,
          changed_files: 1,
          draft: false,
        },
        timeline: [
          {
            id: 700,
            event: 'commented',
            body: 'Looks great!',
            user: { login: 'ada', avatar_url: 'https://github.com/ada.png' },
            created_at: NOW_ISO,
          },
        ],
        files: [
          {
            filename: 'src/app.ts',
            additions: 10,
            deletions: 2,
            patch: '@@ -1,2 +1,3 @@\n context\n+added line\n-removed line',
          },
        ],
      },
    }));
    renderTasks();
    await settle();

    fireEvent.press(screen.getByTestId('task-item-review-beta/site#50'));
    expect(await screen.findByTestId('pull-viewer')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('pull-viewer-branches')).toHaveTextContent(/main/);
    });
    expect(screen.getByTestId('pull-viewer-branches')).toHaveTextContent(/feat\/landing/);
    expect(screen.getByTestId('pull-viewer-stats')).toHaveTextContent(/3 comments/); // 1 + 2
    expect(screen.getByTestId('pull-viewer-stats')).toHaveTextContent(/\+10/);
    expect(await screen.findByTestId('pull-viewer-comment-700')).toBeTruthy();
    // Read-only conversation — the PR modal has NO comment composer.
    expect(screen.queryByTestId('issue-viewer-comment-input')).toBeNull();

    // Files tab: collapsible per-file block with the native patch rendering.
    fireEvent.press(screen.getByTestId('pull-viewer-tab-files'));
    expect(screen.getByTestId('pull-viewer-tab-files')).toHaveTextContent('Files (1)');
    fireEvent.press(await screen.findByTestId('pull-viewer-file-src/app.ts'));
    expect(await screen.findByTestId('pull-viewer-patch-src/app.ts')).toBeTruthy();
    expect(screen.getByText('+added line')).toBeTruthy();
  });

  it('dismissing the viewer kicks a silent list refresh (refresh-on-close parity)', async () => {
    registerHappyPath(gateway);
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/1`, () => ({
      body: { issue: { ...issueAssigned, body: 'body' }, timeline: [] },
    }));
    renderTasks();
    await settle();
    const refreshCount = () =>
      gateway.requests.filter((r) => r.url === tasksUrl('refresh', 'my')).length;
    const before = refreshCount();

    fireEvent.press(screen.getByTestId('task-item-todo-acme/widget#1'));
    await screen.findByTestId('issue-viewer');
    await act(async () => {
      fireEvent.press(screen.getByTestId('issue-viewer-dismiss'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('issue-viewer')).toBeNull();
    });
    await waitFor(() => {
      expect(refreshCount()).toBe(before + 1);
    });
  });

  it('a failed background refresh keeps the last-known cached data (degradation)', async () => {
    registerHappyPath(gateway, { cachedMy: myResponse({ cached: true }) });
    gateway.on('GET', tasksUrl('refresh', 'my'), () => ({
      status: 403,
      body: { error: 'rate limited' },
    }));
    renderTasks();

    await screen.findByTestId('task-group-in-review');
    await waitFor(() => {
      expect(gateway.requests.some((r) => r.url === tasksUrl('refresh', 'my'))).toBe(true);
    });
    // Data survived; the cached badge stays (the refresh never replaced it).
    expect(screen.getByTestId('task-item-todo-acme/widget#1')).toBeTruthy();
    expect(await screen.findByTestId('tasks-cached-badge')).toBeTruthy();
  });
});

describe('task grouping helpers (pure)', () => {
  const NOW = Date.now();

  it('getPriority ranks critical labels, due milestones, recency and comments', () => {
    const plain = issue({ number: 10, updated_at: new Date(NOW - 40 * 86_400_000).toISOString() });
    const urgent = issue({
      number: 11,
      labels: [{ name: 'critical', color: 'ff0000' }],
      updated_at: new Date(NOW).toISOString(),
      comments: 20,
    });
    const dueSoon = issue({
      number: 12,
      milestone: { title: 'v1', due_on: new Date(NOW + 3 * 86_400_000).toISOString() },
      updated_at: new Date(NOW).toISOString(),
    });
    const dueLater = issue({
      number: 13,
      milestone: { title: 'v2', due_on: new Date(NOW + 20 * 86_400_000).toISOString() },
      updated_at: new Date(NOW).toISOString(),
    });
    expect(getPriority(urgent, NOW)).toBeGreaterThan(getPriority(plain, NOW));
    // critical(300) + recency(50) + comments capped at 50
    expect(getPriority(urgent, NOW)).toBe(400);
    expect(getPriority(plain, NOW)).toBe(10); // max(0, 50-40)
    expect(getPriority(dueSoon, NOW)).toBe(250); // milestone <7d (200) + recency (50)
    expect(getPriority(dueLater, NOW)).toBe(150); // milestone <30d (100) + recency (50)
  });

  it('getContrastColor picks black on light and white on dark/missing colors', () => {
    expect(getContrastColor('ededed')).toBe('#000000');
    expect(getContrastColor('1d76db')).toBe('#ffffff');
    expect(getContrastColor(undefined)).toBe('#ffffff');
  });

  it('formatTimeAgo buckets seconds → years', () => {
    expect(formatTimeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('30s ago');
    expect(formatTimeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago');
    expect(formatTimeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago');
    expect(formatTimeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d ago');
    expect(formatTimeAgo(new Date(NOW - 45 * 86_400_000).toISOString(), NOW)).toBe('1mo ago');
    expect(formatTimeAgo(new Date(NOW - 400 * 86_400_000).toISOString(), NOW)).toBe('1y ago');
  });

  it('filterDoneToday keeps only issues closed since the local midnight', () => {
    const todayClosed = issue({
      number: 20,
      state: 'closed',
      closed_at: new Date(NOW).toISOString(),
    });
    const yesterdayClosed = issue({
      number: 21,
      state: 'closed',
      closed_at: new Date(NOW - 2 * 86_400_000).toISOString(),
    });
    const stillOpen = issue({ number: 22 });
    expect(filterDoneToday([todayClosed, yesterdayClosed, stillOpen], NOW)).toEqual([todayClosed]);
  });

  it('buildInReview dedupes issues linked by multiple PRs (first PR wins)', () => {
    const issueX = issue({ number: 4 });
    const map = new Map([[`${repoKeyOf(issueX.repository_url)}#4`, issueX]]);
    const secondPr: TaskPr = { ...pr99, id: 100, number: 100, title: 'Another fix' };
    const entries = buildInReview([pr99, secondPr], map);
    // Issue 4 renders once (chip = PR 99); PR 100's claim is skipped entirely.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.relatedPR?.number).toBe(99);
  });

  it('groupTasks: my-view Todo = assigned OR authored, minus linked, priority-sorted', () => {
    const data = myResponse();
    const grouped = groupTasks(data, 'my', DEFAULT_TASK_FILTERS, NOW);
    expect(grouped.todo.map((i) => i.number)).toEqual([1, 2]); // backlog (3) + linked (4) excluded
    expect(grouped.inReview).toHaveLength(2);
    expect(grouped.done).toHaveLength(0); // state=open default filters closed_today (quirk)
    const withState = groupTasks(data, 'my', { ...DEFAULT_TASK_FILTERS, stateFilter: 'all' }, NOW);
    expect(withState.done.map((i) => i.number)).toEqual([5]);
  });

  it('groupTasks sorts Todo by priority DESCENDING (input order alone fails this)', () => {
    // The critical issue comes LAST in the input — only the sort can put it first.
    const plain = issue({ number: 30, assignees: [ADA] });
    const critical = issue({
      number: 31,
      assignees: [ADA],
      labels: [{ name: 'critical', color: 'ff0000' }],
    });
    const data = myResponse({ open_issues: [plain, critical], closed_today: [], prs: [] });
    const grouped = groupTasks(data, 'my', DEFAULT_TASK_FILTERS, NOW);
    expect(grouped.todo.map((i) => i.number)).toEqual([31, 30]);
  });

  it('groupTasks inReviewPrCount counts FILTERED PRs, not resolved rows', () => {
    // One PR closing two mapped issues renders 2 rows but the web counts 1 PR.
    const multiLink: TaskPr = { ...pr99, linked_issue_numbers: [4, 1] };
    const data = myResponse({ prs: [multiLink] });
    const grouped = groupTasks(data, 'my', DEFAULT_TASK_FILTERS, NOW);
    expect(grouped.inReview).toHaveLength(2);
    expect(grouped.inReviewPrCount).toBe(1);
  });

  it('applyIssueFilters label selection is AND logic (an OR regression fails this)', () => {
    const both = issue({
      number: 40,
      labels: [
        { name: 'bug', color: 'd73a4a' },
        { name: 'ui', color: '1d76db' },
      ],
    });
    const onlyBug = issue({ number: 41, labels: [{ name: 'bug', color: 'd73a4a' }] });
    const filtered = applyIssueFilters([both, onlyBug], {
      ...DEFAULT_TASK_FILTERS,
      selectedLabels: ['bug', 'ui'],
    });
    expect(filtered.map((i) => i.number)).toEqual([40]);
  });

  it('the repo filter PASSES issues lacking repository.full_name (replicated quirk)', () => {
    const noRepo = issue({ number: 42, repository: undefined, repository_url: undefined });
    const matching = issue({ number: 43 }); // acme/widget
    const other = issue({
      number: 44,
      repository: repoRef('zeta', 'thing'),
      repository_url: repoUrl('zeta', 'thing'),
    });
    const filtered = applyIssueFilters([noRepo, matching, other], {
      ...DEFAULT_TASK_FILTERS,
      repoFilter: 'widget',
    });
    expect(filtered.map((i) => i.number)).toEqual([42, 43]);
  });

  it('deriveFilterOptions includes PR-only repos so they are selectable', () => {
    // gamma/api has ONLY a PR (no issue) — it must still be offered as a repo.
    const data = myResponse({
      open_issues: [issueAssigned], // acme/widget
      closed_today: [],
      prs: [
        pr50,
        {
          ...pr99,
          base: { repo: { nameWithOwner: 'gamma/api', name: 'api', owner: { login: 'gamma' } } },
        },
      ],
    });
    expect(deriveFilterOptions(data).repositories).toEqual([
      'acme/widget',
      'beta/site',
      'gamma/api',
    ]);
  });

  it('applyPrFilters narrows PRs by owner AND repo, passing PRs with no repo info', () => {
    const noRepoPr: TaskPr = { ...pr99, id: 7, number: 7, base: undefined };
    const prs = [pr99 /* acme/widget */, pr50 /* beta/site */, noRepoPr];

    // Owner only (legacy behavior preserved).
    expect(
      applyPrFilters(prs, { ...DEFAULT_TASK_FILTERS, ownerFilter: 'beta' }).map((p) => p.number)
    ).toEqual([50]);

    // Repo filter narrows PRs (the divergence) and a no-repo PR passes through.
    expect(
      applyPrFilters(prs, { ...DEFAULT_TASK_FILTERS, repoFilter: 'beta/site' }).map((p) => p.number)
    ).toEqual([50, 7]);

    // No filters → everything passes.
    expect(applyPrFilters(prs, DEFAULT_TASK_FILTERS).map((p) => p.number)).toEqual([99, 50, 7]);
  });
});

describe('viewer AI prompts are copied verbatim', () => {
  const issueInput = {
    number: 7,
    title: 'Crash on launch',
    body: 'It dies immediately.',
    owner: 'acme',
    repo: 'widget',
  };
  const pullInput = {
    number: 8,
    title: 'New landing',
    owner: 'beta',
    repo: 'site',
    headRef: 'feat/landing',
    baseRef: 'main',
  };

  it('issue prompts match the IssuePage strings', () => {
    expect(issueChatTitle(issueInput)).toBe('Issue #7: Crash on launch...');
    expect(issueChatPrompt(issueInput)).toContain(
      'I\'d like to discuss issue #7 in acme/widget: "Crash on launch"'
    );
    expect(issueChatPrompt(issueInput)).toContain('Issue description:\nIt dies immediately.');
    expect(quickFixPrompt(issueInput)).toContain(
      'Please help me fix issue #7 in acme/widget: "Crash on launch"'
    );
    expect(quickFixPrompt(issueInput)).toContain('fix/7-authentication-bug');
  });

  it('PR prompts match the PRViewerModal strings (head/base refs)', () => {
    expect(reviewPrPrompt(pullInput)).toContain(
      'Please help me review pull request #8 in beta/site: "New landing"'
    );
    expect(reviewPrPrompt(pullInput)).toContain('check out the PR branch: feat/landing');
    expect(quickMergePrompt(pullInput)).toContain(
      'Please help me merge pull request #8 in beta/site: "New landing"'
    );
    expect(quickMergePrompt(pullInput)).toContain('merge the PR into main');
  });
});
