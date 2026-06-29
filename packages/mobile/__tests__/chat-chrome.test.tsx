/**
 * Git status banner, summaries, quick actions, container status.
 *
 * Mounts the per-chat `ChatChrome` band under both the authed TanStack Query
 * layer (`ApiProvider` + mocked sandbox HTTP) and the native Socket.IO provider
 * (mocked `socket.io-client`), and asserts:
 *
 *   1. the git status banner renders branch + ahead/behind + staged/modified/
 *      untracked from the backend `GET /api/repos/:owner/:repo/git-status`;
 *   2. the AI summary panel updates on the `chat:summary_updated` socket event;
 *   3. the quick-actions bar renders the backend `GET /quick-actions` actions;
 *   4. the container-status indicator reflects the `container:status` socket
 *      event, plus the runtime/tunnel indicator reflects `runtimeStore` state.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel transitively imports the MMKV-backed offline queue store —
// mock the native nitro module so importing the barrel is safe.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

// The socket provider chain + the authed sandbox client read the auth token +
// sandbox URL from SecureStore at module scope.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// The native NetInfo module must never load under Jest; connectivity is injected.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { SERVER_EVENTS } from '@vgit2/shared/socket';
import type { GetChatsResponse, GitStatus, QuickAction, TunnelData } from '@vgit2/shared/types';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { queryKeys } from '../src/features/api/keys';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import {
  buildChatQuickActions,
  ChatChrome,
  MAX_QUICK_ACTIONS,
  useChatChromeStore,
  useChatRepoPath,
} from '../src/features/chat/chrome';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import {
  SocketProvider,
  useOfflineMessageQueue,
  useSocket,
  useSocketStore,
} from '../src/features/socket';
import type { AppStateLike, AppStateStatus, NativeSocket } from '../src/features/socket';
import { useRuntimeStore } from '../src/features/state/runtimeStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway, type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

interface SecureStoreMock {
  __store: Map<string, string>;
}
const secureStore = jest.requireMock('expo-secure-store') as SecureStoreMock;

const SANDBOX_BASE = 'https://sandbox.portable.test';
const CHAT_ID = 'chat-1';
// Path convention: ~/claude-workspace/{email}/{owner}/{repo} → owner=acme, repo=widget.
const REPO_PATH = '~/claude-workspace/me@example.com/acme/widget';

const GIT_STATUS: GitStatus = {
  branch: 'feature/banner',
  ahead: 2,
  behind: 1,
  insertions: 10,
  deletions: 3,
  staged: 4,
  modified: 5,
  untracked: 6,
};

const QUICK_ACTIONS: QuickAction[] = [
  { id: 'start-app', label: 'Start app', type: 'message', prompt: 'bun run dev', icon: 'play' },
  { id: 'run-tests', label: 'Run tests', type: 'message', prompt: 'bun test' },
];

/** Inert AppState mock (no transitions needed). */
function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return { remove: () => (listener = null) };
      },
    },
    emit: (s) => listener?.(s),
  };
}

/** Inert NetInfo mock for the socket lifecycle. */
function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => (listener = null);
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

