/**
 * Offline message queue persisted across app kill.
 *
 * Drives the offline-send path end-to-end with a mocked Socket.IO client and an
 * in-memory MMKV store, asserting the full "no message lost across a restart"
 * guarantee:
 *
 *   1. messages composed while disconnected persist to MMKV (survive an app kill);
 *   2. after a simulated app-kill/reload (rehydrate from MMKV) + reconnect, the
 *      persisted queue flushes IN ORDER with sequential-duplicate filtering
 *      preserved (a consecutive identical message is dropped, never re-sent);
 *   3. the reconnect-resync re-runs `chat:join` for tracked rooms (catch history up);
 *   4. read markers reconcile from a `chat:read_updated` server event.
 *
 * Plus a focused unit pass on the pure `flushOfflineQueue` (order + dedup + a
 * failed ack that stops the flush and leaves the rest queued).
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// In-memory MMKV (native nitro module — unusable in Jest). The persisted offline
// queue lives here; the "app kill" simulation rehydrates the store from it.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had;
    },
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

import { act, render } from '@testing-library/react-native';

import { CLIENT_EVENTS, SERVER_EVENTS } from '@vgit2/shared/socket';
import {
  SocketProvider,
  flushOfflineQueue,
  useOfflineMessageQueue,
  useReadMarkerStore,
  useSocket,
  useSocketStore,
  type AppStateLike,
  type NativeSocket,
  type NetInfoLike,
  type OfflineMessageQueue,
  type SendAck,
} from '../src/features/socket';
import {
  OFFLINE_QUEUE_PERSIST_KEY,
  useOfflineQueueStore,
  type QueuedMessage,
} from '../src/features/state';
import { type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;
const mmkvMock = () => jest.requireMock('react-native-mmkv') as { __store: Map<string, string> };

const emissionsOf = (event: string) => controller.emissions.filter((e) => e.event === event);
const messageContents = () =>
  emissionsOf(CLIENT_EVENTS.CHAT_MESSAGE).map((e) => (e.args[0] as { content: string }).content);

/** Captures the live `useSocket` API + the offline-queue VM for imperative driving. */
function Harness({
  onReady,
}: {
  onReady: (api: { socket: NativeSocket; queue: OfflineMessageQueue }) => void;
}) {
  const socket = useSocket();
  let seq = 0;
  const queue = useOfflineMessageQueue({
    socket,
    now: () => 1000,
    makeId: () => `m-${++seq}`,
  });
  onReady({ socket, queue });
  return null;
}

/** Inert lifecycle sources (the real RN AppState/NetInfo crash under Jest). */
const noopAppState: AppStateLike = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};
const noopNetInfo: NetInfoLike = { addEventListener: () => () => {} };

async function mountProvider(): Promise<{ socket: NativeSocket; queue: OfflineMessageQueue }> {
  const holder: { api: { socket: NativeSocket; queue: OfflineMessageQueue } | null } = {
    api: null,
  };
  render(
    <SocketProvider
      getAuthToken={async () => 'token-abc'}
      getRelayUrl={async () => 'https://sandbox.portable.test'}
      appState={noopAppState}
      netInfo={noopNetInfo}
    >
      <Harness onReady={(a) => (holder.api = a)} />
    </SocketProvider>
  );
  // Flush the async socket-creation effect (resolves token + URL, binds handlers).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return holder.api!;
}

