/**
 * show the linked GitHub issue (number + title) below the chat name.
 *
 * Covers the pieces of the feature in isolation (the chat directory + active-chat
 * header just wire them together):
 *
 *   - `LinkedIssueBadge` — renders `#number` immediately + the fetched title,
 *     is tappable when `onPress` is given (else display-only), and falls back to
 *     a bare `#number` when the details fetch fails;
 *   - `ChatCardBody` — renders the badge only when the chat has a `linkedIssue`;
 *   - `useChatLinkedIssue` — resolves from the live chrome-store sink first, then
 *     the cached chat-directory list, and hides on an explicit unlink;
 *   - `useLinkedIssueViewer` — `open()` builds the issue viewer target and mounts
 *     the in-app `TaskItemViewer` detail.
 */

// The authed sandbox client + the dual-base-url resolver read the sandbox URL +
// auth token from SecureStore at module scope.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

// react-native-mmkv backs the theme store that `useAppTheme` (the badge/card) reads.
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

// The native NetInfo module must never load under Jest (onlineManager bridge).
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import {
  onlineManager,
  QueryClientProvider,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ChatListItem, GetChatsResponse } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { queryKeys } from '../src/features/api/keys';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { useChatChromeStore, type LinkedIssue } from '../src/features/chat/chrome/chatChromeStore';
import { useChatLinkedIssue } from '../src/features/chat/chrome/useChatLinkedIssue';
import { useLinkedIssueViewer } from '../src/features/chat/LinkedIssueViewerHost';
import { ChatCardBody } from '../src/features/home/ChatCardBody';
import { LinkedIssueBadge } from '../src/features/home/LinkedIssueBadge';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
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

const LINKED: LinkedIssue = { owner: 'acme', repo: 'widget', number: 42 };

function issueDetailsUrl(l: LinkedIssue): string {
  return `${SANDBOX_BASE}/api/github/issues/${l.owner}/${l.repo}/${l.number}`;
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

let activeQueryClient: QueryClient | undefined;
function newQueryClient(): QueryClient {
  activeQueryClient = createQueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return activeQueryClient;
}

function renderUnderApi(node: ReactElement, gateway: MockGateway, qc = newQueryClient()) {
  return render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ApiProvider client={buildClient(gateway)} queryClient={qc} netInfo={onlineNetInfo}>
        {node}
      </ApiProvider>
    </SafeAreaProvider>
  );
}

function makeChat(partial: Partial<ChatListItem> & { id: string }): ChatListItem {
  return { type: 'chat' as ChatListItem['type'], title: 'A chat', ...partial };
}

beforeEach(() => {
  jest.clearAllMocks();
  secureStore.__store.clear();
  secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
  secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
  onlineManager.setOnline(true);
});

afterEach(() => {
  act(() => useChatChromeStore.getState().reset());
  activeQueryClient?.clear();
  activeQueryClient = undefined;
  onlineManager.setOnline(true);
});

describe('LinkedIssueBadge', () => {
  it('renders #number immediately and the fetched issue title', async () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({
      body: { title: 'Fix the widget crash', state: 'open', html_url: 'https://x' },
    }));

    renderUnderApi(<LinkedIssueBadge linkedIssue={LINKED} />, gateway);

    // The number shows without waiting on the network.
    expect(screen.getByTestId('linked-issue-badge-number')).toHaveTextContent('#42');
    await waitFor(() =>
      expect(screen.getByTestId('linked-issue-badge-title')).toHaveTextContent(
        'Fix the widget crash'
      )
    );
  });

  it('opens the issue when tapped (onPress provided)', async () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({ body: { title: 'T', state: 'open' } }));
    const onPress = jest.fn();

    renderUnderApi(<LinkedIssueBadge linkedIssue={LINKED} onPress={onPress} />, gateway);

    fireEvent.press(screen.getByTestId('linked-issue-badge'));
    expect(onPress).toHaveBeenCalledWith(LINKED);
  });

  it('falls back to a bare #number when the details fetch fails', async () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({ status: 404, body: { error: 'gone' } }));

    renderUnderApi(<LinkedIssueBadge linkedIssue={LINKED} />, gateway);

    expect(screen.getByTestId('linked-issue-badge-number')).toHaveTextContent('#42');
    // The title node never appears (no data) — the query is retry:false.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('linked-issue-badge-title')).toBeNull();
  });
});

describe('ChatCardBody linked-issue line', () => {
  it('renders the badge only when the chat has a linkedIssue', async () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({
      body: { title: 'Linked', state: 'open' },
    }));

    const { rerender } = renderUnderApi(
      <ChatCardBody chat={makeChat({ id: 'c1', linkedIssue: LINKED })} />,
      gateway
    );
    expect(screen.getByTestId('linked-issue-badge')).toBeTruthy();

    rerender(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider
          client={buildClient(gateway)}
          queryClient={activeQueryClient!}
          netInfo={onlineNetInfo}
        >
          <ChatCardBody chat={makeChat({ id: 'c2' })} />
        </ApiProvider>
      </SafeAreaProvider>
    );
    expect(screen.queryByTestId('linked-issue-badge')).toBeNull();
  });

  it('forwards the badge tap to onOpenLinkedIssue', () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({ body: { title: 'L', state: 'open' } }));
    const onOpen = jest.fn();

    renderUnderApi(
      <ChatCardBody
        chat={makeChat({ id: 'c1', linkedIssue: LINKED })}
        onOpenLinkedIssue={onOpen}
      />,
      gateway
    );
    fireEvent.press(screen.getByTestId('linked-issue-badge'));
    expect(onOpen).toHaveBeenCalledWith(LINKED);
  });
});

