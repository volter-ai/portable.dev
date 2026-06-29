/**
 * ChatListSync — refresh the chat directory cache when a chat is created.
 *
 * A render-null mount (the `ThemeSync` / `StoreReviewTracker` precedent) wired
 * into `AppShell` INSIDE `ApiProvider`, so it can reach the TanStack Query client.
 *
 * The chat list is server state held in a `useInfiniteQuery` (`useChatDirectory`,
 * key `queryKeys.chatDirectory('active')`) — read by BOTH the `/chats` directory tab
 * and the home "Continue chats" preview. Nothing invalidated that cache when a new
 * chat was created, so a freshly-created chat never showed up in either list until
 * the app was killed and relaunched (which drops the in-memory query cache). This
 * folds the `chat:created` signal (the server broadcast, surfaced as
 * `useSocketStore.lastCreatedChatId`) into a cache invalidation, so the Active list
 * refetches and the new chat appears immediately — without a restart.
 *
 * Listening on the socket store (rather than only the home composer's submit) means
 * EVERY create path is covered in one place — the home composer, the repo Overview
 * hand-off, the task viewer's "Start issue chat", and a chat created on another
 * device (multi-device sync). A newly-created chat is always active, so only
 * `chatDirectory('active')` is invalidated (Saved/Archived never gain a new chat).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { queryKeys } from '../api/keys';
// FILE import (NOT the socket barrel) so this stays out of the MMKV / offline-queue
// import graph — `socketStore` is a leaf in-memory zustand store with no native deps.
import { useSocketStore } from '../socket/socketStore';

export function ChatListSync(): null {
  const queryClient = useQueryClient();
  const lastCreatedChatId = useSocketStore((s) => s.lastCreatedChatId);

  useEffect(() => {
    // null on mount / after a socket reset — only a real `chat:created` invalidates.
    if (!lastCreatedChatId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.chatDirectory('active') });
  }, [lastCreatedChatId, queryClient]);

  return null;
}
