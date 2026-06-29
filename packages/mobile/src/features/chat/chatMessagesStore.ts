/**
 * chatMessagesStore — per-chat message list + live stream state.
 *
 * The socket provider (`useNativeSocket`) folds the `claude:*` streaming events and
 * `user_message` into this store; the active-chat screen subscribes to it for
 * the FlatList. Keyed by `chatId` so background chats keep accumulating.
 *
 * NOT persisted: chat messages are authoritative server state, re-hydrated from
 * the `chat:join` ack on every (re)connect and streamed live thereafter — same
 * in-memory lifecycle as `socketStore` / `readMarkerStore`. (The persisted
 * outgoing-message queue is a different concern.)
 */

import type { ChatStatus, UploadedFile } from '@vgit2/shared/types';
import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import { create } from 'zustand';

/** A single message in the RN chat list (blocks carry the wire `parent_tool_use_id`). */
export interface MobileChatMessage {
  /** Server / client message id (used to reconcile optimistic ↔ persisted). */
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content?: string;
  blocks?: ClaudeStreamBlock[];
  timestamp?: number;
  /** True for an optimistic user message awaiting the backend echo. */
  optimistic?: boolean;
  /** Files attached to a user message (matches the UploadedFile / UploadFileResponse shape). */
  uploadedFiles?: UploadedFile[];
  /**
   * Device-local URIs for the attached files (from `UploadedAttachment.file.uri`).
   * Used to render image thumbnails: `getRelayUrl()` is async so we can't resolve
   * `absolutePath` synchronously; device URIs are always available immediately.
   * Preserved through echo reconciliation — the server echo doesn't carry device paths.
   */
  localFileUris?: string[];
}

/**
 * True when `block` is already present in `existing`. Checked in order:
 *  - `blockId` — the backend stamps every streamed block with a unique
 *    `randomUUID()` blockId "for deduplication"; a redelivered block (reconnect
 *    replay, double emission) carries the SAME blockId, so this catches dups
 *    even for blocks with no `id` (error/image/video/actions), which the older
 *    id+type/content checks missed entirely;
 *  - `id` + type — tool_use/tool_result pairing ids;
 *  - exact text content — text blocks re-emitted with a fresh blockId.
 */
function hasDuplicateBlock(existing: ClaudeStreamBlock[], block: ClaudeStreamBlock): boolean {
  return existing.some(
    (b) =>
      (!!block.blockId && b.blockId === block.blockId) ||
      (!!block.id && b.id === block.id && b.type === block.type) ||
      (!block.id &&
        block.type === 'text' &&
        !!block.content &&
        b.type === 'text' &&
        b.content === block.content)
  );
}

/**
 * Append a streamed block to a message list, mirroring the web `claude:stream`
 * reducer:
 *  - a `tool_result` is appended to the assistant message holding its matching
 *    `tool_use` (searched backwards by id);
 *  - otherwise the block extends the LAST assistant message, or starts a new
 *    assistant message when the last message isn't an assistant turn;
 *  - duplicates are dropped (see {@link hasDuplicateBlock}).
 * Returns a NEW array (immutable) — unchanged identity when the block is a dup.
 */
export function appendBlockToMessages(
  messages: MobileChatMessage[],
  block: ClaudeStreamBlock
): MobileChatMessage[] {
  // tool_result: attach to the message containing the matching tool_use.
  if (block.type === 'tool_result' && block.id) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.blocks) continue;
      const hasMatch = msg.blocks.some((b) => b.type === 'tool_use' && b.id === block.id);
      if (!hasMatch) continue;

      const existing = msg.blocks ?? [];
      if (hasDuplicateBlock(existing, block)) return messages;

      const updated: MobileChatMessage = { ...msg, blocks: [...existing, block] };
      return [...messages.slice(0, i), updated, ...messages.slice(i + 1)];
    }
    // No matching tool_use — fall through to default append.
  }

  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant') {
    const existing = lastMsg.blocks ?? [];
    if (hasDuplicateBlock(existing, block)) return messages;

    const updated: MobileChatMessage = { ...lastMsg, blocks: [...existing, block] };
    return [...messages.slice(0, -1), updated];
  }

  // Start a new assistant message.
  const newMessage: MobileChatMessage = {
    role: 'assistant',
    content: '',
    blocks: [block],
    timestamp: block.timestamp ?? undefined,
  };
  return [...messages, newMessage];
}

/**
 * How long after an optimistic run start (`markRunStarted`) a `chat:join` ack is
 * still treated as LIVE (so a stale spawn-window snapshot can't clobber the
 * in-flight run). Lives here (not in `useChatStream`) because `applyJoinedHistory`
 * needs it to decide whether a chat is active; `useChatStream` re-exports it for
 * back-compat. See the `runStartedAt` doc on {@link ChatMessagesState}.
 */