describe('useChatLinkedIssue resolver', () => {
  function wrapper(qc: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children as never}</QueryClientProvider>
    );
  }

  it('prefers the live chrome-store sink over the directory cache', () => {
    const qc = newQueryClient();
    // The cache says #1; the live socket sink says #99 — the sink wins.
    qc.setQueryData(queryKeys.chatDirectory('active'), {
      pageParams: [0],
      pages: [
        { chats: [makeChat({ id: 'c1', linkedIssue: { owner: 'a', repo: 'b', number: 1 } })] },
      ],
    } as unknown as InfiniteData<GetChatsResponse>);
    act(() =>
      useChatChromeStore.getState().setLinkedIssue('c1', { owner: 'a', repo: 'b', number: 99 })
    );

    const { result } = renderHook(() => useChatLinkedIssue('c1'), { wrapper: wrapper(qc) });
    expect(result.current).toEqual({ owner: 'a', repo: 'b', number: 99 });
  });

  it('hides the badge on an explicit unlink (store entry === null)', () => {
    const qc = newQueryClient();
    qc.setQueryData(queryKeys.chatDirectory('active'), {
      pageParams: [0],
      pages: [{ chats: [makeChat({ id: 'c1', linkedIssue: LINKED })] }],
    } as unknown as InfiniteData<GetChatsResponse>);
    act(() => useChatChromeStore.getState().setLinkedIssue('c1', null));

    const { result } = renderHook(() => useChatLinkedIssue('c1'), { wrapper: wrapper(qc) });
    expect(result.current).toBeUndefined();
  });

  it('falls back to the cached chat-directory list when the sink is empty', () => {
    const qc = newQueryClient();
    qc.setQueryData(queryKeys.chatDirectory('active'), {
      pageParams: [0],
      pages: [{ chats: [makeChat({ id: 'c1', linkedIssue: LINKED })] }],
    } as unknown as InfiniteData<GetChatsResponse>);

    const { result } = renderHook(() => useChatLinkedIssue('c1'), { wrapper: wrapper(qc) });
    expect(result.current).toEqual(LINKED);
  });

  it('returns undefined when neither source has a link', () => {
    const qc = newQueryClient();
    qc.setQueryData(queryKeys.chatDirectory('active'), {
      pageParams: [0],
      pages: [{ chats: [makeChat({ id: 'c1' })] }],
    } as unknown as InfiniteData<GetChatsResponse>);

    const { result } = renderHook(() => useChatLinkedIssue('c1'), { wrapper: wrapper(qc) });
    expect(result.current).toBeUndefined();
  });
});

describe('useLinkedIssueViewer', () => {
  function wrapper(qc: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children as never}</QueryClientProvider>
    );
  }

  it('builds the issue viewer target on open() and clears it on close()', () => {
    const { result } = renderHook(() => useLinkedIssueViewer(), {
      wrapper: wrapper(newQueryClient()),
    });
    expect(result.current.element).toBeNull();

    act(() => result.current.open(LINKED));
    const el = result.current.element as ReactElement<{
      target: { kind: string; owner: string; repo: string; number: number };
      onClose: () => void;
    }>;
    expect(el).not.toBeNull();
    expect(el.props.target).toEqual({ kind: 'issue', owner: 'acme', repo: 'widget', number: 42 });

    act(() => el.props.onClose());
    expect(result.current.element).toBeNull();
  });

  it('mounts the in-app issue detail when the badge that drives it is tapped', async () => {
    const gateway = createMockGateway();
    gateway.on('GET', issueDetailsUrl(LINKED), () => ({ body: { title: 'L', state: 'open' } }));
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/issues/42`, () => ({
      body: {
        issue: {
          id: 42,
          number: 42,
          title: 'Widget needs a fix',
          state: 'open',
          body: '',
          html_url: 'https://github.com/acme/widget/issues/42',
          comments: 0,
          labels: [],
          assignees: [],
          user: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          closed_at: null,
        },
        timeline: [],
      },
    }));

    function Probe() {
      const viewer = useLinkedIssueViewer();
      return (
        <>
          <ChatCardBody
            chat={makeChat({ id: 'c1', linkedIssue: LINKED })}
            onOpenLinkedIssue={viewer.open}
          />
          {viewer.element}
        </>
      );
    }

    renderUnderApi(<Probe />, gateway);
    await act(async () => {
      fireEvent.press(screen.getByTestId('linked-issue-badge'));
    });
    // The badge tap mounts the in-app issue detail (the Tasks viewer). The first
    // render-time require of the viewer graph (markdown parser, …) is slow, so the
    // queries carry a generous timeout. Assert the inner `issue-viewer` for the
    // RIGHT issue (#42) loaded — the navigation-to-detail acceptance criterion.
    const viewer = await screen.findByTestId('issue-viewer', undefined, { timeout: 15000 });
    expect(viewer).toBeTruthy();
    await waitFor(
      () =>
        expect(screen.getByTestId('issue-viewer-title')).toHaveTextContent('Widget needs a fix'),
      { timeout: 15000 }
    );
  }, 25000);
});
