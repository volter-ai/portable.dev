/**
 * portable.dev#17 — start a chat FROM a worktree (WorktreeChatComposer).
 *
 * Drives the docked composer the worktree-scoped Changes surfaces render —
 * now the SAME widget as the repo Overview ({@link RepoChatInput}: the shared
 * ShortFormComposer card + slash-command picker). Verifies:
 *
 *   1. submitting emits `chat:create` with the WORKTREE path + `chat:message`
 *      with the typed text, then navigates to the new chat;
 *   2. a failed create ack restores the input and never navigates;
 *   3. without a socket provider the send button stays disabled (degraded, not
 *      a crash).
 *
 * The socket barrel is mocked at the module boundary (`useOptionalSocket`) —
 * the composer's only socket surface is the two emitters, so a recording fake
 * is the honest seam (the wire itself is `startRepoChatFlow`'s unit tests +
 * the backend's chat-create-worktree tests). The HTTP side (the slash-command
 * catalog the shared widget loads) rides the sibling suites' mock-gateway
 * harness.
 */

// In-memory keychain for expo-secure-store (relay URL + authToken live here).
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

// The composer reads the socket through `useOptionalSocket` only. `null`
// (default) = no provider; a test installs a recording fake via `setSocket`.
let mockSocket: unknown = null;
jest.mock('../src/features/socket', () => ({
  useOptionalSocket: () => mockSocket,
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { ChatCreatePayload, ChatMessagePayload } from '@vgit2/shared/socket';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { WorktreeChatComposer } from '../src/features/repo/WorktreeChatComposer';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway } from '../src/test';

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const OWNER = 'octocat';
const REPO = 'hello-world';
const WORKTREE = '/ws/hello-world/.worktrees/17';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

interface RecordingSocket {
  created: ChatCreatePayload[];
  sent: ChatMessagePayload[];
}

function installSocket(opts: { failCreate?: boolean } = {}): RecordingSocket {
  const created: ChatCreatePayload[] = [];
  const sent: ChatMessagePayload[] = [];
  mockSocket = {
    emitters: {
      createChat: async (payload: ChatCreatePayload) => {
        created.push(payload);
        return opts.failCreate ? { success: false, error: 'nope' } : { success: true };
      },
      sendMessage: async (payload: ChatMessagePayload) => {
        sent.push(payload);
        return { success: true };
      },
    },
  };
  return { created, sent };
}

describe('WorktreeChatComposer (start a chat from a worktree)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function mount(navigate: (path: string) => void = () => {}) {
    activeQueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const gwClient = new GatewayClient({
      gatewayUrl: gateway.baseUrl,
      fetchImpl: gateway.fetchImpl,
    });
    const client = new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
    return render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={activeQueryClient} netInfo={onlineNetInfo}>
          <WorktreeChatComposer
            owner={OWNER}
            repo={REPO}
            worktree={WORKTREE}
            branchLabel="feat/17-x"
            navigate={navigate}
            makeChatId={() => 'chat-wt-test'}
          />
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
    // The shared RepoChatInput loads the repo slash-command catalog.
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/${OWNER}/${REPO}/commands`, () => ({
      body: { commands: [] },
    }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    mockSocket = null;
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  it('emits chat:create with the worktree + sends the message, then navigates', async () => {
    const socket = installSocket();
    const navigated: string[] = [];
    mount((path) => navigated.push(path));

    expect(screen.getByPlaceholderText('Start a chat in feat/17-x…')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('worktree-chat-input'), 'Fix the flaky test');
    fireEvent.press(screen.getByTestId('worktree-chat-send'));

    await waitFor(() => expect(navigated).toEqual(['chat-wt-test']));
    expect(socket.created).toHaveLength(1);
    expect(socket.created[0]).toMatchObject({
      chatId: 'chat-wt-test',
      owner: OWNER,
      repo: REPO,
      worktree: WORKTREE,
      title: 'Fix the flaky test',
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      chatId: 'chat-wt-test',
      content: 'Fix the flaky test',
    });
    // The input clears after a successful hand-off.
    expect(screen.getByTestId('worktree-chat-input').props.value).toBe('');
  });

  it('restores the input (and never navigates) when the create ack fails', async () => {
    installSocket({ failCreate: true });
    const navigated: string[] = [];
    mount((path) => navigated.push(path));

    fireEvent.changeText(screen.getByTestId('worktree-chat-input'), 'Fix the flaky test');
    fireEvent.press(screen.getByTestId('worktree-chat-send'));

    await waitFor(() =>
      expect(screen.getByTestId('worktree-chat-input').props.value).toBe('Fix the flaky test')
    );
    expect(navigated).toEqual([]);
  });

  it('keeps the send button disabled without a socket provider (degraded, no crash)', () => {
    mount();

    fireEvent.changeText(screen.getByTestId('worktree-chat-input'), 'Fix the flaky test');
    expect(screen.getByTestId('worktree-chat-send').props.accessibilityState?.disabled).toBe(true);
  });
});
