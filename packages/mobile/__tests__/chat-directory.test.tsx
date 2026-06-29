/**
 * Chat navigation + list (directory / home / active chat).
 *
 * Drives the chat directory + active-chat screens end-to-end through the authed
 * TanStack Query layer with a mocked sandbox HTTP layer (`createMockGateway`),
 * an in-memory SecureStore, and an in-memory MMKV (the chat-store backend).
 * Everything runs inside a real Expo Router (`renderRouter`) so `useRouter` /
 * `useLocalSearchParams` resolve. Verifies (per the story's acceptance criteria):
 *
 *   1. the directory paginates (`GET /api/chats?limit=&offset=` → load more);
 *   2. archive / unarchive / delete mutate the list state;
 *   3. tapping a chat navigates to its active-chat route via Expo Router;
 *   4. per-chat settings hydrate from `/api/chat/:id/settings` (defaults for a new chat).
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

// react-native-mmkv backs the chat-store (drafts + per-chat settings overrides).
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

// The chat barrel transitively imports ChatComposer → VoiceInput → the `expo-audio`
// native module. Replace it with the controllable harness mock.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

// LOAD ORDER MATTERS — keep this FIRST. The chat directory's SwipeableChatRow uses
// react-native-reanimated, which is stubbed via jest.config.js moduleNameMapper
// (→ src/test/reanimatedMock.js). But `expo-router/testing-library` self-registers
// its OWN `jest.mock('react-native-reanimated')` at import time that resolves to `{}`
// under jest-expo (its `require('react-native-reanimated/mock')` throws), and a
// package-level jest.mock beats moduleNameMapper. Importing the chat feature HERE,
// before `expo-router/testing-library` below, lets SwipeableChatRow's module capture
// the working reanimated stub before that override lands. Do not reorder.
import '../src/features/chat';

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ChatListItem, GetChatsResponse } from '@vgit2/shared/types';

import ActiveChatRoute from '../app/(app)/(tabs)/chat/[chatId]';
import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { ChatDirectoryScreen } from '../src/features/chat';
import { useSocketStore } from '../src/features/socket/socketStore';
import { useChatStore } from '../src/features/state';
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

/** Offline-disabled NetInfo (always online) — connectivity isn't under test here. */
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

