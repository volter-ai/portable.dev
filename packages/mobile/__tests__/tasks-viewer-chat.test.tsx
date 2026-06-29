/**
 * Task viewer AI actions — `useViewerChat`.
 *
 * The viewer's "Start issue chat" / "Quick fix" / "Review with AI" /
 * "Quick Merge" buttons delegate to a new `claude_code` chat over the socket.
 * This standalone suite mounts the
 * REAL `SocketProvider` (the chat-composer precedent — a plain `render`, NOT
 * `renderRouter`, so it never mixes the two renderers) backed by the virtual
 * `socket.io-client` mock, brings the transport up, and asserts the
 * `chat:create` + `chat:message` wire payloads + navigation + the
 * `!connected` gate. (Kept OUT of `tasks-page.test.tsx`, which is
 * `renderRouter`-based — mixing `render` + `renderRouter` in one file tears
 * down the shared test renderer.)
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

jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});
// The viewer barrel transitively pulls MarkdownText (react-native-markdown-display).
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CLIENT_EVENTS } from '@vgit2/shared/socket';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike } from '../src/features/socket';
import { useChatStore, DEFAULT_NEW_CHAT_SETTINGS } from '../src/features/state';
import { useViewerChat, type ViewerChatStart } from '../src/features/tasks';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway, type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;
const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };
const inertAppState: AppStateLike = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};

/** Exposes `useViewerChat` so a press drives `start` with fixed args. */
function ViewerChatHarness({
  navigate,
  startArgs,
}: {
  navigate: (href: string) => void;
  startArgs: ViewerChatStart;
}) {
  const chat = useViewerChat({ navigate, makeChatId: () => 'chat-viewer-1' });
  return (
    <>
      <Text testID="vc-connected">{String(chat.connected)}</Text>
      <Pressable testID="vc-start" onPress={() => void chat.start(startArgs)}>
        <Text>start</Text>
      </Pressable>
    </>
  );
}

describe('useViewerChat — viewer AI actions', () => {
  let gateway: MockGateway;
  let queryClient: QueryClient | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    secureStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    onlineManager.setOnline(true);
    act(() => {
      useSocketStore.getState().reset();
      useChatStore.getState().setNewChatSettings(DEFAULT_NEW_CHAT_SETTINGS);
    });
    controller.reset();
  });

  afterEach(() => {
    act(() => useSocketStore.getState().reset());
    controller.reset();
    queryClient?.clear();
    queryClient = undefined;
    onlineManager.setOnline(true);
  });

  const startArgs: ViewerChatStart = {
    title: 'Issue #1: Fix the widget crash',
    prompt: 'PROMPT BODY',
    owner: 'acme',
    repo: 'widget',
  };

  async function mountHarness(navigate: jest.Mock, { withSocket = true } = {}) {
    const gwClient = new GatewayClient({
      gatewayUrl: gateway.baseUrl,
      fetchImpl: gateway.fetchImpl,
    });
    const client = new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
    queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const harness = <ViewerChatHarness navigate={navigate} startArgs={startArgs} />;
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={queryClient} netInfo={onlineNetInfo}>
          {withSocket ? (
            <SocketProvider
              getAuthToken={async () => 'good-token'}
              getRelayUrl={async () => SANDBOX_BASE}
              appState={inertAppState}
              netInfo={onlineNetInfo}
            >
              {harness}
            </SocketProvider>
          ) : (
            harness
          )}
        </ApiProvider>
      </SafeAreaProvider>
    );
    // Flush the async socket build (resolves token + URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('creates the chat, navigates, and sends the prompt when the socket is connected', async () => {
    const navigate = jest.fn();
    await mountHarness(navigate);

    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('vc-connected')).toHaveTextContent('true');

    await act(async () => {
      fireEvent.press(screen.getByTestId('vc-start'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // chat:create carries the new-chat prefs (defaults: opus / bypass / freestyle / off).
    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits).toHaveLength(1);
    expect(createEmits[0].args[0]).toMatchObject({
      chatId: 'chat-viewer-1',
      type: 'claude_code',
      title: 'Issue #1: Fix the widget crash',
      owner: 'acme',
      repo: 'widget',
      model: 'opus',
      permissions: 'bypass_permissions',
      agentSetupId: 'freestyle',
    });

    // The prompt streams in via chat:message, and we navigate to the new chat.
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect(msgEmits).toHaveLength(1);
    expect(msgEmits[0].args[0]).toMatchObject({ chatId: 'chat-viewer-1', content: 'PROMPT BODY' });
    expect(navigate).toHaveBeenCalledWith('/chat/chat-viewer-1');
  });

  it('honors the chosen new-chat prefs from the chat store', async () => {
    act(() => useChatStore.getState().setNewChatSettings({ model: 'haiku', permissions: 'plan' }));
    const navigate = jest.fn();
    await mountHarness(navigate);
    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('vc-start'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits[0].args[0]).toMatchObject({ model: 'haiku', permissions: 'plan' });
  });

  it('reports `connected: false` while the socket is mounted but down (drives the disabled button)', async () => {
    const navigate = jest.fn();
    await mountHarness(navigate);
    // Mounted but never connected → the viewer renders the AI buttons disabled.
    expect(screen.getByTestId('vc-connected')).toHaveTextContent('false');
  });

  it('no-ops with no SocketProvider above (the `!socket` guard) — never emits or navigates', async () => {
    const navigate = jest.fn();
    await mountHarness(navigate, { withSocket: false });
    expect(screen.getByTestId('vc-connected')).toHaveTextContent('false');

    await act(async () => {
      fireEvent.press(screen.getByTestId('vc-start'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE)).toHaveLength(
      0
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
