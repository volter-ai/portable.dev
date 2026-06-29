/**
 * RN socket provider on the shared core.
 *
 * Drives the native Socket.IO provider end-to-end with a mocked Socket.IO server
 * (the virtual `socket.io-client` mock) and injected AppState + NetInfo
 * controllers, asserting:
 *
 *   1. the provider reconnects + resyncs joined rooms when AppState transitions
 *      to `active`;
 *   2. the provider reconnects + resyncs on an offline → online NetInfo
 *      transition;
 *   3. `socketio:connected` / `socketio:disconnected` / `socketio:reconnecting`
 *      surface as Zustand state (`useSocketStore`) — never `window.dispatchEvent`;
 *   4. `chat:created` surfaces as Zustand state AND the `onChatCreated` callback —
 *      again never `window.dispatchEvent`.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel now re-exports the offline-queue hook, which
// transitively imports the MMKV-backed offline queue store. MMKV is a native
// nitro module — mock it so importing the barrel doesn't load the JSI module.
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

import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type CreateSocketOptions,
  type SocketLike,
} from '@vgit2/shared/socket';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import {
  optimisticRepoPath,
  useChatChromeStore,
} from '../src/features/chat/chrome/chatChromeStore';
import {
  SocketProvider,
  useSocket,
  useSocketStore,
  type NativeSocket,
} from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { createMockSocket, type MockSocketIoModule } from '../src/test';

/** The controller backing the single socket the mocked `io()` hands out. */
const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

/** Imperatively-driven AppState mock. */
function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return {
          remove: () => {
            listener = null;
          },
        };
      },
    },
    emit: (s) => listener?.(s),
  };
}

/** Imperatively-driven NetInfo mock. */
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

/** Renders the live connection state from the Zustand store (no DOM events). */
function StateProbe() {
  const connectionState = useSocketStore((s) => s.connectionState);
  const lastCreatedChatId = useSocketStore((s) => s.lastCreatedChatId);
  return (
    <>
      <Text testID="conn">{connectionState}</Text>
      <Text testID="created">{lastCreatedChatId ?? 'none'}</Text>
    </>
  );
}

/** Captures the imperative socket API so the test can call `joinChat`. */
function CaptureApi({ onReady }: { onReady: (api: NativeSocket) => void }) {
  const api = useSocket();
  onReady(api);
  return null;
}

const joinEmissions = () => controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_JOIN);