/** Build N list items `c{start}..c{start+n-1}`. */
function makeChats(n: number, start = 0): ChatListItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${start + i}`,
    type: 'chat' as ChatListItem['type'],
    title: `Chat ${start + i}`,
  }));
}

function chatsUrl(offset: number, category: 'active' | 'saved' | 'archived' = 'active'): string {
  // The directory ALWAYS sends an explicit `category` filter so the Active / Saved /
  // Archived tabs are a true partition.
  return `${SANDBOX_BASE}/api/chats?limit=50&offset=${offset}&category=${category}`;
}

describe('chat directory / navigation / settings', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return activeQueryClient;
  }

  /** Render the chat routes inside a real Expo Router with the mocked API provider. */
  function renderChatApp(
    client: RelayApiClient,
    qc: QueryClient,
    opts: { initialUrl: string; directoryArchived?: boolean }
  ) {
    const Layout = () => (
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <Slot />
        </ApiProvider>
      </SafeAreaProvider>
    );
    const Directory = opts.directoryArchived
      ? () => <ChatDirectoryScreen archived />
      : () => <ChatDirectoryScreen />;

    return renderRouter(
      {
        _layout: Layout,
        'chat/directory': Directory,
        'chat/[chatId]': ActiveChatRoute,
      },
      { initialUrl: opts.initialUrl }
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    act(() => {
      useChatStore.setState({ drafts: {}, chatSettings: {} });
    });
    gateway = createMockGateway();
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
    act(() => {
      useSocketStore.getState().reset();
    });
  });

  it('paginates the chat directory (GET /api/chats limit/offset + load more)', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(50), hasMore: true, totalCount: 51 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', chatsUrl(50), () => ({
      body: { chats: makeChats(1, 50), hasMore: false, totalCount: 51 } satisfies GetChatsResponse,
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(50));
    expect(gateway.requests.filter((r) => r.url === chatsUrl(0))).toHaveLength(1);

    fireEvent.press(screen.getByTestId('chat-directory-load-more'));
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === chatsUrl(50))).toHaveLength(1)
    );
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(51));
  });

  it('archive and delete mutate the active list state', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(3), hasMore: false, totalCount: 3 } satisfies GetChatsResponse,
    }));
    gateway.on('PATCH', `${SANDBOX_BASE}/api/chats/c0/archive`, () => ({
      body: { success: true },
    }));
    gateway.on('DELETE', `${SANDBOX_BASE}/api/chats/c1`, () => ({
      body: { success: true },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(3));

    // Archive c0 → removed from the list + PATCH archive=true sent.
    fireEvent.press(screen.getByTestId('chat-archive-c0'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));
    expect(screen.queryByTestId('chat-row-c0')).toBeNull();
    await waitFor(() => {
      const req = gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/chats/c0/archive`);
      expect(req?.body).toEqual({ archived: true });
    });

    // Delete c1 → opens the confirmation modal (NOT removed yet), then confirm removes
    // it from the list AND fires the real DELETE /api/chats/c1 (irreversible backend delete).
    fireEvent.press(screen.getByTestId('chat-delete-c1'));
    expect(screen.getByTestId('chat-delete-confirm')).toBeTruthy();
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(2);
    fireEvent.press(screen.getByTestId('chat-delete-submit'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));
    expect(screen.queryByTestId('chat-row-c1')).toBeNull();
    expect(screen.queryByTestId('chat-delete-confirm')).toBeNull();
    await waitFor(() =>
      expect(
        gateway.requests.find(
          (r) => r.method === 'DELETE' && r.url === `${SANDBOX_BASE}/api/chats/c1`
        )
      ).toBeTruthy()
    );
  });

  it('delete confirmation can be cancelled (keeps the chat)', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(2), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));

    // Open the confirm, then cancel → the chat stays, the modal closes.
    fireEvent.press(screen.getByTestId('chat-delete-c0'));
    expect(screen.getByTestId('chat-delete-confirm')).toBeTruthy();
    fireEvent.press(screen.getByTestId('chat-delete-cancel'));
    await waitFor(() => expect(screen.queryByTestId('chat-delete-confirm')).toBeNull());
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(2);
    expect(screen.queryByTestId('chat-row-c0')).toBeTruthy();
  });

  it('switches between the Active and Archived tabs (separate lists)', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(2), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', chatsUrl(0, 'archived'), () => ({
      body: { chats: makeChats(3, 100), hasMore: false, totalCount: 3 } satisfies GetChatsResponse,
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    // Starts on the Active tab (2 chats from the non-archived endpoint).
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));
    expect(screen.getByTestId('chat-row-c0')).toBeTruthy();

    // Switch to Archived → the archived endpoint's 3 chats (c100..c102).
    fireEvent.press(screen.getByTestId('chat-tab-archived'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(3));
    expect(screen.getByTestId('chat-row-c100')).toBeTruthy();
    expect(screen.queryByTestId('chat-row-c0')).toBeNull();
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === chatsUrl(0, 'archived'))).toHaveLength(1)
    );

    // Switch back to Active → the original 2 chats (served from cache).
    fireEvent.press(screen.getByTestId('chat-tab-active'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));
    expect(screen.getByTestId('chat-row-c0')).toBeTruthy();
  });

  it('archiving a chat makes it appear in the Archived tab', async () => {
    // The Active list has c0; the Archived list starts EMPTY and only contains c0
    // once the backend has archived it — proving the Archived query REFETCHES after
    // the archive (a stale-empty cache would otherwise keep the tab blank: the bug).
    let archivedChats: ChatListItem[] = [];
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(1), hasMore: false, totalCount: 1 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', chatsUrl(0, 'archived'), () => ({
      body: {
        chats: archivedChats,
        hasMore: false,
        totalCount: archivedChats.length,
      } satisfies GetChatsResponse,
    }));
    gateway.on('PATCH', `${SANDBOX_BASE}/api/chats/c0/archive`, () => ({
      body: { success: true },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    // Active tab shows c0.
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));

    // Pre-load the (empty) Archived tab so its query is cached — this stale-empty
    // cache is exactly what used to hide the just-archived chat.
    fireEvent.press(screen.getByTestId('chat-tab-archived'));
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === chatsUrl(0, 'archived'))).toHaveLength(1)
    );
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(0);

    // Back to Active and archive c0 (the backend now lists it as archived).
    fireEvent.press(screen.getByTestId('chat-tab-active'));
    await waitFor(() => expect(screen.getByTestId('chat-row-c0')).toBeTruthy());
    fireEvent.press(screen.getByTestId('chat-archive-c0'));
    await waitFor(() =>
      expect(
        gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/chats/c0/archive`)
      ).toBeTruthy()
    );
    archivedChats = makeChats(1); // c0 is now in the archived set

    // Switch to Archived → the invalidated query REFETCHES (2nd request) and shows c0.
    fireEvent.press(screen.getByTestId('chat-tab-archived'));
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === chatsUrl(0, 'archived'))).toHaveLength(2)
    );
    await waitFor(() => expect(screen.getByTestId('chat-row-c0')).toBeTruthy());
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(1);
  });

  it('swipe-to-reveal gesture drives a row without disrupting its actions', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(1), hasMore: false, totalCount: 1 } satisfies GetChatsResponse,
    }));
    gateway.on('PATCH', `${SANDBOX_BASE}/api/chats/c0/archive`, () => ({
      body: { success: true },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));

    // Drive the reanimated pan gesture left (reveal). Under the gesture-handler jest
    // mock this exercises the gesture wiring without a native driver.
    act(() => {
      fireGestureHandler(getByGestureTestId('chat-swipe-c0'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: -40 },
        { state: State.ACTIVE, translationX: -120 },
        { state: State.END, translationX: -150 },
      ]);
    });

    // The row + its revealed actions are still mounted and functional.
    expect(screen.getByTestId('chat-row-c0')).toBeTruthy();
    fireEvent.press(screen.getByTestId('chat-archive-c0'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(0));
  });

  it('unarchive mutates the archived list state (PATCH archived=false)', async () => {
    gateway.on('GET', chatsUrl(0, 'archived'), () => ({
      body: { chats: makeChats(2), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));
    gateway.on('PATCH', `${SANDBOX_BASE}/api/chats/c0/archive`, () => ({
      body: { success: true },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), {
      initialUrl: '/chat/directory',
      directoryArchived: true,
    });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));

    fireEvent.press(screen.getByTestId('chat-unarchive-c0'));
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));
    expect(screen.queryByTestId('chat-row-c0')).toBeNull();
    await waitFor(() => {
      const req = gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/chats/c0/archive`);
      expect(req?.body).toEqual({ archived: false });
    });
  });

  it('shows the project-grouped view by default and the flat list on the Active tab', async () => {
    // Three chats across two repos; acme/widget is touched most recently (500).
    const chats: ChatListItem[] = [
      {
        id: 'a1',
        type: 'chat' as ChatListItem['type'],
        title: 'A1',
        repoFullName: 'acme/widget',
        lastUpdated: 100,
      },
      {
        id: 'b1',
        type: 'chat' as ChatListItem['type'],
        title: 'B1',
        repoFullName: 'globex/gadget',
        lastUpdated: 300,
      },
      {
        id: 'a2',
        type: 'chat' as ChatListItem['type'],
        title: 'A2',
        repoFullName: 'acme/widget',
        lastUpdated: 500,
      },
    ];
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats, hasMore: false, totalCount: 3 } satisfies GetChatsResponse,
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(3));
    // Default tab is "Project" → per-project headers appear and rows stay openable.
    await waitFor(() => expect(screen.getByTestId('chat-project-header-acme/widget')).toBeTruthy());
    expect(screen.getByTestId('chat-project-header-globex/gadget')).toBeTruthy();
    expect(screen.getByTestId('chat-open-a2')).toBeTruthy();
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(3);

    // The flat "Active" tab drops the project headers (same chats, flat recency list).
    fireEvent.press(screen.getByTestId('chat-tab-active'));
    await waitFor(() => expect(screen.queryByTestId('chat-project-header-acme/widget')).toBeNull());
    expect(screen.getByTestId('chat-directory-count').props.children).toBe(3);
  });

  it('navigates to a chat via Expo Router and hydrates its settings', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(2), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/chat/c1/settings`, () => ({
      body: {
        model: 'haiku',
        permissions: 'plan',
        agentSetupId: 'freestyle',
      },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));

    fireEvent.press(screen.getByTestId('chat-open-c1'));
    await waitFor(() => expect(screen.getByTestId('active-chat-id').props.children).toBe('c1'));

    await waitFor(() =>
      expect(screen.getByTestId('setting-model').props.children).toContain('haiku')
    );
    expect(screen.getByTestId('setting-permissions').props.children).toContain('plan');
    expect(screen.getByTestId('setting-agent').props.children).toContain('freestyle');
  });

  it('applies localStorage-equivalent defaults for a new chat with no settings', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(1), hasMore: false, totalCount: 1 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/chat/c0/settings`, () => ({
      status: 404,
      body: { error: 'not found' },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));
    fireEvent.press(screen.getByTestId('chat-open-c0'));
    await waitFor(() => expect(screen.getByTestId('active-chat-id').props.children).toBe('c0'));

    // New-chat defaults: opus / bypass_permissions / freestyle.
    await waitFor(() =>
      expect(screen.getByTestId('setting-model').props.children).toContain('opus')
    );
    expect(screen.getByTestId('setting-permissions').props.children).toContain(
      'bypass_permissions'
    );
    expect(screen.getByTestId('setting-agent').props.children).toContain('freestyle');
  });

  it('fork-on-first-write: a chat:forked for the OPEN id redirects to the new chat', async () => {
    // Both ids degrade to default settings (no row yet) so the active screen mounts.
    gateway.on('GET', `${SANDBOX_BASE}/api/chat/cc-sess/settings`, () => ({
      status: 404,
      body: { error: 'not found' },
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/chat/chat-fork-1/settings`, () => ({
      status: 404,
      body: { error: 'not found' },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/cc-sess' });

    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').props.children).toBe('cc-sess')
    );

    // The PC forked THIS chat → the screen navigates (router.replace) to the new id.
    act(() => {
      useSocketStore.getState().setLastForkedChat('cc-sess', 'chat-fork-1');
    });
    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').props.children).toBe('chat-fork-1')
    );
  });

  it('fork-on-first-write: a chat:forked for a DIFFERENT id does not redirect', async () => {
    gateway.on('GET', `${SANDBOX_BASE}/api/chat/cc-sess/settings`, () => ({
      status: 404,
      body: { error: 'not found' },
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/cc-sess' });

    await waitFor(() =>
      expect(screen.getByTestId('active-chat-id').props.children).toBe('cc-sess')
    );

    // A fork of some OTHER chat must not move this screen.
    act(() => {
      useSocketStore.getState().setLastForkedChat('other-chat', 'chat-fork-9');
    });
    // Give the effect a tick; the open id stays put.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('active-chat-id').props.children).toBe('cc-sess');
  });

  it('long-press → Save moves a chat to the Saved bucket (POST /save)', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(2), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', chatsUrl(0, 'saved'), () => ({
      body: { chats: [], hasMore: false, totalCount: 0 } satisfies GetChatsResponse,
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/c0/save`, () => ({ body: { success: true } }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));

    // Long-press opens the action sheet; Save drops the row + POSTs saved=true.
    fireEvent(screen.getByTestId('chat-open-c0'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-action-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('chat-action-save-c0'));

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));
    expect(screen.queryByTestId('chat-row-c0')).toBeNull();
    await waitFor(() => {
      const req = gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/chats/c0/save`);
      expect(req?.body).toEqual({ saved: true });
    });
  });

  it('long-press → Pin sends POST /pin and keeps the chat in the list', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(1), hasMore: false, totalCount: 1 } satisfies GetChatsResponse,
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/c0/pin`, () => ({ body: { success: true } }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));

    fireEvent(screen.getByTestId('chat-open-c0'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('chat-action-sheet')).toBeTruthy());
    fireEvent.press(screen.getByTestId('chat-action-pin-c0'));

    // Pin is orthogonal — the chat stays in the active list (count unchanged) and a
    // POST /pin pinned=true fires.
    await waitFor(() => {
      const req = gateway.requests.find((r) => r.url === `${SANDBOX_BASE}/api/chats/c0/pin`);
      expect(req?.body).toEqual({ pinned: true });
    });
    expect(screen.getByTestId('chat-row-c0')).toBeTruthy();
  });

  it('shows the Saved tab as its own bucket (category=saved)', async () => {
    gateway.on('GET', chatsUrl(0), () => ({
      body: { chats: makeChats(1), hasMore: false, totalCount: 1 } satisfies GetChatsResponse,
    }));
    gateway.on('GET', chatsUrl(0, 'saved'), () => ({
      body: { chats: makeChats(2, 50), hasMore: false, totalCount: 2 } satisfies GetChatsResponse,
    }));

    const client = buildClient(gateway);
    renderChatApp(client, newQueryClient(), { initialUrl: '/chat/directory' });

    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(1));

    fireEvent.press(screen.getByTestId('chat-tab-saved'));
    await waitFor(() =>
      expect(gateway.requests.filter((r) => r.url === chatsUrl(0, 'saved'))).toHaveLength(1)
    );
    await waitFor(() => expect(screen.getByTestId('chat-directory-count').props.children).toBe(2));
    expect(screen.getByTestId('chat-row-c50')).toBeTruthy();
    expect(screen.queryByTestId('chat-row-c0')).toBeNull();
  });
});
