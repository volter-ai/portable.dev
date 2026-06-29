/**
 * Offline message queue slice.
 *
 * Outgoing chat messages composed while the socket is down are enqueued here and
 * flushed on reconnect. Persisted via the MMKV adapter so the queue SURVIVES an
 * app kill ("send on reconnect even if the app was killed"). It is
 * non-secret message content, never a credential — MMKV, not SecureStore.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { UploadedFile } from '@vgit2/shared/types';
import { mmkvStateStorage } from './storage';

/** A pending outgoing message awaiting socket reconnect. */
export interface QueuedMessage {
  /** Client-generated id used for sequential-duplicate filtering + ack reconciliation. */
  id: string;
  chatId: string;
  content: string;
  /** Epoch ms the message was enqueued (caller supplies — no Date.now in pure code). */
  queuedAt: number;
  /** Attached files to forward on the chat:message payload. */
  files?: UploadedFile[];
}

export interface OfflineQueueState {
  queue: QueuedMessage[];
  enqueue: (message: QueuedMessage) => void;
  /** Remove the head of the queue (after a successful send). */
  dequeue: () => QueuedMessage | undefined;
  removeById: (id: string) => void;
  clear: () => void;
}

/** MMKV persist key for the offline message queue. */
export const OFFLINE_QUEUE_PERSIST_KEY = 'portable.offlineQueue';

export const useOfflineQueueStore = create<OfflineQueueState>()(
  persist(
    (set, get) => ({
      queue: [],
      enqueue: (message) => set({ queue: [...get().queue, message] }),
      dequeue: () => {
        const [head, ...rest] = get().queue;
        if (head === undefined) return undefined;
        set({ queue: rest });
        return head;
      },
      removeById: (id) => set({ queue: get().queue.filter((m) => m.id !== id) }),
      clear: () => set({ queue: [] }),
    }),
    {
      name: OFFLINE_QUEUE_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