/** Drain microtasks so the async flush (await per send) settles. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe('offline message queue persisted across app kill', () => {
  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useReadMarkerStore.getState().reset();
      useOfflineQueueStore.getState().clear();
    });
    controller.reset();
    mmkvMock().__store.clear();
  });

  it('persists offline messages, flushes them in order on reconnect (sequential-duplicate filtered), re-runs chat:join, and reconciles read markers', async () => {
    const { socket, queue } = await mountProvider();

    // Initial connect, then join a room (tracked for resync).
    act(() => controller.setConnected(true));
    await act(async () => {
      await socket.joinChat({ chatId: 'chat-1', limit: 50, offset: 0 });
    });
    expect(emissionsOf(CLIENT_EVENTS.CHAT_JOIN)).toHaveLength(1);

    // Go offline.
    act(() => controller.setConnected(false));
    expect(useSocketStore.getState().connected).toBe(false);

    // Compose messages while offline — including a consecutive duplicate.
    await act(async () => {
      await queue.send('chat-1', 'hello');
      await queue.send('chat-1', 'hello'); // sequential duplicate → must be filtered on flush
      await queue.send('chat-1', 'world');
    });
    // No messages went out while disconnected; all three are queued.
    expect(messageContents()).toEqual([]);
    expect(useOfflineQueueStore.getState().queue).toHaveLength(3);

    // They persisted to MMKV (survive an app kill).
    const persisted = mmkvMock().__store.get(OFFLINE_QUEUE_PERSIST_KEY)!;
    expect(persisted).toContain('hello');
    expect(persisted).toContain('world');

    // --- Simulate app kill + reload: fresh in-memory state, rehydrate from disk. ---
    // Clearing the in-memory queue re-persists `[]`, so we restore the captured
    // on-disk value (the bytes that "survived the kill") before rehydrating —
    // modelling a brand-new process reading the persisted MMKV store.
    act(() => useOfflineQueueStore.setState({ queue: [] }));
    mmkvMock().__store.set(OFFLINE_QUEUE_PERSIST_KEY, persisted);
    await act(async () => {
      await useOfflineQueueStore.persist.rehydrate();
    });
    expect(useOfflineQueueStore.getState().queue).toHaveLength(3); // restored from MMKV

    // --- Reconnect: connect edge flushes the queue; reconnect-resync rejoins rooms. ---
    act(() => controller.setConnected(true));
    await drain();

    // Flushed in order, with the consecutive duplicate dropped.
    expect(messageContents()).toEqual(['hello', 'world']);
    // The reconnect-resync re-ran chat:join for the tracked room (initial + resync).
    expect(emissionsOf(CLIENT_EVENTS.CHAT_JOIN)).toHaveLength(2);
    expect(emissionsOf(CLIENT_EVENTS.CHAT_JOIN)[1].args[0]).toMatchObject({ chatId: 'chat-1' });
    // Queue drained (the dropped duplicate removed too).
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);

    // --- Read markers reconcile from a chat:read_updated event. ---
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CHAT_READ_UPDATED, {
        chatId: 'chat-1',
        messageId: 42,
      });
    });
    expect(useReadMarkerStore.getState().getReadMarker('chat-1')).toBe(42);
  });

  it('sends immediately (no enqueue) when already connected', async () => {
    const { queue } = await mountProvider();
    act(() => controller.setConnected(true));

    await act(async () => {
      await queue.send('chat-9', 'live message');
    });

    expect(messageContents()).toEqual(['live message']);
    expect(useOfflineQueueStore.getState().queue).toHaveLength(0);
  });
});

describe('flushOfflineQueue — pure ordering / dedup / failure semantics', () => {
  const mk = (id: string, chatId: string, content: string): QueuedMessage => ({
    id,
    chatId,
    content,
    queuedAt: 0,
  });

  it('flushes in order, drops consecutive duplicates, and removes sent + dropped ids', async () => {
    // `removeById` replaces the queue with a filtered copy (like the Zustand store),
    // so the flush's up-front snapshot stays intact during iteration.
    let queue: QueuedMessage[] = [
      mk('1', 'c', 'a'),
      mk('2', 'c', 'a'), // consecutive duplicate → dropped
      mk('3', 'c', 'b'),
      mk('4', 'd', 'a'), // different chat — NOT a duplicate
    ];
    const sentOrder: string[] = [];
    const removed: string[] = [];
    const result = await flushOfflineQueue({
      getQueue: () => queue,
      removeById: (id) => {
        removed.push(id);
        queue = queue.filter((m) => m.id !== id);
      },
      send: async (m): Promise<SendAck> => {
        sentOrder.push(m.content);
        return { success: true };
      },
    });

    expect(sentOrder).toEqual(['a', 'b', 'a']); // dup of 'a' not re-sent
    expect(removed).toEqual(['1', '2', '3', '4']); // dropped dup ('2') removed too
    expect(result).toMatchObject({ sent: 3, dropped: 1, remaining: 0 });
  });

  it('stops on a failed ack, leaving that message and the rest queued', async () => {
    let queue: QueuedMessage[] = [mk('1', 'c', 'a'), mk('2', 'c', 'b'), mk('3', 'c', 'c')];
    const result = await flushOfflineQueue({
      getQueue: () => queue,
      removeById: (id) => {
        queue = queue.filter((m) => m.id !== id);
      },
      send: async (m): Promise<SendAck> => ({ success: m.content === 'a' }),
    });

    expect(result).toMatchObject({ sent: 1, remaining: 2 });
    expect(queue.map((m) => m.id)).toEqual(['2', '3']); // 'b' failed → it + 'c' stay
  });
});
