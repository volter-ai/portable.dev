/**
 * Read-marker store.
 *
 * Multi-device read-marker sync. The server broadcasts `chat:read_updated`
 * (`{ chatId, messageId }`) whenever a chat is marked read on ANY of the user's
 * devices. The per-chat last-read message id is held here as plain Zustand state
 * any screen can subscribe to — and, critically, it is the sink that reconciles
 * read markers after a reconnect (the resync `chat:join` catches history up; the
 * read marker rides in on `chat:read_updated`).
 *
 * NOT persisted: read markers are authoritative server state, rebuilt from the
 * socket on every (re)connect — same lifecycle as `socketStore` / `runtimeStore`.
 */

import { create } from 'zustand';

export interface ReadMarkerState {
  /** chatId → last-read message id (the server's authoritative read marker). */
  markers: Record<string, number>;
  /** Apply a `chat:read_updated` event (idempotent; last write wins). */
  setReadMarker: (chatId: string, messageId: number) => void;
  /** Read the current marker for a chat (`undefined` if none seen yet). */
  getReadMarker: (chatId: string) => number | undefined;
  /** Clear all markers — used on socket teardown / unmount. */
  reset: () => void;
}

export const useReadMarkerStore = create<ReadMarkerState>()((set, get) => ({
  markers: {},
  setReadMarker: (chatId, messageId) =>
    set((state) => ({ markers: { ...state.markers, [chatId]: messageId } })),
  getReadMarker: (chatId) => get().markers[chatId],
  reset: () => set({ markers: {} }),
}));
