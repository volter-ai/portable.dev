/**
 * useChatDirectory — paginated chat list + list mutations + navigation.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer. The
 * chat list is server state, so it lives in `useInfiniteQuery` (NOT Zustand) —
 * paginated through `GET /api/chats?limit=&offset=&category=`. The Active / Saved / Archived tabs are
 * INDEPENDENT infinite queries (separate cache keys) and the request ALWAYS sends
 * the explicit `category` filter, so the three lists are a true partition (a chat
 * never leaks across buckets on a refetch). The server returns each page
 * PINNED-FIRST then most-recently-updated, so pinned chats float to the top.
 *
 * Row mutations (long-press menu + swipe): save/archive call their POST endpoints,
 * optimistically drop the row from THIS list, and — once the move persists —
 * invalidate the DESTINATION bucket's query so the moved chat shows up there.
 * pin/unpin does NOT move buckets (it is orthogonal): it optimistically flips the
 * cached `pinned` flag (instant highlight) and invalidates THIS bucket so the
 * server's pinned-first order re-floats it. delete hits `DELETE /api/chats/:id`
 * (a real, irreversible backend delete) and drops the row.
 *
 * Navigation is Expo Router: opening a chat pushes `/chat/:chatId`.
 */

import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import type { ChatCategory, ChatListItem, GetChatsResponse } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { useArchiveChat, useDeleteChat, useSaveChat, useSetChatPin } from '../api/hooks';
import { queryKeys } from '../api/keys';

/** Page size for the directory list (matches the web `useChatManagement` default). */
export const CHAT_PAGE_SIZE = 50;

export interface UseChatDirectoryOptions {
  /** Which bucket to show: active (default), saved, or archived. */
  category?: ChatCategory;
}

export interface UseChatDirectory {
  chats: ChatListItem[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  isRefetching: boolean;
  loadMore: () => void;
  refetch: () => void;
  /** Archive a chat (moves it to the Archived bucket). */
  archive: (chatId: string) => void;
  /** Unarchive a chat (moves it back to Active). */
  unarchive: (chatId: string) => void;
  /** Save a chat (moves it to the Saved bucket). */
  save: (chatId: string) => void;
  /** Unsave a chat (moves it back to Active). */
  unsave: (chatId: string) => void;
  /** Pin or unpin a chat (orthogonal — floats to top + highlighted, stays in bucket). */
  setPinned: (chatId: string, pinned: boolean) => void;
  /** Permanently delete a chat (irreversible backend delete). */
  remove: (chatId: string) => void;
  /** Open a chat — pushes its Expo Router active-chat route. */
  openChat: (chatId: string) => void;
}

export function useChatDirectory(options: UseChatDirectoryOptions = {}): UseChatDirectory {
  const category = options.category ?? 'active';
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const archiveMutation = useArchiveChat();
  const saveMutation = useSaveChat();
  const pinMutation = useSetChatPin();
  const deleteMutation = useDeleteChat();

  const queryKey = queryKeys.chatDirectory(category);

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.get<GetChatsResponse>(
        `/api/chats?limit=${CHAT_PAGE_SIZE}&offset=${pageParam}&category=${category}`
      ),
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((sum, p) => sum + p.chats.length, 0) : undefined,
    // No caching: chats are created/updated on the PC AND the phone, so a cached list
    // goes stale. `staleTime: 0` refetches whenever a category becomes observed (an
    // inner-tab switch) and the screen re-focus effect refetches on tab re-open. The
    // global default is 5 min — override it here so the chat lists stay fresh.
    staleTime: 0,
  });

  const chats = query.data?.pages.flatMap((p) => p.chats) ?? [];

  /** Drop a chat from every page of the cached infinite list. */
  const dropFromCache = useCallback(
    (chatId: string) => {
      qc.setQueryData<InfiniteData<GetChatsResponse>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            chats: page.chats.filter((c) => c.id !== chatId),
          })),
        };
      });
    },
    [qc, queryKey]
  );

  /** Patch a single cached chat in place (e.g. flip `pinned` for an instant highlight). */
  const patchInCache = useCallback(
    (chatId: string, patch: Partial<ChatListItem>) => {
      qc.setQueryData<InfiniteData<GetChatsResponse>>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            chats: page.chats.map((c) => (c.id === chatId ? { ...c, ...patch } : c)),
          })),
        };
      });
    },
    [qc, queryKey]
  );

  const invalidate = useCallback(
    (cat: ChatCategory) => void qc.invalidateQueries({ queryKey: queryKeys.chatDirectory(cat) }),
    [qc]
  );

  const archive = useCallback(
    (chatId: string) => {
      dropFromCache(chatId);
      archiveMutation.mutate(
        { chatId, archived: true },
        { onSuccess: () => invalidate('archived') }
      );
    },
    [dropFromCache, archiveMutation, invalidate]
  );

  const unarchive = useCallback(
    (chatId: string) => {
      dropFromCache(chatId);
      archiveMutation.mutate(
        { chatId, archived: false },
        { onSuccess: () => invalidate('active') }
      );
    },
    [dropFromCache, archiveMutation, invalidate]
  );

  const save = useCallback(
    (chatId: string) => {
      dropFromCache(chatId);
      saveMutation.mutate({ chatId, saved: true }, { onSuccess: () => invalidate('saved') });
    },
    [dropFromCache, saveMutation, invalidate]
  );

  const unsave = useCallback(
    (chatId: string) => {
      dropFromCache(chatId);
      saveMutation.mutate({ chatId, saved: false }, { onSuccess: () => invalidate('active') });
    },
    [dropFromCache, saveMutation, invalidate]
  );

  const setPinned = useCallback(
    (chatId: string, pinned: boolean) => {
      // Pin is orthogonal — the chat stays in THIS bucket. Optimistically flip the
      // flag (instant highlight) and invalidate this bucket so the server's
      // pinned-first ordering re-floats (or re-sinks) the row.
      patchInCache(chatId, { pinned });
      pinMutation.mutate({ chatId, pinned }, { onSuccess: () => invalidate(category) });
    },
    [patchInCache, pinMutation, invalidate, category]
  );

  const remove = useCallback(
    (chatId: string) => {
      dropFromCache(chatId);
      deleteMutation.mutate({ chatId });
    },
    [dropFromCache, deleteMutation]
  );

  const openChat = useCallback(
    (chatId: string) => {
      router.push(`/chat/${chatId}`);
    },
    [router]
  );

  return {
    chats,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    isRefetching: query.isRefetching,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    refetch: () => void query.refetch(),
    archive,
    unarchive,
    save,
    unsave,
    setPinned,
    remove,
    openChat,
  };
}
