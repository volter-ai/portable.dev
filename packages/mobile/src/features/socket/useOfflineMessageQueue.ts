/**
 * useOfflineMessageQueue — the offline-send ViewModel.
 *
 * Bridges the persisted offline queue (`offlineQueueStore`, MMKV) to the live
 * socket (`useNativeSocket`'s `emitters`). It does ONE job: guarantee no
 * outgoing message is lost across an app kill.
 *
 *   - `send(chatId, content)` — delivers immediately when connected; otherwise
 *     persists the message to MMKV so it survives a kill.
 *   - on the disconnected → connected EDGE (a reconnect after going offline) it
 *     flushes the persisted queue in FIFO order with sequential-duplicate
 *     filtering (see `flushOfflineQueue`).
 *
 * It pairs with `useNativeSocket`, which separately (a) re-runs `chat:join` on
 * reconnect to catch history up and (b) folds `chat:read_updated` into the
 * read-marker store. Together they are the full reconnect-resync.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { UploadedFile } from '@vgit2/shared/types';
import { useOfflineQueueStore } from '../state/offlineQueueStore';
import { flushOfflineQueue, type SendAck } from './offlineQueue';
import { useSocketStore } from './socketStore';
import type { NativeSocket } from './useNativeSocket';

/** Monotonic counter making generated ids unique within a process run. */
let messageSeq = 0;

export interface OfflineMessageQueueDeps {
  /** The native socket (only its `emitters` are used here). */
  socket: Pick<NativeSocket, 'emitters'>;
  /** Epoch-ms supplier for `queuedAt` (injectable for deterministic tests). */
  now?: () => number;
  /** Client-id factory for queued messages (injectable for deterministic tests). */
  makeId?: () => string;
}

export interface OfflineMessageQueue {
  /**
   * Send now if connected, else enqueue to survive an app kill. `messageId`
   * (optional, defaults to a generated id) rides the emit so the server's
   * `user_message` echo reconciles the caller's optimistic message, and is
   * REUSED on the enqueue-after-failure path so a retry can never duplicate
   * an already-delivered message. `files` carries any attached uploads.
   */
  send: (
    chatId: string,
    content: string,
    messageId?: string,
    files?: UploadedFile[]
  ) => Promise<void>;
  /** Flush the persisted queue now (also runs automatically on reconnect). */
  flush: () => Promise<void>;
}

export function useOfflineMessageQueue(deps: OfflineMessageQueueDeps): OfflineMessageQueue {
  const now = deps.now ?? (() => Date.now());
  const makeId = deps.makeId ?? (() => `${now()}-${messageSeq++}`);

  // Keep mutable refs so the long-lived store subscription always calls the
  // current emitters / id factory without re-subscribing on every render.
  const emittersRef = useRef(deps.socket.emitters);
  emittersRef.current = deps.socket.emitters;
  const nowRef = useRef(now);
  nowRef.current = now;
  const makeIdRef = useRef(makeId);
  makeIdRef.current = makeId;

  /** Re-entrancy guard: a flush in progress must not be started a second time. */
  const flushingRef = useRef(false);

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      await flushOfflineQueue({
        getQueue: () => useOfflineQueueStore.getState().queue,
        removeById: (id) => useOfflineQueueStore.getState().removeById(id),
        send: (message): Promise<SendAck> =>
          emittersRef.current
            .sendMessage({
              chatId: message.chatId,
              messageId: message.id,
              content: message.content,
              files: message.files,
            })
            .then((ack) => ({ success: !!ack?.success, error: ack?.error }))
            .catch((error: unknown) => ({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            })),
      });
    } finally {
      flushingRef.current = false;
    }
  }, []);

  const send = useCallback(
    async (chatId: string, content: string, messageId?: string, files?: UploadedFile[]) => {
      const id = messageId ?? makeIdRef.current();
      if (useSocketStore.getState().connected) {
        const ack = await emittersRef.current
          .sendMessage({ chatId, messageId: id, content, files })
          .then((a) => ({ success: !!a?.success }))
          .catch(() => ({ success: false }));
        if (ack.success) return;
        // Connected but the send failed (mid-drop / server reject): fall through
        // and persist so the reconnect flush retries it (same id — the server's
        // echo dedup makes an already-delivered retry a no-op).
      }
      useOfflineQueueStore.getState().enqueue({
        id,
        chatId,
        content,
        queuedAt: nowRef.current(),
        files,
      });
    },
    []
  );

  // Flush on the disconnected → connected edge (a reconnect after being offline).
  useEffect(() => {
    let prevConnected = useSocketStore.getState().connected;
    const unsubscribe = useSocketStore.subscribe((state) => {
      const { connected } = state;
      if (connected && !prevConnected) void flush();
      prevConnected = connected;
    });
    return unsubscribe;
  }, [flush]);

  return { send, flush };
}