export const RUN_START_SYNC_GRACE_MS = 30_000;

/**
 * Find the as-yet-unclaimed `joined` message that the local `message` corresponds to,
 * returning its index (or -1). Matched in priority order — `id`, then `timestamp`, then
 * (USER messages only, non-empty content) **content** — each backend message claimed at
 * most once via `claimed`.
 *
 * The content fallback is the duplicate-first-message fix. An optimistic / seeded / echoed FIRST user
 * message carries a CLIENT id (`msg-…` from the home composer seed, or NONE from the
 * `startRepoChatFlow` repo hand-off) plus a client/echo timestamp, while the backend's
 * PERSISTED copy of the same message carries the numeric buffered id + the stored
 * timestamp — they share NO id and NO timestamp. An id/ts-only merge therefore kept BOTH
 * and the user bubble rendered TWICE on a re-join / resync that ran while the chat was
 * still live (a reconnect, an AppState foreground, navigate-back, or load-more). Matching
 * by content reconciles them (the persisted user message's user-visible content is
 * resolved by `transformBufferedMessages`, including the new-repo `customDisplay`
 * displayText), so the local copy is dropped. The 1:1 claim means two genuinely-distinct
 * identical-content user messages — where only one is persisted yet — keep the
 * unpersisted one.
 */
function matchInJoined(
  message: MobileChatMessage,
  joined: MobileChatMessage[],
  claimed: boolean[]
): number {
  if (message.id) {
    const byId = joined.findIndex((b, i) => !claimed[i] && b.id === message.id);
    if (byId !== -1) return byId;
  }
  if (message.timestamp !== undefined) {
    const byTs = joined.findIndex((b, i) => !claimed[i] && b.timestamp === message.timestamp);
    if (byTs !== -1) return byTs;
  }
  if (
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.length > 0
  ) {
    const byContent = joined.findIndex(
      (b, i) => !claimed[i] && b.role === 'user' && b.content === message.content
    );
    if (byContent !== -1) return byContent;
  }
  return -1;
}

/**
 * Merge a freshly-joined `chat:join` history with the current in-memory messages
 * using a MERGE strategy.
 *
 * `joined` are the AUTHORITATIVE backend messages in ascending id order (oldest →
 * newest). `existing` may additionally hold live-streamed messages the persisted DB
 * buffer hasn't caught up to yet (a running chat persists blocks near run-end).
 *
 *  - When the chat is ACTIVE we APPEND the local-only (not-in-`joined`) messages
 *    after the backend set, so a navigate-back / reconnect re-join can NEVER WIPE
 *    live content — even when the ack is empty (`[]` is truthy, so a blind
 *    `setMessages(transformBufferedMessages([]))` used to clear the list). Each
 *    local message is reconciled to AT MOST ONE backend message (id → timestamp →
 *    user-content; see {@link matchInJoined}) so the optimistic first message is
 *    dropped once the backend has persisted it without losing a genuinely-
 *    distinct repeat.
 *  - When INACTIVE the backend is the source of truth and we trust it wholesale
 *    (load-more's growing-`count` re-join returns the latest N — a superset of what
 *    we already show — so this also grows the list without duplicates).
 *
 * `existing.length === 0` (first open) trivially returns `joined`.
 */
export function mergeJoinedHistory(
  existing: MobileChatMessage[],
  joined: MobileChatMessage[],
  active: boolean
): MobileChatMessage[] {
  if (existing.length === 0) return joined;
  if (!active) return joined;
  const claimed = new Array<boolean>(joined.length).fill(false);
  const localOnly = existing.filter((m) => {
    const i = matchInJoined(m, joined, claimed);
    if (i === -1) return true;
    claimed[i] = true;
    return false;
  });
  return [...joined, ...localOnly];
}

export interface ChatMessagesState {
  /** chatId → ordered message list. */
  messages: Record<string, MobileChatMessage[]>;
  /** chatId → run status (drives the loading/typing + terminal UI). */
  statuses: Record<string, ChatStatus>;
  /** chatId → last run error string (cleared on a new run). */
  errors: Record<string, string | undefined>;
  /**
   * chatId → timestamp of an OPTIMISTIC run start: the first message was sent
   * BEFORE the chat screen mounted (home composer / repo hand-off). While this
   * is fresh, `useChatStream` SKIPS the `chat:join` ack snapshot (the web
   * `processingChats` sync-skip parity): during the Claude session-spawn window
   * the backend's `getActualChatStatus` reports 'completed', and adopting that
   * would clobber the live 'running' and hide the typing indicator. Cleared by
   * any TERMINAL status (completed / error / interrupt) or by the grace window.
   */
  runStartedAt: Record<string, number>;

