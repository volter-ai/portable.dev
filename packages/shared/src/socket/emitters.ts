/**
 * Transport-agnostic Socket.IO emit helpers.
 *
 * Every client→server message goes through one of these helpers so the React
 * Native (`packages/mobile`) client emits a consistent event name + payload shape
 * and honours the same callback-ack
 * contract. The helpers are *pure wire primitives*: they emit and resolve with
 * the server ack (or fire-and-forget where the server sends none). Platform /
 * UI concerns (optimistic updates, rollback, queuing) stay in the caller.
 */

import {
  CLIENT_EVENTS,
  type AnswerUserQuestionPayload,
  type ChatCreatePayload,
  type ChatJoinPayload,
  type ChatLoadMorePayload,
  type ChatMarkReadPayload,
  type ChatMessagePayload,
  type ChatUpdateSettingsPayload,
  type ChatKillSessionPayload,
  type ClaudeInterruptPayload,
  type PermissionRespondPayload,
  type SecretsCancelPayload,
  type SecretsSubmitPayload,
  type SocketAck,
} from './events.js';

import type { SocketLike } from './createSocket.js';
import type {
  SocketIOChatJoinResponse,
  SocketIOLoadMoreResponse,
  SocketIOMessageResponse,
} from '../types/index.js';

/** Lazily resolves the current socket (which is replaced on reconnect/recovery). */
export type SocketGetter = () => SocketLike | null | undefined;

/**
 * Emit an event and resolve with the server's ack. Rejects with
 * `Socket not connected` when there is no socket — matching the existing web
 * client behaviour at every emit call site.
 */
export function emitWithAck<TAck = SocketAck>(
  socket: SocketLike | null | undefined,
  event: string,
  payload: unknown
): Promise<TAck> {
  return new Promise<TAck>((resolve, reject) => {
    if (!socket) {
      reject(new Error('Socket not connected'));
      return;
    }
    socket.emit(event, payload, (ack: TAck) => resolve(ack));
  });
}

/**
 * Fire-and-forget emit (server sends no ack). Returns `false` when there is no
 * socket so the caller can decide how to handle the dropped send.
 */
export function emitFireAndForget(
  socket: SocketLike | null | undefined,
  event: string,
  payload: unknown
): boolean {
  if (!socket) return false;
  socket.emit(event, payload);
  return true;
}

/**
 * Build the full set of named emit helpers bound to a (lazily-resolved) socket.
 * The web and native socket providers each call this once with their own
 * `getSocket` and expose the result.
 */
export function createSocketEmitters(getSocket: SocketGetter) {
  const sock = () => getSocket();

  return {
    /** `chat:create` */
    createChat: (payload: ChatCreatePayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.CHAT_CREATE, payload),

    /** `chat:join` — resolves with the join ack (messages + status + paging). */
    joinChat: (payload: ChatJoinPayload) =>
      emitWithAck<SocketIOChatJoinResponse>(sock(), CLIENT_EVENTS.CHAT_JOIN, payload),

    /** `chat:load_more` */
    loadMore: (payload: ChatLoadMorePayload) =>
      emitWithAck<SocketIOLoadMoreResponse>(sock(), CLIENT_EVENTS.CHAT_LOAD_MORE, payload),

    /** `chat:message` */
    sendMessage: (payload: ChatMessagePayload) =>
      emitWithAck<SocketIOMessageResponse>(sock(), CLIENT_EVENTS.CHAT_MESSAGE, payload),

    /** `claude:interrupt` */
    interruptClaude: (payload: ClaudeInterruptPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.CLAUDE_INTERRUPT, payload),

    /** `chat:kill-session` — user-initiated session termination. */
    killSession: (payload: ChatKillSessionPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.CHAT_KILL_SESSION, payload),

    /** `permission:respond` */
    respondToPermission: (payload: PermissionRespondPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.PERMISSION_RESPOND, payload),

    /** `answer_user_question` — fire-and-forget (server emits no ack). */
    answerUserQuestion: (payload: AnswerUserQuestionPayload) =>
      emitFireAndForget(sock(), CLIENT_EVENTS.ANSWER_USER_QUESTION, payload),

    /** `chat:mark_read` */
    markRead: (payload: ChatMarkReadPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.CHAT_MARK_READ, payload),

    /** `chat:update_settings` */
    updateSettings: (payload: ChatUpdateSettingsPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.CHAT_UPDATE_SETTINGS, payload),

    /** `secrets:submit` */
    submitSecrets: (payload: SecretsSubmitPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.SECRETS_SUBMIT, payload),

    /** `secrets:cancel` */
    cancelSecrets: (payload: SecretsCancelPayload) =>
      emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.SECRETS_CANCEL, payload),

    /** `ping` — connection liveness probe. */
    ping: () => emitWithAck<SocketAck>(sock(), CLIENT_EVENTS.PING, {}),
  };
}

/** The named emit-helper bundle returned by {@link createSocketEmitters}. */
export type SocketEmitters = ReturnType<typeof createSocketEmitters>;
