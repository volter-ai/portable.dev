/**
 * useChatStream — active-chat ViewModel for the message list.
 *
 * Joins the chat room, seeds the chat's history from the `chat:join` ack into
 * `chatMessagesStore`, and subscribes to that store for the live-streamed
 * messages + run status the FlatList renders. The `claude:*` / `user_message`
 * events themselves are bound globally by `useNativeSocket` (so background chats
 * keep streaming and the listeners survive a recovery re-point); this hook owns
 * only the per-screen concerns: join + history hydration + mark-read.
 *
 * The socket is INJECTED (the active-chat screen passes `useSocket()`), keeping
 * the hook decoupled from the socket feature for testing.
 */

import type { BufferedMessage, ChatStatus } from '@vgit2/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSocketStore } from '../socket/socketStore';
import {
  RUN_START_SYNC_GRACE_MS,
  useChatMessagesStore,
  type MobileChatMessage,
} from './chatMessagesStore';
import { transformBufferedMessages } from './messageTransformers';

// Re-exported for back-compat — the constant moved into `chatMessagesStore` so
// `applyJoinedHistory` can decide whether a chat is still live (see its doc).
export { RUN_START_SYNC_GRACE_MS };

/** The slice of the native socket this hook needs (structural — eases testing). */
export interface ChatStreamSocket {
  joinChat: (payload: {
    chatId: string;
    count?: number;
    limit?: number;
    offset?: number;
  }) => Promise<unknown>;
  emitters: {
    markRead: (payload: { chatId: string; messageId: number }) => Promise<unknown>;
  };
}

export interface UseChatStreamOptions {
  /** Page size for the initial history join (parity with the directory list). */
  historyLimit?: number;
}

export interface UseChatStream {
  /** The ordered message list (history + live blocks). */
  messages: MobileChatMessage[];
  /** Current run status (`running` shows the typing indicator). */
  status: ChatStatus | undefined;
  /** Last run error, if any (`claude:error`). */
  error: string | undefined;
  /** True while Claude is actively producing output. */
  isWorking: boolean;
  /** Mark the chat read up to a (numeric) message id — best-effort, fire-and-forget. */
  markRead: (messageId: number) => void;
  /**
   * True when the backend reported MORE buffered messages than the current page —
   * drives the "Load earlier messages" affordance.
   */
  hasMore: boolean;
  /** True while a {@link loadMore} re-join is in flight. */
  isLoadingMore: boolean;
  /**
   * Load an earlier page of history. The backend has no "before id" query, so this
   * re-joins with a growing `count` (50 → 100 → 150…) — `getMessagesAfterId(0, N)`
   * returns the LATEST N, a superset of the current page — and MERGES the result
   * (web `useChatManagement.loadMoreMessages` → `syncChatMessages(nextCount)` parity).
   * No-op while disconnected, already loading, or when there is nothing more.
   */
  loadMore: () => void;
}

const DEFAULT_HISTORY_LIMIT = 50;
/** Page increment for {@link UseChatStream.loadMore} (web's +50 per "load earlier"). */
const HISTORY_PAGE_SIZE = 50;

/** Loose shape of the `chat:join` ack (the backend `handleChatJoin` return). */
interface ChatJoinAck {
  success?: boolean;
  messages?: BufferedMessage[];
  status?: ChatStatus;
  hasMore?: boolean;
}

/** Stable empty list so an unseen chat doesn't churn the selector identity. */
const EMPTY: MobileChatMessage[] = [];

