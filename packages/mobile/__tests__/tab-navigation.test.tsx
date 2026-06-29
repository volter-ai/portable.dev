/**
 * Bottom-tab navigation + route wiring.
 *
 * Mounts the REAL authenticated tab group (`app/(app)/(tabs)/_layout` + the
 * tab route shells) inside a real Expo Router (`renderRouter`) under the full
 * provider stack (`ApiProvider` + `SocketProvider`), then asserts that pressing
 * each tab navigates to its screen — the per-screen root testID renders:
 *
 *   Home (`/`)           → ChatHomeScreen      (`chat-home`)
 *   Repo (`/repos`)      → RepoListScreen      (`repo-list`)
 *   Tasks (`/tasks`)     → TasksScreen         (`tasks-screen`)
 *   Chat (`/chats`)      → ChatDirectoryScreen (`chat-directory`)
 *   Runtime (`/runtime`) → RuntimeBox          (`runtime-box`)
 *
 * Settings has NO tab button (`href: null`) but `/settings` stays
 * routable — asserted via an imperative `router.push('/settings')` (the Home
 * profile pill's navigation path).
 *
 * The screens degrade gracefully without live data (root testIDs render
 * regardless), so this test verifies the NAVIGATION wiring, not the data loads —
 * those are covered by each screen's own integration test. A `retry: false`
 * QueryClient keeps the screens' on-mount queries from leaving open handles.
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

// The socket provider chain builds the transport via socket.io-client.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The chat barrel transitively imports VoiceInput → expo-audio, and the block
// renderers → react-native-markdown-display.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// SettingsScreen reads the profile avatar / sign-out via Clerk, and the avatar
// picker imports expo-image-picker at module scope.
jest.mock('@clerk/clerk-expo', () => {
  const setProfileImage = jest.fn(async () => ({}));
  const signOut = jest.fn(async () => {});
  const user = {
    fullName: 'Ada Lovelace',
    username: 'ada',
    hasImage: false,
    imageUrl: null,
    primaryEmailAddress: { emailAddress: 'ada@example.com' },
    setProfileImage,
  };
  return {
    __mock: { setProfileImage, signOut, user },
    useUser: () => ({ isLoaded: true, isSignedIn: true, user }),
    useClerk: () => ({ signOut }),
  };
});
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));

// LOAD ORDER MATTERS — keep this FIRST. ActiveChatScreen now mounts the
// ChatRuntimeBubble (react-native-reanimated). `expo-router/testing-library`
// self-registers a broken `{}` reanimated mock at import time that beats the
// moduleNameMapper stub; importing the chat feature HERE, before it, lets the
// reanimated consumers capture the working stub first (the chat-directory precedent).
import '../src/features/chat';

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router, Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TabsLayout from '../app/(app)/(tabs)/_layout';
import HomeTab from '../app/(app)/(tabs)/index';
import ActiveChatRoute from '../app/(app)/(tabs)/chat/[chatId]';
import ChatsTab from '../app/(app)/(tabs)/chats';
import ReposTab from '../app/(app)/(tabs)/repos';
import RuntimeTab from '../app/(app)/(tabs)/runtime';
import SettingsTab from '../app/(app)/(tabs)/settings';
import TasksTab from '../app/(app)/(tabs)/tasks';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, AppStateStatus } from '../src/features/socket';
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

/** Always-online NetInfo + inert AppState (connectivity/lifecycle aren't under test). */
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };
const inertAppState: AppStateLike = {
  currentState: 'active' as AppStateStatus,
  addEventListener: () => ({ remove: () => {} }),
};

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('bottom-tab navigation + route wiring', () => {
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

  /** Render the real tab group under the full provider stack. */
  function renderTabs() {
    const client = buildClient(gateway);
    queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const qc = queryClient;

    function ProvidersLayout() {
      return (
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
            <SocketProvider
              getAuthToken={async () => 'good-token'}
              getRelayUrl={async () => SANDBOX_BASE}
              appState={inertAppState}
              netInfo={onlineNetInfo}
            >
              <Slot />
            </SocketProvider>
          </ApiProvider>
        </SafeAreaProvider>
      );
    }

    return renderRouter(
      {
        _layout: ProvidersLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': HomeTab,
        '(tabs)/chats': ChatsTab,
        '(tabs)/repos': ReposTab,
        '(tabs)/tasks': TasksTab,
        '(tabs)/runtime': RuntimeTab,
        '(tabs)/settings': SettingsTab,
        '(tabs)/chat/[chatId]': ActiveChatRoute,
      },
      { initialUrl: '/' }
    );
  }

  it('mounts the Home tab at `/` with the configured tab order (no Settings tab)', async () => {
    renderTabs();
    expect(await screen.findByTestId('chat-home')).toBeTruthy();
    // Exactly five tab buttons, in the configured bar order.
    expect(screen.getAllByTestId(/^tab-button-/).map((node) => node.props.testID)).toEqual([
      'tab-button-home',
      'tab-button-chats',
      'tab-button-repos',
      'tab-button-tasks',
      'tab-button-runtime',
    ]);
    // Settings left the bar — the route stays (see the last test).
    expect(screen.queryByTestId('tab-button-settings')).toBeNull();
  });

  it('navigates to each tab screen when its tab button is pressed', async () => {
    renderTabs();
    await screen.findByTestId('chat-home');

    fireEvent.press(screen.getByTestId('tab-button-repos'));
    expect(await screen.findByTestId('repo-list')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tab-button-tasks'));
    expect(await screen.findByTestId('tasks-screen')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tab-button-chats'));
    expect(await screen.findByTestId('chat-directory')).toBeTruthy();

    fireEvent.press(screen.getByTestId('tab-button-runtime'));
    expect(await screen.findByTestId('runtime-box')).toBeTruthy();

    // Back to Home — the composer is still reachable.
    fireEvent.press(screen.getByTestId('tab-button-home'));
    expect(await screen.findByTestId('chat-home')).toBeTruthy();
  });

  it('keeps the bottom tab bar visible on the active chat screen', async () => {
    const app = renderTabs();
    await screen.findByTestId('chat-home');

    // The real entry points (`chat-open-<id>`, "Continue chats", AI actions) all
    // run `router.push('/chat/:id')` — drive the same imperative navigation.
    act(() => router.push('/chat/c1'));
    expect(await screen.findByTestId('active-chat')).toBeTruthy();

    // The chat detail renders INSIDE the `(tabs)` group — that placement is what
    // keeps the tab bar mounted under it (a stack push over the group covers it).
    expect(app.getSegments()).toEqual(['(tabs)', 'chat', '[chatId]']);

    // All five tab buttons are still present, and the hidden chat route
    // (`href: null`) added no sixth button.
    expect(screen.getAllByTestId(/^tab-button-/)).toHaveLength(5);

    // Tabs stay functional from inside an open chat.
    fireEvent.press(screen.getByTestId('tab-button-home'));
    expect(await screen.findByTestId('chat-home')).toBeTruthy();
  });

  it('keeps `/settings` reachable through the Home profile pill (the only entry point)', async () => {
    renderTabs();
    await screen.findByTestId('chat-home');

    // The REAL user path: with the Settings tab gone, the pill's
    // `router.push('/settings')` wiring is what keeps Settings reachable.
    fireEvent.press(screen.getByTestId('home-profile-pill'));
    expect(await screen.findByTestId('settings-screen')).toBeTruthy();
  });

  it('re-focusing the Tasks tab force-refreshes both views', async () => {
    renderTabs();
    await screen.findByTestId('chat-home');

    // First focus = mount. The post-cached refresh kick never fires here (the
    // tasks endpoints are unregistered → the cached loads 404), so any
    // /refresh traffic below can only come from the RE-focus effect.
    fireEvent.press(screen.getByTestId('tab-button-tasks'));
    await screen.findByTestId('tasks-screen');

    fireEvent.press(screen.getByTestId('tab-button-home'));
    await screen.findByTestId('chat-home');

    fireEvent.press(screen.getByTestId('tab-button-tasks'));
    await screen.findByTestId('tasks-screen');
    await waitFor(() => {
      const refreshes = gateway.requests.filter((r) =>
        r.url.includes('/api/user/tasks/refresh?view=')
      );
      expect(refreshes.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps the socket transport live under the tab stack', async () => {
    const socketMock = jest.requireMock('socket.io-client') as {
      __controller: { setConnected: (c: boolean) => void };
    };
    renderTabs();
    await screen.findByTestId('chat-home');
    // The SocketProvider builds asynchronously; once connected the runtime/chat
    // screens that consume `useOptionalSocket` get a live transport.
    const { act, waitFor } = require('@testing-library/react-native');
    await waitFor(() => {
      act(() => socketMock.__controller.setConnected(true));
      expect(useSocketStore.getState().connected).toBe(true);
    });
  });
});