describe('RN socket provider on the shared core', () => {
  let appCtl: ReturnType<typeof createAppStateController>;
  let netCtl: ReturnType<typeof createNetInfoController>;

  async function mountProvider(opts: { onChatCreated?: (id: string) => void } = {}): Promise<{
    api: NativeSocket;
  }> {
    const apiHolder: { api: NativeSocket | null } = { api: null };
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        onChatCreated={opts.onChatCreated}
      >
        <CaptureApi onReady={(a) => (apiHolder.api = a)} />
        <StateProbe />
      </SocketProvider>
    );
    // Flush the async socket-creation effect (resolves token + sandbox URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return { api: apiHolder.api! };
  }

  beforeEach(() => {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
  });

  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useChatChromeStore.getState().reset();
    });
    controller.reset();
  });

  it('reconnects + resyncs joined rooms when AppState transitions to active', async () => {
    const { api } = await mountProvider();

    // Initial connect → Zustand state 'connected' (replaces socketio:connected DOM event).
    act(() => {
      controller.setConnected(true);
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');

    // Join a room (tracked for resync) — emits chat:join once.
    await act(async () => {
      await api.joinChat({ chatId: 'chat-1', limit: 50, offset: 0 });
    });
    expect(joinEmissions()).toHaveLength(1);

    // Socket drops → Zustand 'disconnected' (replaces socketio:disconnected DOM event).
    act(() => {
      controller.setConnected(false);
    });
    expect(screen.getByTestId('conn').props.children).toBe('disconnected');

    // Foreground (AppState 'active') → reconnect + resync (rejoin chat-1).
    act(() => {
      appCtl.emit('active');
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');
    // Resync re-emitted chat:join for the tracked room.
    expect(joinEmissions()).toHaveLength(2);
    expect(joinEmissions()[1].args[0]).toMatchObject({ chatId: 'chat-1' });
  });

  it("surfaces the 'reconnecting' phase as Zustand state while reconnecting", async () => {
    await mountProvider();

    act(() => {
      controller.setConnected(true);
    });
    act(() => {
      controller.setConnected(false);
    });
    // A connect_error during reconnection surfaces as Zustand 'reconnecting' state
    // (this replaces the old window.dispatchEvent('socketio:reconnecting')).
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CONNECT_ERROR, new Error('boom'));
    });
    expect(screen.getByTestId('conn').props.children).toBe('reconnecting');
  });

  it('reconnects + resyncs on an offline → online NetInfo transition', async () => {
    const { api } = await mountProvider();

    act(() => {
      controller.setConnected(true);
    });
    await act(async () => {
      await api.joinChat({ chatId: 'chat-2', limit: 50, offset: 0 });
    });

    // Go offline (socket drops), then back online → proactive reconnect + resync.
    act(() => {
      controller.setConnected(false);
      netCtl.emit(false);
    });
    expect(screen.getByTestId('conn').props.children).toBe('disconnected');

    act(() => {
      netCtl.emit(true);
    });
    expect(screen.getByTestId('conn').props.children).toBe('connected');
    expect(joinEmissions()).toHaveLength(2); // initial + reconnect resync
  });

  it("surfaces 'chat:created' via Zustand state + onChatCreated callback (not window.dispatchEvent)", async () => {
    const onChatCreated = jest.fn();
    const dispatchSpy =
      typeof globalThis !== 'undefined' && (globalThis as { dispatchEvent?: unknown }).dispatchEvent
        ? jest.spyOn(globalThis as unknown as { dispatchEvent: () => boolean }, 'dispatchEvent')
        : null;

    await mountProvider({ onChatCreated });

    act(() => {
      controller.setConnected(true);
      controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
        chat: { id: 'chat-xyz', repo_path: '/workspace/claude-workspace/u/acme/widget' },
      });
    });

    expect(screen.getByTestId('created').props.children).toBe('chat-xyz');
    expect(onChatCreated).toHaveBeenCalledWith('chat-xyz');
    expect(useSocketStore.getState().lastCreatedChatId).toBe('chat-xyz');
    // The broadcast chat's repo_path is folded into the chrome store — the only
    // repoPath source for a chat opened straight from creation (repo hand-off),
    // which never exists in the chat-directory query cache.
    expect(useChatChromeStore.getState().repoPaths['chat-xyz']).toBe(
      '/workspace/claude-workspace/u/acme/widget'
    );
    if (dispatchSpy) {
      expect(dispatchSpy).not.toHaveBeenCalled();
      dispatchSpy.mockRestore();
    }
  });

  it("records 'chat:forked' into lastForkedChat (the redirect signal) with a monotonic seq", async () => {
    await mountProvider();

    act(() => {
      controller.setConnected(true);
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, {
        oldChatId: 'cc-sess',
        newChatId: 'chat-fork-1',
      });
    });

    const first = useSocketStore.getState().lastForkedChat;
    expect(first).toEqual({ oldChatId: 'cc-sess', newChatId: 'chat-fork-1', seq: 1 });

    // A second fork (even of a different pair) bumps seq so the consumer effect re-fires.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, {
        oldChatId: 'cc-sess-2',
        newChatId: 'chat-fork-2',
      });
    });
    expect(useSocketStore.getState().lastForkedChat).toEqual({
      oldChatId: 'cc-sess-2',
      newChatId: 'chat-fork-2',
      seq: 2,
    });

    // A malformed event (missing newChatId) is ignored.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_FORKED, { oldChatId: 'x' });
    });
    expect(useSocketStore.getState().lastForkedChat?.seq).toBe(2);
  });

  // a chat opened straight from creation (repo Overview hand-off, home
  // composer, task viewer) must show the git banner even when the server's
  // `chat:created` broadcast is missing (older backend): the provider's
  // `createChat` seeds an optimistic, `getRepoFromPath`-parseable repo path on a
  // successful ack, and the authoritative broadcast value always wins over it.
  describe('optimistic repo-path seed on chat:create', () => {
    const createPayload = {
      chatId: 'chat-new',
      type: 'claude_code' as const,
      title: 'work on widget',
      owner: 'acme',
      repo: 'widget',
      model: 'sonnet',
      permissions: 'bypass_permissions',
      agentSetupId: 'best-practice',
    };

    it('seeds a parseable repo path for the created chat on a successful ack', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      const seeded = useChatChromeStore.getState().repoPaths['chat-new'];
      expect(seeded).toBe(optimisticRepoPath('acme', 'widget'));
      // The contract the git banner actually needs: owner/repo parse out of it.
      expect(getRepoFromPath(seeded)).toBe('acme/widget');
    });

    it('does not seed when the chat:create ack fails', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
        controller.setAck(CLIENT_EVENTS.CHAT_CREATE, { success: false, error: 'prepare failed' });
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBeUndefined();
    });

    it('lets the authoritative chat:created repo_path overwrite the seed', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });
      act(() => {
        controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
          chat: { id: 'chat-new', repo_path: '/workspace/claude-workspace/u@x.com/acme/widget' },
        });
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBe(
        '/workspace/claude-workspace/u@x.com/acme/widget'
      );
    });

    it('never overwrites an already-arrived authoritative path (broadcast-before-ack order)', async () => {
      const { api } = await mountProvider();
      act(() => {
        controller.setConnected(true);
        // On the creating socket the server emits `chat:created` BEFORE the ack —
        // simulate the broadcast landing first, then resolve the create.
        controller.emitServerEvent(SERVER_EVENTS.CHAT_CREATED, {
          chat: { id: 'chat-new', repo_path: '/workspace/claude-workspace/u@x.com/acme/widget' },
        });
      });

      await act(async () => {
        await api.emitters.createChat(createPayload);
      });

      expect(useChatChromeStore.getState().repoPaths['chat-new']).toBe(
        '/workspace/claude-workspace/u@x.com/acme/widget'
      );
    });
  });

  it('unmount stops the io manager BEFORE disconnecting — no queued retry against a dead URL', async () => {
    // With reconnectionAttempts: Infinity, a queued manager retry could still
    // hit the (possibly dead) sandbox URL after the provider unmounts. The
    // teardown must call io.reconnection(false) FIRST, then disconnect — the
    // sandbox-death epoch remount relies on this to silence the old transport.
    const calls: string[] = [];
    const local = createMockSocket({ connected: true });
    const sock = local.socket as SocketLike & { io?: { reconnection: (v: boolean) => void } };
    sock.io = { reconnection: (v: boolean) => calls.push(`reconnection:${v}`) };
    const baseDisconnect = sock.disconnect?.bind(sock);
    sock.disconnect = () => {
      calls.push('disconnect');
      baseDisconnect?.();
    };

    const utils = render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
        createSocketImpl={
          (() => sock) as unknown as typeof import('@vgit2/shared/socket').createSocket
        }
      >
        <StateProbe />
      </SocketProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    utils.unmount();

    expect(calls).toEqual(['reconnection:false', 'disconnect']);
  });

  // the handshake reports this build's app version so the backend can
  // detect pre-handshake (outdated) native builds and block them with an
  // "update your app" notice. An up-to-date build sends `auth.appVersion`; an
  // older build (or one whose version can't be read) sends only the token.
  describe('app version handshake', () => {
    function recordingProvider(
      getAppVersion?: () => string | undefined,
      getDeviceName: () => string | undefined = () => undefined
    ) {
      const calls: Array<{ token: string | null; url: string; opts: CreateSocketOptions }> = [];
      const factory = (
        token: string | null,
        url: string,
        opts?: CreateSocketOptions
      ): SocketLike => {
        calls.push({ token, url, opts: opts ?? {} });
        return createMockSocket({ connected: true }).socket;
      };
      render(
        <SocketProvider
          getAuthToken={async () => 'token-abc'}
          getRelayUrl={async () => 'https://sandbox.portable.test'}
          appState={appCtl.appState}
          netInfo={netCtl.netInfo}
          getAppVersion={getAppVersion}
          getDeviceName={getDeviceName}
          createSocketImpl={
            factory as unknown as typeof import('@vgit2/shared/socket').createSocket
          }
        >
          <StateProbe />
        </SocketProvider>
      );
      return calls;
    }

    it('sends the build version in the handshake auth', async () => {
      const calls = recordingProvider(() => '1.5.0');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.auth).toEqual({ token: 'token-abc', appVersion: '1.5.0' });
    });

    it('omits appVersion when the build version is unavailable (older build)', async () => {
      const calls = recordingProvider(() => undefined);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.auth).toEqual({ token: 'token-abc' });
    });

    it('sends the device make/model in the handshake auth', async () => {
      const calls = recordingProvider(
        () => '1.5.0',
        () => 'Apple iPhone 15 Pro'
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.auth).toEqual({
        token: 'token-abc',
        appVersion: '1.5.0',
        deviceName: 'Apple iPhone 15 Pro',
      });
    });
  });
});