export function useChatStream(
  socket: ChatStreamSocket | null,
  chatId: string,
  options: UseChatStreamOptions = {}
): UseChatStream {
  const { historyLimit = DEFAULT_HISTORY_LIMIT } = options;

  const messages = useChatMessagesStore((s) => s.messages[chatId]) ?? EMPTY;
  const status = useChatMessagesStore((s) => s.statuses[chatId]);
  const error = useChatMessagesStore((s) => s.errors[chatId]);

  // The socket is built asynchronously (token + sandbox URL resolution) and the
  // chat screen may mount before it is up, so gate the join on the connection
  // becoming live (the web joined on `connect`). Reconnect re-joins are handled
  // by `useNativeSocket`'s tracked-room resync, so this only needs to land once.
  const connected = useSocketStore((s) => s.connected);

  // rev12: a TERMINAL turn completed on the PC — see the dedicated refresh
  // effect below. Kept OUT of the join effect's deps so an unrelated chat's
  // turn never re-fires this chat's entry pagination-reset (N3).
  const lastExternalTurn = useSocketStore((s) => s.lastExternalTurn);

  // Load-more pagination is per-SCREEN state (not in the message store): how many
  // messages we've requested (grows 50 → 100 …) + whether the backend has more.
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const requestedCountRef = useRef(historyLimit);

  // Join the room + hydrate history once the socket is connected.
  useEffect(() => {
    if (!socket || !chatId || !connected) return;
    // Reset pagination for this chat on (re)entry — load-more state is per-screen
    // (a fresh open restarts at the first page; documented deviation from the web,
    // which tracks requestedCount on the chat object).
    requestedCountRef.current = historyLimit;
    setHasMore(false);
    setIsLoadingMore(false);
    let cancelled = false;
    void (async () => {
      try {
        // The backend's join handler reads `count` (recent N messages).
        const ack = (await socket.joinChat({ chatId, count: historyLimit })) as
          | ChatJoinAck
          | undefined;
        if (cancelled) return;
        // Web `processingChats` parity: a chat whose FIRST message was just
        // sent (home composer / repo hand-off navigated here mid-spawn) skips
        // the snapshot entirely — the room was joined on `chat:create`, so the
        // live `user_message` echo + `claude:*` events keep the transcript and
        // status current; the ack's stale 'completed' must not clobber them.
        const startedAt = useChatMessagesStore.getState().runStartedAt[chatId];
        if (startedAt !== undefined && Date.now() - startedAt < RUN_START_SYNC_GRACE_MS) return;
        if (!ack?.messages) return;
        // MERGE the ack (never blind-replace): an empty/lagging buffer ack must
        // not wipe live-streamed messages when re-entering a running chat.
        // `applyJoinedHistory` also guards status adoption so a stale 'completed'
        // can't clobber a live run.
        useChatMessagesStore
          .getState()
          .applyJoinedHistory(chatId, transformBufferedMessages(ack.messages), ack.status);
        if (typeof ack.hasMore === 'boolean') setHasMore(ack.hasMore);
      } catch {
        // Join failures surface via the connection UX (E-R); leave history as-is.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [socket, chatId, historyLimit, connected]);

  // rev12 external-turn REFRESH — SEPARATE from the entry join above so it does
  // NOT reset pagination (N3). When a TERMINAL turn completes for THIS chat, the
  // transcript JSONL gained a whole turn that streamed nowhere; re-join at the
  // CURRENT requested count (keeping `hasMore` / any loaded-earlier pages) and
  // let `applyJoinedHistory` merge it in. Scoped to this chatId, so another
  // chat's turn re-runs this effect but early-returns without work.
  const handledExternalSeqRef = useRef(0);
  useEffect(() => {
    if (!socket || !chatId || !connected) return;
    if (!lastExternalTurn || lastExternalTurn.chatId !== chatId) return;
    if (lastExternalTurn.seq === handledExternalSeqRef.current) return;
    handledExternalSeqRef.current = lastExternalTurn.seq;
    let cancelled = false;
    void (async () => {
      try {
        const ack = (await socket.joinChat({ chatId, count: requestedCountRef.current })) as
          | ChatJoinAck
          | undefined;
        if (cancelled || !ack?.messages) return;
        useChatMessagesStore
          .getState()
          .applyJoinedHistory(chatId, transformBufferedMessages(ack.messages), ack.status);
        if (typeof ack.hasMore === 'boolean') setHasMore(ack.hasMore);
      } catch {
        // Refresh is best-effort; keep the current view on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [socket, chatId, connected, lastExternalTurn]);

  const markRead = useCallback(
    (messageId: number) => {
      if (!socket || !chatId || !Number.isFinite(messageId)) return;
      void socket.emitters.markRead({ chatId, messageId }).catch(() => {});
    },
    [socket, chatId]
  );

  const loadMore = useCallback(() => {
    if (!socket || !chatId || !connected || !hasMore || isLoadingMore) return;
    const nextCount = requestedCountRef.current + HISTORY_PAGE_SIZE;
    requestedCountRef.current = nextCount;
    setIsLoadingMore(true);
    void (async () => {
      try {
        // Re-join with a bigger count → the latest N (a superset of the current
        // page); merge prepends the newly-revealed older messages without dups.
        // NOT grace-skipped — this is an explicit user action; the merge protects
        // a chat that happens to be active.
        const ack = (await socket.joinChat({ chatId, count: nextCount })) as
          | ChatJoinAck
          | undefined;
        if (!ack?.messages) {
          setHasMore(false);
          return;
        }
        useChatMessagesStore
          .getState()
          .applyJoinedHistory(chatId, transformBufferedMessages(ack.messages), ack.status);
        if (typeof ack.hasMore === 'boolean') setHasMore(ack.hasMore);
      } catch {
        // Keep the current page on failure; the affordance stays for a retry.
      } finally {
        setIsLoadingMore(false);
      }
    })();
  }, [socket, chatId, connected, hasMore, isLoadingMore]);

  return {
    messages,
    status,
    error,
    // `compressing` keeps the indicator up with its own copy (web parity).
    isWorking: status === 'running' || status === 'compressing',
    markRead,
    hasMore,
    isLoadingMore,
    loadMore,
  };
}
