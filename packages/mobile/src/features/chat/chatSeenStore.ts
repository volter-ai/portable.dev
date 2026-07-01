/**
 * Chat "seen" store — device-local awareness of chats that CHANGED but the mobile
 * client has NOT yet opened since that change.
 *
 * Each chat list item carries `lastUpdated` (a server ms timestamp that advances on
 * any new activity). We persist, per chat, the `lastUpdated` value the client had
 * already SEEN — either because it opened the chat ({@link markSeen}) or because the
 * chat was already present the first time this device rendered it ({@link noteBaseline}).
 * A chat has an unseen change when its current `lastUpdated` is GREATER than the stored
 * seen value (see {@link useChatUnseen}), which drives the orange row highlight.
 *
 * PERSISTED (MMKV, non-secret): the marker must survive an app restart so a chat that
 * changed on the PC while the app was closed still highlights on next launch. Brand-new
 * chats (never recorded) are baselined on first sight, so a fresh list never lights up
 * en masse — only genuine post-baseline changes glow.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../state/storage';

export interface ChatSeenState {
  /** chatId → the `lastUpdated` value the client has already seen for that chat. */
  seen: Record<string, number>;
  /**
   * Mark a chat as seen up to `lastUpdated` (monotonic — the marker only advances).
   * Called when the client OPENS the chat, clearing its unseen highlight.
   */
  markSeen: (chatId: string, lastUpdated: number) => void;
  /**
   * Record a baseline for a chat this device has NEVER recorded, so a pre-existing
   * chat doesn't retroactively glow the first time it renders. No-op once any marker
   * exists (so a real change since the last session still highlights).
   */
  noteBaseline: (chatId: string, lastUpdated: number) => void;
  /** Forget a chat's marker (e.g. the chat was deleted). */
  forget: (chatId: string) => void;
}

export const useChatSeenStore = create<ChatSeenState>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (chatId, lastUpdated) =>
        set((s) => {
          const prev = s.seen[chatId];
          const next = prev === undefined ? lastUpdated : Math.max(prev, lastUpdated);
          if (prev === next) return s;
          return { seen: { ...s.seen, [chatId]: next } };
        }),
      noteBaseline: (chatId, lastUpdated) =>
        set((s) => {
          if (s.seen[chatId] !== undefined) return s;
          return { seen: { ...s.seen, [chatId]: lastUpdated } };
        }),
      forget: (chatId) =>
        set((s) => {
          if (s.seen[chatId] === undefined) return s;
          const next = { ...s.seen };
          delete next[chatId];
          return { seen: next };
        }),
    }),
    {
      name: 'portable.chat-seen',
      version: 1,
      storage: createJSONStorage(() => mmkvStateStorage),
    }
  )
);
