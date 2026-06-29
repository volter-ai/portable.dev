/**
 * ChatListSync — refresh the chat directory cache on `chat:created`.
 *
 * Regression guard for "a newly-created chat never shows up in the list until the
 * app is restarted": the chat list is a `useInfiniteQuery`
 * (`queryKeys.chatDirectory('active')`) and nothing invalidated it when a chat was
 * created. `ChatListSync` (mounted by `AppShell` inside `ApiProvider`) folds the
 * `chat:created` signal — `useSocketStore.lastCreatedChatId` — into an
 * invalidation so the Active list refetches immediately.
 *
 * Light test (no router / reanimated / mmkv): mount `ChatListSync` + a probe that
 * runs the SAME directory query, under `ApiProvider` over `createMockGateway`, then
 * flip `lastCreatedChatId` and assert the query refetched (a 2nd `/api/chats` request)
 * and the new chat appears. A control proves no refetch fires without a create signal.
 */

// In-memory keychain — RelayApiClient reads the sandbox URL + authToken from here.
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

// The native NetInfo module must never load under Jest.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { GetChatsResponse } from '@vgit2/shared/types';

import { ApiProvider, useApi } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { queryKeys } from '../src/features/api/keys';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
// FILE import (not the chat barrel) — keeps the heavy chat graph out of this test.
import { ChatListSync } from '../src/features/chat/ChatListSync';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { useSocketStore } from '../src/features/socket/socketStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

/** Full URL of the Active directory page (offset 0) — the mock matches it exactly. */
const chatsUrl = `${SANDBOX_BASE}/api/chats?limit=50&offset=0&archived=false`;

function chatsBody(n: number): GetChatsResponse {
  return {
    chats: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      type: 'chat' as GetChatsResponse['chats'][number]['type'],
      title: `Chat ${i}`,
    })),
    hasMore: false,
    totalCount: n,
  };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

/** Runs the SAME query `useChatDirectory` uses, exposing the row count as a testID. */
function DirectoryProbe() {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: queryKeys.chatDirectory('active'),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<GetChatsResponse>(`/api/chats?limit=50&offset=${pageParam}&archived=false`),
    getNextPageParam: () => undefined,
  });
  const count = query.data?.pages.flatMap((p) => p.chats).length ?? -1;
  return <Text testID="probe-count">{count}</Text>;
}

describe('ChatListSync — refresh chat directory on chat:created', () => {
  let gateway: MockGateway;
  let queryClient: QueryClient | undefined;

  function mount(client: RelayApiClient) {
    queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <ApiProvider client={client} queryClient={queryClient} netInfo={onlineNetInfo}>
        <ChatListSync />
        <DirectoryProbe />
      </ApiProvider>
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    act(() => useSocketStore.setState({ lastCreatedChatId: null }));
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    act(() => useSocketStore.setState({ lastCreatedChatId: null }));
    queryClient?.clear();
    queryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('refetches the Active directory when a chat is created', async () => {
    // The server has 1 chat, then 2 once the new chat is created.
    let chatCount = 1;
    gateway.on('GET', chatsUrl, () => ({ body: chatsBody(chatCount) }));

    mount(buildClient(gateway));

    await waitFor(() => expect(screen.getByTestId('probe-count').props.children).toBe(1));
    expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(1);

    // A chat is created elsewhere (home composer / repo hand-off / another device):
    // the backend now lists 2, and the `chat:created` broadcast lands in the store.
    chatCount = 2;
    act(() => useSocketStore.getState().setLastCreatedChatId('c1'));

    // The cache was invalidated → the active query refetches and shows the new chat.
    await waitFor(() => expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('probe-count').props.children).toBe(2));
  });

  it('does NOT refetch without a create signal (no invalidation on its own)', async () => {
    gateway.on('GET', chatsUrl, () => ({ body: chatsBody(1) }));

    mount(buildClient(gateway));

    await waitFor(() => expect(screen.getByTestId('probe-count').props.children).toBe(1));
    expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(1);

    // A null write (the post-reset / no-create state) must never trigger a refetch.
    act(() => useSocketStore.setState({ lastCreatedChatId: null }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(1);
  });
});