  /** Replace a chat's history (from the `chat:join` ack). */
  setMessages: (chatId: string, messages: MobileChatMessage[]) => void;
  /**
   * Apply a `chat:join` history via the MERGE strategy ({@link mergeJoinedHistory}),
   * NOT a blind replace — so navigating back to / reconnecting on an actively
   * running chat can never wipe live-streamed messages with a lagging/empty ack.
   * Reads the chat's CURRENT status + run-start grace atomically (single
   * `set`). An empty `joined` leaves the message list untouched. `ackStatus` is
   * adopted UNLESS the chat is inside the optimistic spawn grace (where the backend
   * reports a stale status before its session exists); outside the grace the
   * backend's status is authoritative, matching the existing join behavior.
   */
  applyJoinedHistory: (chatId: string, joined: MobileChatMessage[], ackStatus?: ChatStatus) => void;
  /** Append a streamed block (`claude:stream`). */
  appendBlock: (chatId: string, block: ClaudeStreamBlock) => void;
  /** Append / reconcile a user message (`user_message`, replaces an optimistic echo). */
  appendUserMessage: (chatId: string, message: MobileChatMessage) => void;
  /** Set run status (`claude:status` / `claude:processing`). */
  setStatus: (chatId: string, status: ChatStatus) => void;
  /**
   * Optimistically mark a just-created chat's first run as started (status →
   * 'running' + the join-snapshot protection window). Called by the new-chat
   * flows (`createNewChatFlow` / `startRepoChatFlow`) right after the first
   * `chat:message` is emitted.
   */
  markRunStarted: (chatId: string, at?: number) => void;
  /** `claude:interrupted` — stop the run, status → completed. */
  markInterrupted: (chatId: string) => void;
  /** `claude:error` — stop the run, status → error, optional inline error block. */
  markError: (chatId: string, error: string, errorBlock?: ClaudeStreamBlock) => void;
  /**
   * `tool_permission_required` — retroactively flag the most recent matching
   * `tool_use` block as awaiting an approve/deny decision (mirrors the web
   * `SocketIOContext` handler). No-op when no matching block exists.
   */
  markToolPermissionRequired: (
    chatId: string,
    data: { requestId: string; toolName: string }
  ) => void;

  /** Read a chat's messages (empty array if none). */
  getMessages: (chatId: string) => MobileChatMessage[];
  /** Drop a single chat's state. */
  clearChat: (chatId: string) => void;
  /** Clear everything — used on socket teardown / unmount. */
  reset: () => void;
}

/** Drop a chat's optimistic-start mark (helper for the terminal transitions). */
function withoutRunStart(
  runStartedAt: Record<string, number>,
  chatId: string
): Record<string, number> {
  if (runStartedAt[chatId] === undefined) return runStartedAt;
  const next = { ...runStartedAt };
  delete next[chatId];
  return next;
}