describe('chat chrome (git status, summary, quick actions, container status)', () => {
  let gateway: MockGateway;
  let activeQueryClient: QueryClient | undefined;

  function newQueryClient(): QueryClient {
    activeQueryClient = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    return activeQueryClient;
  }

  beforeEach(() => {
    secureStore.__store.clear();
    secureStore.__store.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.__store.set(AUTH_TOKEN_KEY, 'good-token');
    gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/git-status`, () => ({
      body: GIT_STATUS,
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/repos/acme/widget/quick-actions`, () => ({
      body: { quickActions: QUICK_ACTIONS },
    }));
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useChatChromeStore.getState().reset();
      useRuntimeStore.getState().reset();
    });
    controller.reset();
    activeQueryClient?.clear();
    activeQueryClient = undefined;
    onlineManager.setOnline(true);
  });

  async function mountChrome(): Promise<void> {
    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();
    render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={newQueryClient()}
        netInfo={netCtl.netInfo}
      >
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
        >
          <ChatChrome chatId={CHAT_ID} repoPath={REPO_PATH} />
        </SocketProvider>
      </ApiProvider>
    );
    // Flush the async socket-creation effect (resolves token + URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders the git status banner from the backend (branch + ahead/behind + staged/modified/untracked)', async () => {
    await mountChrome();

    // The git-status query resolves async; the branch node only appears once it does.
    await waitFor(() => {
      expect(screen.getByTestId('git-branch')).toBeTruthy();
    });
    expect(screen.getByTestId('git-status-banner')).toBeTruthy();
    expect(screen.getByTestId('git-branch')).toHaveTextContent('feature/banner');
    expect(screen.getByTestId('git-ahead')).toHaveTextContent(/2/);
    expect(screen.getByTestId('git-behind')).toHaveTextContent(/1/);
    expect(screen.getByTestId('git-staged')).toHaveTextContent(/4/);
    expect(screen.getByTestId('git-modified')).toHaveTextContent(/5/);
    expect(screen.getByTestId('git-untracked')).toHaveTextContent(/6/);
  });

  it('renders the quick-actions bar from the backend', async () => {
    await mountChrome();

    await waitFor(() => {
      expect(screen.getByTestId('quick-action-start-app')).toBeTruthy();
    });
    expect(screen.getByTestId('quick-actions-bar')).toBeTruthy();
    expect(screen.getByTestId('quick-action-run-tests')).toBeTruthy();
  });

  it('synthesizes a Restart pill for an active tunnel and never a game pill', async () => {
    await mountChrome();
    await waitFor(() => {
      expect(screen.getByTestId('quick-action-start-app')).toBeTruthy();
    });

    // No restart pill before a tunnel exists; games never surface on mobile.
    expect(screen.queryByTestId('quick-action-restart-tunnel-3000')).toBeNull();
    expect(screen.queryByTestId('quick-action-open-games')).toBeNull();

    const tunnel: TunnelData = {
      port: 3000,
      url: 'https://t.example.run',
      name: 'dev',
      createdAt: 1,
      createdByRepoPath: REPO_PATH,
    };
    act(() => {
      useRuntimeStore.getState().setTunnels([tunnel]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('quick-action-restart-tunnel-3000')).toBeTruthy();
    });
    // The pill is two Text nodes ("Restart " + bold "dev") → match with a regex
    // (a bare string is an exact concatenation match — documented chrome gotcha).
    expect(screen.getByTestId('quick-action-restart-tunnel-3000')).toHaveTextContent(/Restart/);
    expect(screen.getByTestId('quick-action-restart-tunnel-3000')).toHaveTextContent(/dev/);
    // Games are deliberately not included on mobile.
    expect(screen.queryByTestId('quick-action-open-games')).toBeNull();
  });

  it('sends the action prompt as a chat message when a quick action is tapped', async () => {
    // Mirror the ActiveChatScreen wiring: a tapped message-type pill sends its
    // prompt through the offline-tolerant queue → the socket `chat:message` emit.
    function ChatChromeWithSend() {
      const socket = useSocket();
      const queue = useOfflineMessageQueue({ socket });
      return (
        <ChatChrome
          chatId={CHAT_ID}
          repoPath={REPO_PATH}
          onQuickAction={(action) => {
            if (action.type === 'message') void queue.send(CHAT_ID, action.prompt, 'qa-msg-1');
          }}
        />
      );
    }

    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();
    render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={newQueryClient()}
        netInfo={netCtl.netInfo}
      >
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
        >
          <ChatChromeWithSend />
        </SocketProvider>
      </ApiProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A live socket so the send emits immediately (instead of enqueueing).
    act(() => {
      controller.setConnected(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId('quick-action-start-app')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('quick-action-start-app'));
      await Promise.resolve();
    });

    const sent = controller.emissions.find(
      (e) => (e.args[0] as { content?: string } | undefined)?.content === 'bun run dev'
    );
    expect(sent).toBeTruthy();
    expect((sent!.args[0] as { chatId: string }).chatId).toBe(CHAT_ID);
  });

  it('updates the summary panel on chat:summary_updated', async () => {
    await mountChrome();

    // No summary before the event.
    expect(screen.queryByTestId('chat-summary-panel')).toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_SUMMARY_UPDATED, {
        chatId: CHAT_ID,
        summary: 'Adding the chat chrome band',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('chat-summary-text')).toHaveTextContent(
        'Adding the chat chrome band'
      );
    });
  });

  it('folds chat:linkedIssueUpdated into the chrome store (link + unlink)', async () => {
    await mountChrome();

    // No linked issue before the event.
    expect(useChatChromeStore.getState().linkedIssues[CHAT_ID]).toBeUndefined();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_LINKED_ISSUE_UPDATED, {
        chatId: CHAT_ID,
        linkedIssue: { owner: 'acme', repo: 'widget', number: 7 },
      });
    });
    await waitFor(() => {
      expect(useChatChromeStore.getState().linkedIssues[CHAT_ID]).toEqual({
        owner: 'acme',
        repo: 'widget',
        number: 7,
      });
    });

    // An explicit unlink (`linkedIssue: null`) stores null → the badge hides.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_LINKED_ISSUE_UPDATED, {
        chatId: CHAT_ID,
        linkedIssue: null,
      });
    });
    await waitFor(() => {
      expect(useChatChromeStore.getState().linkedIssues[CHAT_ID]).toBeNull();
    });
  });

  it('reflects the container-status socket event plus runtime/tunnel state', async () => {
    await mountChrome();

    // No container banner before the event.
    expect(screen.queryByTestId('container-status-banner')).toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CONTAINER_STATUS, {
        chatId: CHAT_ID,
        status: 'creating',
        message: 'Setting up your workspace…',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('container-status-message')).toHaveTextContent(
        'Setting up your workspace…'
      );
    });
    // creating → animated spinner (not the ready checkmark).
    expect(screen.getByTestId('container-status-spinner')).toBeTruthy();

    // Runtime/tunnel indicator reflects a tunnel created by this chat's repo.
    const tunnel: TunnelData = {
      port: 3000,
      url: 'https://t.example.run',
      name: 'dev',
      createdAt: 1,
      createdByRepoPath: REPO_PATH,
    };
    act(() => {
      useRuntimeStore.getState().setTunnels([tunnel]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('runtime-indicator')).toBeTruthy();
    });
    expect(screen.getByTestId('runtime-tunnels')).toHaveTextContent(/1/);
  });

  it('resolves repoPath from the chat:created sink for a chat never seen by the directory cache (repo hand-off)', async () => {
    // A chat opened straight from creation (repo Overview "Work on {repo}...")
    // has no chat-directory cache entry — `useChatRepoPath` must pick the
    // repo_path up from the `chat:created` broadcast, reactively.
    function RepoPathProbe() {
      const repoPath = useChatRepoPath(CHAT_ID);
      return <Text testID="probe-repo-path">{repoPath ?? 'none'}</Text>;
    }

    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();
    render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={newQueryClient()}
        netInfo={netCtl.netInfo}
      >
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
        >
          <RepoPathProbe />
        </SocketProvider>
      </ApiProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('probe-repo-path')).toHaveTextContent('none');

    act(() => {
      controller.setConnected(true);
      controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
        chat: { id: CHAT_ID, repo_path: REPO_PATH },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('probe-repo-path')).toHaveTextContent(REPO_PATH);
    });
  });

  it('resolves repoPath from the ["chats"] cache when ["chat-directory"] is cold and chrome store is empty — Home cold-tap (AC1)', async () => {
    // Simulate: cold app launch, user taps a "Continue chats" card on Home before
    // ever opening the Chat tab. Only the recent-chats list (['chats']) is warm;
    // chat-directory and chrome store are both empty.
    function RepoPathProbe() {
      const repoPath = useChatRepoPath(CHAT_ID);
      return <Text testID="probe-repo-path">{repoPath ?? 'none'}</Text>;
    }

    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();
    const qc = newQueryClient();

    // Seed ['chats'] as ChatHomeScreen's useChats() would after a successful fetch.
    qc.setQueryData<GetChatsResponse>(queryKeys.chats(), {
      chats: [{ id: CHAT_ID, type: 'claude_code', title: 'widget work', repo_path: REPO_PATH }],
      hasMore: false,
      totalCount: 1,
    });

    render(
      <ApiProvider client={buildClient(gateway)} queryClient={qc} netInfo={netCtl.netInfo}>
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
        >
          <RepoPathProbe />
        </SocketProvider>
      </ApiProvider>
    );

    // The ['chats'] cache is synchronously readable — the hook resolves immediately.
    expect(screen.getByTestId('probe-repo-path')).toHaveTextContent(REPO_PATH);
  });

  it('renders the git banner from the optimistic create-ack seed when no chat:created broadcast arrives (old-backend fallback)', async () => {
    // End-to-end over the ActiveChatScreen wiring: create a chat through the
    // provider's (wrapped) emitters with the server broadcast deliberately
    // ABSENT — the ack-time seed alone must resolve `useChatRepoPath` and let
    // `ChatChrome` render the git status banner for the new chat's repo.
    const NEW_CHAT = 'chat-fresh';
    const apiHolder: { api: NativeSocket | null } = { api: null };
    function FreshChatChrome() {
      apiHolder.api = useSocket();
      const repoPath = useChatRepoPath(NEW_CHAT);
      return <ChatChrome chatId={NEW_CHAT} repoPath={repoPath} />;
    }

    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();
    render(
      <ApiProvider
        client={buildClient(gateway)}
        queryClient={newQueryClient()}
        netInfo={netCtl.netInfo}
      >
        <SocketProvider
          getAuthToken={async () => 'good-token'}
          getRelayUrl={async () => SANDBOX_BASE}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
        >
          <FreshChatChrome />
        </SocketProvider>
      </ApiProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No repoPath yet → the git-status query is disabled, no branch chip (the
    // banner SHELL always renders — its trailing slot element is always passed,
    // so probe `git-branch`, the data-driven node; documented chrome gotcha).
    expect(screen.queryByTestId('git-branch')).toBeNull();

    act(() => {
      controller.setConnected(true);
    });
    await act(async () => {
      await apiHolder.api!.emitters.createChat({
        chatId: NEW_CHAT,
        type: 'claude_code',
        title: 'work on widget',
        owner: 'acme',
        repo: 'widget',
        model: 'sonnet',
        permissions: 'bypass_permissions',
        agentSetupId: 'best-practice',
      });
    });

    // The seeded `~/claude-workspace/user/acme/widget` parses to acme/widget →
    // the git-status query fires and the branch chip appears.
    await waitFor(() => {
      expect(screen.getByTestId('git-branch')).toBeTruthy();
    });
    expect(screen.getByTestId('git-branch')).toHaveTextContent('feature/banner');
  });
});

