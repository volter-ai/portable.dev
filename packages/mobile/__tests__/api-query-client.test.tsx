/**
 * TanStack Query client with sandbox URL + Bearer + refresh.
 *
 * Drives the authed sandbox API client end-to-end through the TanStack Query
 * layer with a mocked sandbox HTTP layer (`createMockGateway`), an in-memory
 * SecureStore, and an injectable NetInfo controller. Verifies:
 *
 *   1. a request that returns 401 triggers EXACTLY ONE refresh against
 *      `/auth/mobile/react-native/refresh`, then ONE retry of the original
 *      request carrying the new `Authorization: Bearer`, and the renewed token is
 *      persisted to SecureStore;
 *   2. with NetInfo mocked offline a mutation is QUEUED (paused, not errored) and
 *      auto-sent on the online transition — no manual retry.
 */

// In-memory mock keychain for expo-secure-store (the only credential store).
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

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { act } from 'react';
import { Pressable, Text } from 'react-native';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { useCreateChat, useUser } from '../src/features/api/hooks';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
}

const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';

/** A NetInfo mock whose connectivity transitions are driven imperatively. */
function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('authed TanStack Query client', () => {
  let gateway: MockGateway;
  // Track the per-test client so we can clear its caches/timers on teardown
  // (otherwise React Query's GC timers keep Jest's event loop open).
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(config?: Parameters<typeof createQueryClient>[0]): QueryClient {
    activeQueryClient = createQueryClient(config);
    return activeQueryClient;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('resolves the sandbox URL + Bearer, refreshes once on 401, and persists the renewed token', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'stale-token');

    // The sandbox endpoint (a different base from the gateway): 401 for the stale
    // Bearer, 200 once the refreshed Bearer is presented.
    const apiUrl = `${SANDBOX_BASE}/api/user`;
    gateway.on('GET', apiUrl, (req) => {
      const auth = req.headers.Authorization ?? req.headers.authorization ?? '';
      if (auth === 'Bearer mock-refreshed-token') return { body: { id: 'u1', login: 'octocat' } };
      return { status: 401, body: { error: 'token expired' } };
    });

    const client = buildClient(gateway);
    const queryClient = newQueryClient({ defaultOptions: { queries: { retry: false } } });
    const netCtl = createNetInfoController();

    function UserView() {
      const { data } = useUser();
      return <Text testID="user">{data ? (data as { login?: string }).login : 'loading'}</Text>;
    }

    render(
      <ApiProvider client={client} queryClient={queryClient} netInfo={netCtl.netInfo}>
        <UserView />
      </ApiProvider>
    );

    await waitFor(() => {
      expect(screenText(gateway, apiUrl)).toBe(2);
    });

    // Exactly one refresh, and the replay carried the refreshed Bearer.
    const refreshReqs = gateway.requests.filter((r) => r.path.endsWith('/refresh'));
    expect(refreshReqs).toHaveLength(1);
    expect(refreshReqs[0].method).toBe('POST');
    expect(refreshReqs[0].headers.Authorization).toBe('Bearer stale-token');
    expect(refreshReqs[0].credentials).toBe('omit');

    const apiReqs = gateway.requests.filter((r) => r.url === apiUrl);
    expect(apiReqs[0].headers.Authorization).toBe('Bearer stale-token');
    expect(apiReqs[1].headers.Authorization).toBe('Bearer mock-refreshed-token');
    // No cookies are ever sent.
    expect(apiReqs.every((r) => r.credentials === 'omit')).toBe(true);

    // The renewed token (from /refresh, not any header) is persisted.
    expect(secureStore.__store.get(AUTH_TOKEN_KEY)).toBe('mock-refreshed-token');
  });

  it('queues a mutation while offline (NetInfo) and auto-sends it on reconnect', async () => {
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');

    const chatsUrl = `${SANDBOX_BASE}/api/chats`;
    gateway.on('POST', chatsUrl, () => ({
      body: { id: 'c1', type: 'chat', title: 'hi', repoOwner: null, repoName: null },
    }));

    const client = buildClient(gateway);
    const queryClient = newQueryClient({ defaultOptions: { mutations: { retry: false } } });
    const netCtl = createNetInfoController();

    function ChatCreator() {
      const m = useCreateChat();
      const status = m.isPaused
        ? 'paused'
        : m.isSuccess
          ? 'done'
          : m.isPending
            ? 'pending'
            : 'idle';
      return (
        <>
          <Pressable testID="create" onPress={() => m.mutate({ title: 'hi' })}>
            <Text>create</Text>
          </Pressable>
          <Text testID="status">{status}</Text>
        </>
      );
    }

    const { getByTestId } = render(
      <ApiProvider client={client} queryClient={queryClient} netInfo={netCtl.netInfo}>
        <ChatCreator />
      </ApiProvider>
    );

    // Go offline via NetInfo, then fire the mutation: it must PAUSE (queue), not error.
    await act(async () => {
      netCtl.emit(false);
    });
    expect(onlineManager.isOnline()).toBe(false);

    fireEvent.press(getByTestId('create'));
    await waitFor(() => expect(getByTestId('status').props.children).toBe('paused'));

    // Nothing left the device while offline (no error either).
    expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(0);

    // Reconnect → the queued mutation is auto-sent (no manual retry) and succeeds.
    await act(async () => {
      netCtl.emit(true);
    });
    await waitFor(() => {
      expect(gateway.requests.filter((r) => r.url === chatsUrl)).toHaveLength(1);
    });
    await waitFor(() => expect(getByTestId('status').props.children).toBe('done'));

    const created = gateway.requests.find((r) => r.url === chatsUrl);
    expect(created?.headers.Authorization).toBe('Bearer good-token');
    expect(created?.credentials).toBe('omit');
  });
});

/** Count the sandbox-endpoint requests recorded so far (used inside `waitFor`). */
function screenText(gateway: MockGateway, url: string): number {
  return gateway.requests.filter((r) => r.url === url).length;
}