export const useChatMessagesStore = create<ChatMessagesState>()((set, get) => ({
  messages: {},
  statuses: {},
  errors: {},
  runStartedAt: {},

  setMessages: (chatId, messages) =>
    set((state) => ({ messages: { ...state.messages, [chatId]: messages } })),

  applyJoinedHistory: (chatId, joined, ackStatus) =>
    set((state) => {
      const startedAt = state.runStartedAt[chatId];
      const inGrace = startedAt !== undefined && Date.now() - startedAt < RUN_START_SYNC_GRACE_MS;
      const currentStatus = state.statuses[chatId];
      // "Live" (for the MESSAGE merge): mirrors the web `isChatActive` (status
      // running) PLUS the RN optimistic-start grace window. Read fresh so a live
      // `appendBlock` that landed while the join ack was in flight is folded in via
      // `mergeJoinedHistory`'s local-only branch. Erring toward "live" only ever
      // PRESERVES messages — it can never wipe — so this is the safe default.
      const live = currentStatus === 'running' || currentStatus === 'compressing' || inGrace;
      // MESSAGES: MERGE, never blind-replace. An empty/short ack can't wipe live
      // content (`[]` is truthy, so the caller's `!ack.messages` guard
      // misses it). An empty ack leaves the list untouched.
      const messages =
        joined && joined.length > 0
          ? {
              ...state.messages,
              [chatId]: mergeJoinedHistory(state.messages[chatId] ?? [], joined, live),
            }
          : state.messages;
      // STATUS: adopt the server snapshot UNLESS we're inside the optimistic spawn
      // grace, where the backend's session isn't up yet and reports a stale status
      // (the new-chat hand-off race). Outside the grace the backend's
      // `getActualChatStatus` is authoritative — it reports 'running' for a
      // genuinely-running chat, so adopting it never hides a live run's indicator.
      const statuses =
        ackStatus && !inGrace ? { ...state.statuses, [chatId]: ackStatus } : state.statuses;
      return { messages, statuses };
    }),

  appendBlock: (chatId, block) =>
    set((state) => {
      const current = state.messages[chatId] ?? [];
      const next = appendBlockToMessages(current, block);
      if (next === current) return {};
      return { messages: { ...state.messages, [chatId]: next } };
    }),

  appendUserMessage: (chatId, message) =>
    set((state) => {
      const current = state.messages[chatId] ?? [];
      // Skip a duplicate non-optimistic message with the same id.
      if (message.id && current.some((m) => m.id === message.id && !m.optimistic)) {
        return {};
      }
      // Replace a matching optimistic message in place.
      if (message.id) {
        const idx = current.findIndex((m) => m.id === message.id && m.optimistic);
        if (idx !== -1) {
          const existing = current[idx];
          const next = [...current];
          // Preserve device-local URIs from the optimistic: the server echo carries
          // server-side absolutePath but has no knowledge of device file paths, so the
          // thumbnail stays visible only if we carry localFileUris forward.
          next[idx] = {
            ...message,
            optimistic: false,
            localFileUris: message.localFileUris ?? existing.localFileUris,
          };
          return { messages: { ...state.messages, [chatId]: next } };
        }
      }
      return { messages: { ...state.messages, [chatId]: [...current, message] } };
    }),

  setStatus: (chatId, status) =>
    set((state) => ({
      statuses: { ...state.statuses, [chatId]: status },
      // A TERMINAL status ends the optimistic-start protection window (the
      // join-ack snapshot is trustworthy again). A 'running'/'compressing'
      // keeps it: the in-flight join ack can still carry the stale spawn-window
      // 'completed' and must stay skipped.
      runStartedAt:
        status === 'running' || status === 'compressing'
          ? state.runStartedAt
          : withoutRunStart(state.runStartedAt, chatId),
    })),

  markRunStarted: (chatId, at) =>
    set((state) => ({
      statuses: { ...state.statuses, [chatId]: 'running' },
      runStartedAt: { ...state.runStartedAt, [chatId]: at ?? Date.now() },
    })),

  markInterrupted: (chatId) =>
    set((state) => ({
      statuses: { ...state.statuses, [chatId]: 'completed' },
      runStartedAt: withoutRunStart(state.runStartedAt, chatId),
    })),

  markError: (chatId, error, errorBlock) =>
    set((state) => {
      const statuses = { ...state.statuses, [chatId]: 'error' as ChatStatus };
      const errors = { ...state.errors, [chatId]: error };
      const runStartedAt = withoutRunStart(state.runStartedAt, chatId);
      if (!errorBlock) return { statuses, errors, runStartedAt };
      const current = state.messages[chatId] ?? [];
      const next = appendBlockToMessages(current, errorBlock);
      return { statuses, errors, runStartedAt, messages: { ...state.messages, [chatId]: next } };
    }),

  markToolPermissionRequired: (chatId, { requestId, toolName }) =>
    set((state) => {
      const current = state.messages[chatId];
      if (!current) return {};
      // Search backwards for the most recent assistant tool_use block matching
      // toolName that isn't already awaiting permission (web parity).
      for (let i = current.length - 1; i >= 0; i--) {
        const msg = current[i];
        if (msg.role !== 'assistant' || !msg.blocks) continue;
        for (let j = msg.blocks.length - 1; j >= 0; j--) {
          const b = msg.blocks[j];
          if (b.type === 'tool_use' && b.toolName === toolName && b.needsPermission !== true) {
            const blocks = [...msg.blocks];
            blocks[j] = { ...b, needsPermission: true, permissionRequestId: requestId };
            const next = [...current];
            next[i] = { ...msg, blocks };
            return { messages: { ...state.messages, [chatId]: next } };
          }
        }
      }
      return {};
    }),

  getMessages: (chatId) => get().messages[chatId] ?? [],

  clearChat: (chatId) =>
    set((state) => {
      const messages = { ...state.messages };
      const statuses = { ...state.statuses };
      const errors = { ...state.errors };
      delete messages[chatId];
      delete statuses[chatId];
      delete errors[chatId];
      return {
        messages,
        statuses,
        errors,
        runStartedAt: withoutRunStart(state.runStartedAt, chatId),
      };
    }),

  reset: () => set({ messages: {}, statuses: {}, errors: {}, runStartedAt: {} }),
}));