describe('buildChatQuickActions (server shortcut synthesis)', () => {
  const tunnel: TunnelData = {
    port: 3000,
    url: 'https://t.example.run',
    name: 'dev',
    createdAt: 1,
    createdByRepoPath: REPO_PATH,
  };

  it('synthesizes a Restart pill (above the backend actions) per active tunnel', () => {
    const backend: QuickAction[] = [
      {
        id: 'start-app',
        label: 'Start app',
        type: 'message',
        prompt: 'bun run dev',
        priority: 100,
      },
    ];
    const actions = buildChatQuickActions(backend, [tunnel], 'acme/widget');

    expect(actions.map((a) => a.id)).toEqual(['restart-tunnel-3000', 'start-app']);
    const restart = actions[0];
    expect(restart.label).toBe('Restart ');
    expect(restart.labelBold).toBe('dev');
    expect(restart.icon).toBe('rotate-right');
    expect(restart.type).toBe('message');
    if (restart.type === 'message') {
      expect(restart.prompt).toContain("Restart the 'dev' server at port 3000 for acme/widget");
      expect(restart.prompt).toContain('https://t.example.run');
    }
  });

  it('never synthesizes a game / runtime action (games are out of scope on mobile)', () => {
    const actions = buildChatQuickActions([], [tunnel], 'acme/widget');
    expect(actions.some((a) => a.id === 'open-games')).toBe(false);
    expect(actions.some((a) => a.type === 'runtime')).toBe(false);
  });

  it('skips restart pills when the repo is unresolved (local / null)', () => {
    expect(buildChatQuickActions([], [tunnel], null)).toEqual([]);
  });

  it('sorts by priority (desc) and caps at MAX_QUICK_ACTIONS', () => {
    const backend: QuickAction[] = Array.from({ length: 7 }, (_, i) => ({
      id: `a${i}`,
      label: `A${i}`,
      type: 'message',
      prompt: `p${i}`,
      priority: i,
    }));
    const actions = buildChatQuickActions(backend, [tunnel], 'acme/widget');

    expect(actions).toHaveLength(MAX_QUICK_ACTIONS);
    expect(actions[0].id).toBe('restart-tunnel-3000'); // priority 105
    expect(actions[1].id).toBe('a6'); // highest backend priority
    expect(actions.some((a) => a.id === 'a0')).toBe(false); // lowest two capped out
  });
});
