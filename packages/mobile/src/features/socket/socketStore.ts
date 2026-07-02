/**
 * Socket connection-state store.
 *
 * Surfaces the connection signals (`socketio:connected` /
 * `socketio:disconnected` / `socketio:reconnecting`) and the `chat:created`
 * signal as plain Zustand state that any screen can subscribe to. There is no
 * DOM in React Native, so the provider drives this store from the Socket.IO
 * lifecycle and components read it reactively.
 *
 * NOT persisted: connection state is rebuilt from the live socket on every
 * mount / reconnect (mirrors `runtimeStore`).
 */

import { create } from 'zustand';

/** Coarse connection phase union. */
export type ConnectionState = 'connected' | 'disconnected' | 'reconnecting' | 'failed';

export interface SocketConnectionState {
  /** Whether the socket reports an open transport right now. */
  connected: boolean;
  /** Coarse connection phase, surfaced to UI (banners, indicators). */
  connectionState: ConnectionState;
  /** Current socket id while connected (`null` otherwise). */
  socketId: string | null;
  /**
   * True once the socket has connected at least once. A subsequent `connect`
   * is therefore a *reconnect* and must trigger a resync (rejoin rooms).
   */
  hasConnectedOnce: boolean;
  /**
   * chatId of the most recent server `chat:created` event. Screens react to
   * changes here (or via the provider's `onChatCreated` callback).
   */
  lastCreatedChatId: string | null;
  /**
   * The most recent server `chat:forked` event (fork-on-first-write): Portable forked a
   * Claude Code chat (`oldChatId`) into a new Portable chat (`newChatId`). The screen with
   * `oldChatId` open navigates to `newChatId`. Carries a monotonic `seq` so re-forking the
   * SAME pair still triggers the consumer effect.
   */
  lastForkedChat: { oldChatId: string; newChatId: string; seq: number } | null;
  /**
   * The most recent `chat:external_turn_completed` (rev12): a TERMINAL `claude`
   * turn finished on the PC for this chat (id == the Claude Code session id).
   * The open chat screen refreshes its transcript on the `seq` change.
   */
  lastExternalTurn: { chatId: string; seq: number } | null;

  /** Mark the socket connected (and remember it has connected at least once). */
  markConnected: (socketId: string | null) => void;
  /** Mark the socket disconnected. */
  markDisconnected: () => void;
  /** Set the coarse connection phase without changing `connected`. */
  setConnectionState: (state: ConnectionState) => void;
  /** Record the latest server-created chat id. */
  setLastCreatedChatId: (chatId: string) => void;
  /** Record the latest server fork (chat:forked) so the open screen can redirect. */
  setLastForkedChat: (oldChatId: string, newChatId: string) => void;
  /** Record a completed terminal turn (chat:external_turn_completed). */
  setLastExternalTurn: (chatId: string) => void;
  /** Reset to the initial (pre-connection) state — used on unmount. */
  reset: () => void;
}

const initialState = {
  connected: false,
  connectionState: 'disconnected' as ConnectionState,
  socketId: null as string | null,
  hasConnectedOnce: false,
  lastCreatedChatId: null as string | null,
  lastForkedChat: null as { oldChatId: string; newChatId: string; seq: number } | null,
  lastExternalTurn: null as { chatId: string; seq: number } | null,
};

export const useSocketStore = create<SocketConnectionState>()((set) => ({
  ...initialState,
  markConnected: (socketId) =>
    set({ connected: true, connectionState: 'connected', socketId, hasConnectedOnce: true }),
  markDisconnected: () =>
    set({ connected: false, connectionState: 'disconnected', socketId: null }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setLastCreatedChatId: (lastCreatedChatId) => set({ lastCreatedChatId }),
  setLastForkedChat: (oldChatId, newChatId) =>
    set((s) => ({
      lastForkedChat: { oldChatId, newChatId, seq: (s.lastForkedChat?.seq ?? 0) + 1 },
    })),
  setLastExternalTurn: (chatId) =>
    set((s) => ({
      lastExternalTurn: { chatId, seq: (s.lastExternalTurn?.seq ?? 0) + 1 },
    })),
  // Preserve `hasConnectedOnce` is intentionally NOT preserved across reset:
  // a fresh mount is a fresh first-connection.
  reset: () => set({ ...initialState }),
}));
