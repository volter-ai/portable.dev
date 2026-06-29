/**
 * useNativeSocket — the RN Socket.IO ViewModel.
 *
 * Owns the socket lifecycle on top of the transport-agnostic shared core
 * (`@vgit2/shared/socket`): it builds the client with `createSocket()`, binds
 * the connection handlers, and injects the React Native lifecycle — `AppState`
 * (reconnect + resync on foreground `active`, NOT `document.hidden`) and
 * `NetInfo` (proactive reconnect on offline → online).
 *
 * Connection signals (`socketio:connected` / `socketio:disconnected` /
 * `socketio:reconnecting`, `chat:created`) are surfaced as Zustand state
 * (`useSocketStore`) and an optional `onChatCreated` callback — there is no DOM
 * in RN.
 *
 * Reconnect strategy is mobile-tuned for battery: the shared core's 1s→5s
 * backoff is kept, reconnection retries forever while foregrounded, and
 * reconnection is PAUSED while backgrounded so a dead network does not spin
 * retries in the background (resumed on the next `active`).
 */

import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  createSocket,
  createSocketEmitters,
  type ChatCreatePayload,
  type ChatJoinPayload,
  type ChatSummaryUpdatedPayload,
  type ContainerStatusPayload,
  type ChatLinkedIssueUpdatedPayload,
  type ClaudeErrorPayload,
  type ClaudeProcessingPayload,
  type ClaudeStatusPayload,
  type ClaudeStreamPayload,
  type CreateSocketOptions,
  type AskUserQuestionEventPayload,
  type SecretsSubmittedPayload,
  type SessionExpiredPayload,
  type SessionReapedPayload,
  type ToolPermissionRequiredPayload,
  type SocketLike,
  type SystemIdleShutdownPayload,
  type SystemIdleWarningPayload,
  type UserRuntimeStatePayload,
} from '@vgit2/shared/socket';
import type {
  BufferedMessage,
  ChatStatus,
  ProcessData,
  SandboxMetrics,
  TunnelData,
  UploadedFile,
} from '@vgit2/shared/types';
import { stripAutopilotCompletionInstruction } from '@vgit2/shared/utils/autopilotHelpers';
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef } from 'react';

// FILE import (not the pc-connect barrel) so the socket feature does not pull the
// heavy PcConnectGate graph in — the relay handshake credential is the connected
// PC's device token, falling back to the legacy authToken.
import { resolveDataPathToken } from '../pc-connect/dataPathToken';
// Direct import (NOT the chat barrel) so the socket feature does not pull in the
// chat screens — which import this socket feature — and create a module cycle.
import { useChatMessagesStore, type MobileChatMessage } from '../chat/chatMessagesStore';
// FILE import (not the chat barrel) — the transform is dep-free; importing the
// barrel would pull the chat screens (expo-audio, markdown, …) into the socket graph.
import { transformBufferedMessages } from '../chat/messageTransformers';
// FILE import (not the health barrel) — avoids a socket ↔ health barrel cycle.
import { useSandboxSessionStore } from '../health/sandboxSessionStore';
import { optimisticRepoPath, useChatChromeStore } from '../chat/chrome/chatChromeStore';
import { useInteractionStore } from '../chat/interactions/interactionStore';
import { getRelayUrl } from '../api/relayUrlStore';
import { useRuntimeStore } from '../state/runtimeStore';
import { ConnectionHealthMonitor, type ReconnectCause } from './connectionHealth';
import { defaultAppState, defaultNetInfo, type AppStateLike, type NetInfoLike } from './lifecycle';
import { relaySocketTarget } from './relaySocketTarget';
import { useReadMarkerStore } from './readMarkerStore';
import { useSocketStore } from './socketStore';
import { useSystemWarningsStore } from './systemWarningsStore';

/**
 * Mobile-tuned Socket.IO options merged over the shared `createSocket` defaults.
 *
 * `pingInterval` / `pingTimeout` are negotiated from the server handshake
 * (engine.io) and cannot be set on the client; the reconnection backoff
 * (1s → 5s, from the shared defaults) is the battery-relevant knob. We retry
 * forever while foregrounded and pause retries while backgrounded (see the
 * AppState effect below).
 */
export const MOBILE_SOCKET_OPTIONS: CreateSocketOptions = {
  reconnectionAttempts: Infinity,
  withCredentials: true,
};

export interface NativeSocketDeps {
  /** Resolve the auth token for the handshake (default: SecureStore). */
  getAuthToken?: () => Promise<string | null>;
  /** Resolve the mutable sandbox base URL (default: SecureStore). Socket is deferred until non-null. */
  getRelayUrl?: () => Promise<string | null>;
  /** Socket factory (default: shared `createSocket`); injected in tests. */
  createSocketImpl?: typeof createSocket;
  /** AppState source (default: React Native `AppState`). */
  appState?: AppStateLike;
  /** NetInfo source (default: `@react-native-community/netinfo`). */
  netInfo?: NetInfoLike;
  /** Invoked when the server emits `chat:created`. */
  onChatCreated?: (chatId: string) => void;
  /** Extra socket options merged over {@link MOBILE_SOCKET_OPTIONS}. */
  socketOptions?: CreateSocketOptions;
  /**
   * Resolve this build's app version, sent in the Socket.IO handshake
   * (`auth.appVersion`) so the backend can detect pre-handshake (outdated)
   * native builds. Default reads `Constants.expoConfig.version`
   * (baked into the bundle from `app.json`); injectable for tests.
   */
  getAppVersion?: () => string | undefined;
  /**
   * Resolve this device's make/model, sent in the Socket.IO handshake
   * (`auth.deviceName`) so the PC launcher's terminal UI can name the connected
   * phone (e.g. "Apple iPhone 15 Pro"). Default reads `expo-device`; injectable
   * for tests.
   */
  getDeviceName?: () => string | undefined;
}

/** Read this build's own version (baked into the bundle from app.json). */
function defaultGetAppVersion(): string | undefined {
  return Constants.expoConfig?.version ?? undefined;
}

/**
 * Best-effort device make/model from `expo-device` (lazy-required so the native
 * module never enters the Jest/Metro graph of a non-socket consumer, and so an
 * older build without the dep degrades to `undefined` rather than crashing).
 * Prefers "<manufacturer> <model>" (e.g. "samsung SM-S931B", "Apple iPhone 15
 * Pro"), falling back to the user-set device name.
 */
function defaultGetDeviceName(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Device = require('expo-device') as {
      manufacturer?: string | null;
      modelName?: string | null;
      deviceName?: string | null;
    };
    const makeModel = [Device.manufacturer, Device.modelName].filter(Boolean).join(' ').trim();
    return makeModel || Device.deviceName || undefined;
  } catch {
    return undefined;
  }
}

export interface NativeSocket {
  /** Lazily-resolved current socket (replaced on reconnect/recovery). */
  getSocket: () => SocketLike | null;
  /** The shared named emit helpers bound to the current socket. */
  emitters: ReturnType<typeof createSocketEmitters>;
  /** Join a chat room AND track it so it is rejoined on reconnect-resync. */
  joinChat: (
    payload: ChatJoinPayload
  ) => ReturnType<ReturnType<typeof createSocketEmitters>['joinChat']>;
  /** Force a reconnect (if needed) and resync joined rooms. */
  reconnectAndSync: () => void;
}

/** Best-effort toggle of the socket.io manager's reconnection (no-op on mock sockets). */
function setReconnection(socket: SocketLike | null, enabled: boolean): void {
  const manager = (socket as { io?: { reconnection?: (v: boolean) => unknown } } | null)?.io;
  manager?.reconnection?.(enabled);
}

/**
 * The shared emitters with one RN-side augmentation: a successful
 * `chat:create` ack seeds the chrome store's repo-path sink optimistically, so
 * a chat opened straight from creation (repo Overview hand-off, home composer,
 * task viewer — every create path goes through this provider) shows the git
 * banner / repo header even against a backend whose `chat:created` broadcast
 * never arrives. Set-if-absent: the authoritative `repo_path` folded in by the
 * `chat:created` handler always wins regardless of arrival order.
 */
function buildEmitters(
  getSocket: () => SocketLike | null
): ReturnType<typeof createSocketEmitters> {
  const base = createSocketEmitters(getSocket);
  return {
    ...base,
    createChat: async (payload: ChatCreatePayload) => {
      const ack = await base.createChat(payload);
      if (ack?.success !== false && payload.owner && payload.repo) {
        useChatChromeStore
          .getState()
          .seedRepoPath(payload.chatId, optimisticRepoPath(payload.owner, payload.repo));
      }
      return ack;
    },
  };
}

export function useNativeSocket(deps: NativeSocketDeps = {}): NativeSocket {
  const socketRef = useRef<SocketLike | null>(null);
  const joinedRooms = useRef<Set<string>>(new Set());
  const onChatCreatedRef = useRef(deps.onChatCreated);
  onChatCreatedRef.current = deps.onChatCreated;

  // The tiered connection-health machine (built per mount in the socket effect). It
  // owns the cheap WS heartbeat + the HTTP `/api/health` fallback + the forced
  // reconnect — the authoritative liveness signal, because socket.io's `connected`
  // flag lies after a relay/tunnel changeover (see connectionHealth.ts). Held in a
  // ref so the long-lived `connect`/`disconnect`/AppState/NetInfo handlers reach the
  // CURRENT monitor without re-subscribing.
  const healthRef = useRef<ConnectionHealthMonitor | null>(null);

  // Read the latest deps at (re)build time without re-creating the build closure.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const emittersRef = useRef(buildEmitters(() => socketRef.current));

  const getSocket = useCallback(() => socketRef.current, []);

  /** Rejoin every tracked room — the resync run on (re)connect and on resume. */
  const resync = useCallback(() => {
    const sock = socketRef.current;
    if (!sock) return;
    for (const chatId of joinedRooms.current) {
      // The backend join handler reads `count` (recent N); the old `limit`/`offset`
      // were silently ignored. Capture the ack and MERGE it (don't drop it): a
      // reconnect re-join is the most common re-entry, and a blind replace
      // with a lagging buffer would wipe live-streamed messages. `applyJoinedHistory`
      // no-ops on an empty ack and guards status adoption while the chat is live.
      sock.emit(CLIENT_EVENTS.CHAT_JOIN, { chatId, count: 50 }, (ack: unknown) => {
        const a = ack as { messages?: BufferedMessage[]; status?: ChatStatus } | undefined;
        if (!a?.messages) return;
        useChatMessagesStore
          .getState()
          .applyJoinedHistory(chatId, transformBufferedMessages(a.messages), a.status);
      });
    }
  }, []);

  const reconnectAndSync = useCallback(() => {
    const sock = socketRef.current;
    if (!sock) return;
    if (!sock.connected) {
      // Surface the reconnecting phase, then reconnect; the `connect` handler
      // performs the resync once the transport is back.
      useSocketStore.getState().setConnectionState('reconnecting');
      sock.connect?.();
    } else {
      // Already connected (e.g. resumed before the OS tore the socket down):
      // just resync joined rooms.
      resync();
    }
  }, [resync]);

  const joinChat = useCallback<NativeSocket['joinChat']>((payload) => {
    joinedRooms.current.add(payload.chatId);
    return emittersRef.current.joinChat(payload);
  }, []);

  /** Bind all server→client handlers to a freshly-built socket. */
  const bindHandlers = useCallback(
    (sock: SocketLike) => {
      const handleConnect = () => {
        const store = useSocketStore.getState();
        const isReconnect = store.hasConnectedOnce;
        store.markConnected(sock.id ?? null);
        // A live connect means the session is back: drop the re-provision
        // overlay if it is still up (belt-and-braces — the epoch remount
        // normally resets the warnings store via this provider's cleanup).
        useSystemWarningsStore.getState().clearSessionEnded();
        // Resync only on RECONNECTION (initial connect rejoins via explicit
        // joins).
        if (isReconnect) resync();
        // A live transport is up — the health machine confirms it with a heartbeat
        // and settles HEALTHY (this is also what BREAKS the reconnect loop after a
        // forced reconnect).
        healthRef.current?.notifyConnected();
      };
      const handleDisconnect = () => {
        useSocketStore.getState().markDisconnected();
        // Don't wait for the slow engine.io ping timeout — drive the reconnect now.
        healthRef.current?.notifyDisconnected();
      };
      const handleConnectError = () => useSocketStore.getState().setConnectionState('reconnecting');
      const handleChatCreated = (...args: unknown[]) => {
        const data = args[0] as { chat?: { id?: string; repo_path?: string } } | undefined;
        const chatId = data?.chat?.id;
        if (!chatId) return;
        // A freshly-created chat is not in the chat-directory query cache, so
        // fold its `repo_path` into the chrome store — it is `useChatRepoPath`'s
        // only source for chats opened straight from creation (repo hand-off).
        if (data?.chat?.repo_path) {
          useChatChromeStore.getState().setRepoPath(chatId, data.chat.repo_path);
        }
        useSocketStore.getState().setLastCreatedChatId(chatId);
        onChatCreatedRef.current?.(chatId);
      };
      // Fork-on-first-write: the PC forked a Claude Code chat into a new Portable chat.
      // Record it so the screen with `oldChatId` open redirects to `newChatId` (the
      // companion `chat:created` already refreshed the directory + seeded its repo path).
      const handleChatForked = (...args: unknown[]) => {
        const data = args[0] as { oldChatId?: string; newChatId?: string } | undefined;
        if (!data?.oldChatId || !data.newChatId) return;
        useSocketStore.getState().setLastForkedChat(data.oldChatId, data.newChatId);
      };
      // Multi-device read-marker sync: fold `chat:read_updated` into the read-marker
      // store. On a reconnect-resync the rejoined `chat:join` catches history up and
      // the read marker reconciles in via this event.
      const handleReadUpdated = (...args: unknown[]) => {
        const data = args[0] as { chatId?: string; messageId?: number } | undefined;
        if (!data?.chatId || typeof data.messageId !== 'number') return;
        useReadMarkerStore.getState().setReadMarker(data.chatId, data.messageId);
      };

      // Live Claude streaming — fold the `claude:*` run events + the backend
      // `user_message` echo into the per-chat message store. RN surfaces it as
      // Zustand state the active-chat FlatList subscribes to. Bound here (in
      // `bindHandlers`) so the listeners survive a recovery re-point like the others.
      const handleClaudeStream = (...args: unknown[]) => {
        const data = args[0] as Partial<ClaudeStreamPayload> | undefined;
        if (!data?.chatId || !data.block) return;
        useChatMessagesStore.getState().appendBlock(data.chatId, data.block);
      };
      const handleClaudeProcessing = (...args: unknown[]) => {
        const data = args[0] as Partial<ClaudeProcessingPayload> | undefined;
        if (!data?.chatId) return;
        useChatMessagesStore.getState().setStatus(data.chatId, 'running');
      };
      const handleClaudeStatus = (...args: unknown[]) => {
        const data = args[0] as Partial<ClaudeStatusPayload> | undefined;
        if (!data?.chatId || !data.status) return;
        // `idle` (a persistent session waiting) reads as completed for the UI.
        const status: ChatStatus =
          data.status === 'idle' ? 'completed' : (data.status as ChatStatus);
        useChatMessagesStore.getState().setStatus(data.chatId, status);
      };
      const handleClaudeInterrupted = (...args: unknown[]) => {
        const data = args[0] as { chatId?: string } | undefined;
        if (!data?.chatId) return;
        useChatMessagesStore.getState().markInterrupted(data.chatId);
      };
      const handleClaudeError = (...args: unknown[]) => {
        const data = args[0] as Partial<ClaudeErrorPayload> | undefined;
        if (!data?.chatId) return;
        useChatMessagesStore
          .getState()
          .markError(data.chatId, data.error ?? 'Claude run failed', data.errorBlock);
      };
      const handleUserMessage = (...args: unknown[]) => {
        const data = args[0] as
          | {
              chatId?: string;
              id?: string;
              content?: string;
              timestamp?: number;
              uploadedFiles?: unknown[];
            }
          | undefined;
        if (!data?.chatId) return;
        const message: MobileChatMessage = {
          role: 'user',
          id: data.id,
          // The live echo carries the AUGMENTED content when autopilot is on (the user
          // text + the completion instruction). Strip the injected instruction so the
          // optimistic bubble is never replaced with the leaked prompt — matching what
          // re-join shows via `customDisplay`. A no-op otherwise.
          content: stripAutopilotCompletionInstruction(data.content ?? ''),
          timestamp: data.timestamp,
          uploadedFiles: data.uploadedFiles as UploadedFile[] | undefined,
        };
        useChatMessagesStore.getState().appendUserMessage(data.chatId, message);
      };

      // Chat chrome: the AI summary + the container setup status fold into
      // `chatChromeStore` (keyed by chatId), which the GitStatusBanner /
      // ContainerStatusBanner / summary panel subscribe to. Bound globally (like
      // `claude:*`) so background chats stay current and the listeners survive a
      // recovery re-point.
      const handleSummaryUpdated = (...args: unknown[]) => {
        const data = args[0] as Partial<ChatSummaryUpdatedPayload> | undefined;
        if (!data?.chatId || typeof data.summary !== 'string') return;
        useChatChromeStore.getState().setSummary(data.chatId, data.summary);
      };
      const handleContainerStatus = (...args: unknown[]) => {
        const data = args[0] as Partial<ContainerStatusPayload> | undefined;
        if (!data?.chatId || !data.status) return;
        useChatChromeStore.getState().setContainerStatus(data.chatId, {
          status: data.status,
          message: data.message ?? '',
        });
      };
      // Linked GitHub issue: fold `chat:linkedIssueUpdated` into the chrome store
      // so the active-chat header badge reflects a mid-session link/unlink live.
      // `null` is an explicit unlink.
      const handleLinkedIssueUpdated = (...args: unknown[]) => {
        const data = args[0] as Partial<ChatLinkedIssueUpdatedPayload> | undefined;
        if (!data?.chatId) return;
        useChatChromeStore.getState().setLinkedIssue(data.chatId, data.linkedIssue ?? null);
      };

      // Interactive prompts. Permission flags the matching streamed tool block
      // (retroactive); the ask-user prompt + the secrets:submitted confirmation
      // fold into the interaction store, which the ChatInteractionProvider
      // surfaces drive.
      const handleToolPermissionRequired = (...args: unknown[]) => {
        const data = args[0] as Partial<ToolPermissionRequiredPayload> | undefined;
        if (!data?.chat_id || !data.request_id || !data.tool_name) return;
        useChatMessagesStore.getState().markToolPermissionRequired(data.chat_id, {
          requestId: data.request_id,
          toolName: data.tool_name,
        });
      };
      const handleAskUserQuestion = (...args: unknown[]) => {
        const data = args[0] as Partial<AskUserQuestionEventPayload> | undefined;
        if (!data?.chat_id || !data.request_id || !Array.isArray(data.questions)) return;
        useInteractionStore.getState().setAskPrompt({
          chatId: data.chat_id,
          requestId: data.request_id,
          questions: data.questions,
          toolUseId: data.tool_use_id,
        });
      };
      const handleSecretsSubmitted = (...args: unknown[]) => {
        const data = args[0] as Partial<SecretsSubmittedPayload> | undefined;
        if (!data?.chatId) return;
        useInteractionStore.getState().setSecretsStatus(data.chatId, 'submitted');
      };

      // System lifecycle warnings + lifecycle routing. RN folds them into the
      // warnings store and `SystemWarnings` renders native modals + a
      // re-provision/loading overlay (NO redirect). NB `system:shutdown_warning`
      // is deliberately NOT bound — RN shows no pending-shutdown banner (the
      // recovery layer recovers a dead sandbox transparently).
      const handleIdleWarning = (...args: unknown[]) => {
        const data = args[0] as Partial<SystemIdleWarningPayload> | undefined;
        useSystemWarningsStore.getState().setIdleWarning({
          message: data?.message ?? 'Are you still there?',
          timeRemaining: typeof data?.timeRemaining === 'number' ? data.timeRemaining : 0,
        });
      };
      const handleIdleWarningCleared = () => useSystemWarningsStore.getState().clearIdleWarning();
      // Idle shutdown + session expiry are TERMINAL: the sandbox session is gone,
      // so route to the re-provision/loading state instead of a dismissable modal.
      const handleIdleShutdown = (...args: unknown[]) => {
        const data = args[0] as Partial<SystemIdleShutdownPayload> | undefined;
        useSystemWarningsStore.getState().setSessionEnded({
          reason: 'idle_shutdown',
          message: data?.message ?? 'Your session ended due to inactivity. Reconnecting…',
        });
      };
      const handleSessionExpired = (...args: unknown[]) => {
        const data = args[0] as Partial<SessionExpiredPayload> | undefined;
        useSystemWarningsStore.getState().setSessionEnded({
          reason: 'session_expired',
          message: data?.reason ?? 'Your session expired. Reconnecting…',
        });
      };

      // Runtime stream: the PC broadcasts a FULL snapshot of the user's active
      // resources (`user:runtime_state`, sent on connect + on every change —
      // each array REPLACES the prior) plus the high-frequency host metric
      // channel (`sandbox:metrics`). All fold into the in-memory `runtimeStore`
      // (rebuilt per connect, like the other socket-sourced stores), which the
      // RuntimeBox subscribes to.
      const handleUserRuntimeState = (...args: unknown[]) => {
        const data = args[0] as UserRuntimeStatePayload | undefined;
        if (!data) return;
        useRuntimeStore.getState().applySnapshot({
          tunnels: Array.isArray(data.tunnels) ? (data.tunnels as TunnelData[]) : [],
          processes: Array.isArray(data.backgroundProcesses)
            ? (data.backgroundProcesses as ProcessData[])
            : [],
          // Live Claude sessions.
          claudeSessions: Array.isArray(data.claudeSessions) ? data.claudeSessions : [],
          claudeSessionIdleTtlMs:
            typeof data.claudeSessionIdleTtlMs === 'number' ? data.claudeSessionIdleTtlMs : null,
        });
      };
      // `session:reaped` — the idle reaper freed a session. Drop it from the
      // panel optimistically (a fresh `user:runtime_state` follows).
      const handleSessionReaped = (...args: unknown[]) => {
        const payload = args[0] as SessionReapedPayload | undefined;
        if (!payload?.chatId) return;
        useRuntimeStore.getState().removeClaudeSession(payload.chatId);
      };
      const handleSandboxMetrics = (...args: unknown[]) => {
        const metrics = args[0] as SandboxMetrics | undefined;
        if (!metrics) return;
        useRuntimeStore.getState().setSandboxMetrics(metrics);
      };

      sock.on(SERVER_EVENTS.CONNECT, handleConnect);
      sock.on(SERVER_EVENTS.DISCONNECT, handleDisconnect);
      sock.on(SERVER_EVENTS.CONNECT_ERROR, handleConnectError);
      sock.on(SERVER_EVENTS.CHAT_CREATED, handleChatCreated);
      sock.on(SERVER_EVENTS.CHAT_FORKED, handleChatForked);
      sock.on(SERVER_EVENTS.CHAT_READ_UPDATED, handleReadUpdated);
      sock.on(SERVER_EVENTS.CLAUDE_STREAM, handleClaudeStream);
      sock.on(SERVER_EVENTS.CLAUDE_PROCESSING, handleClaudeProcessing);
      sock.on(SERVER_EVENTS.CLAUDE_STATUS, handleClaudeStatus);
      sock.on(SERVER_EVENTS.CLAUDE_INTERRUPTED, handleClaudeInterrupted);
      sock.on(SERVER_EVENTS.CLAUDE_ERROR, handleClaudeError);
      sock.on(SERVER_EVENTS.USER_MESSAGE, handleUserMessage);
      sock.on(SERVER_EVENTS.CHAT_SUMMARY_UPDATED, handleSummaryUpdated);
      sock.on(SERVER_EVENTS.CONTAINER_STATUS, handleContainerStatus);
      sock.on(SERVER_EVENTS.CHAT_LINKED_ISSUE_UPDATED, handleLinkedIssueUpdated);
      sock.on(SERVER_EVENTS.TOOL_PERMISSION_REQUIRED, handleToolPermissionRequired);
      sock.on(SERVER_EVENTS.ASK_USER_QUESTION, handleAskUserQuestion);
      sock.on(SERVER_EVENTS.SECRETS_SUBMITTED, handleSecretsSubmitted);
      sock.on(SERVER_EVENTS.SYSTEM_IDLE_WARNING, handleIdleWarning);
      sock.on(SERVER_EVENTS.SYSTEM_IDLE_WARNING_CLEARED, handleIdleWarningCleared);
      sock.on(SERVER_EVENTS.SYSTEM_IDLE_SHUTDOWN, handleIdleShutdown);
      sock.on(SERVER_EVENTS.SESSION_EXPIRED, handleSessionExpired);
      sock.on(SERVER_EVENTS.USER_RUNTIME_STATE, handleUserRuntimeState);
      sock.on(SERVER_EVENTS.SANDBOX_METRICS, handleSandboxMetrics);
      sock.on(SERVER_EVENTS.SESSION_REAPED, handleSessionReaped);
    },
    [resync]
  );

  /**
   * Build the socket against the CURRENT auth token + sandbox URL (both read
   * fresh at mount — a sandbox-death re-provision REMOUNTS this provider, so a
   * fresh socket is always built against the new URL) and bind its handlers.
   * Deferred until a sandbox URL exists. Returns whether a socket was built.
   */
  const buildSocket = useCallback(async (): Promise<boolean> => {
    const d = depsRef.current;
    // Resolve the token + sandbox URL CONCURRENTLY: they are independent
    // SecureStore reads, so reading them in parallel shaves one keychain
    // round-trip off the post-health-gate socket bring-up (the "server up but
    // app still connecting" tail). The `!url` guard is unchanged.
    const [token, url] = await Promise.all([
      (d.getAuthToken ?? resolveDataPathToken)(),
      (d.getRelayUrl ?? getRelayUrl)(),
    ]);
    if (!url) return false;

    // Report this build's version in the handshake so the backend can detect
    // pre-handshake (outdated) native builds. Older builds send nothing.
    const appVersion = (d.getAppVersion ?? defaultGetAppVersion)();
    const deviceName = (d.getDeviceName ?? defaultGetDeviceName)();
    const factory = d.createSocketImpl ?? createSocket;
    // The relay base is the path-PREFIXED `<gatewayBase>/t/<pcId>`. socket.io-client
    // treats a URL's pathname as the namespace, NOT the engine.io path — so connect
    // to the ORIGIN and carry the `/t/<pcId>` prefix in the `path` option, otherwise
    // the handshake bypasses the relay and the socket never connects (see
    // `relaySocketTarget`).
    const { origin, path: socketPath } = relaySocketTarget(url);
    const sock = factory(token, origin, {
      ...MOBILE_SOCKET_OPTIONS,
      path: socketPath,
      ...d.socketOptions,
      auth: {
        token: token ?? '',
        ...(appVersion ? { appVersion } : {}),
        ...(deviceName ? { deviceName } : {}),
      },
    });
    socketRef.current = sock;
    bindHandlers(sock);
    return true;
  }, [bindHandlers]);

  /**
   * Build the connection-health machine for this mount, wiring its I/O seams to the
   * live socket. The seams are the ONLY socket.io-specific code; the tiered ladder
   * itself is the pure {@link ConnectionHealthMonitor}.
   */
  const makeHealthMonitor = useCallback((): ConnectionHealthMonitor => {
    return new ConnectionHealthMonitor({
      // Cheap WS heartbeat: emit `ping`, the PC acks it (SocketIOService) — a tiny
      // frame each way, far below engine.io's own keepalive cost. Resolve false on
      // timeout / no-socket / reject so a dead endpoint is detected fast, NOT after
      // engine.io's 120s ping timeout.
      sendHeartbeat: (timeoutMs) => {
        const sock = socketRef.current;
        if (!sock || !sock.connected) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (v: boolean) => {
            if (done) return;
            done = true;
            resolve(v);
          };
          const t = setTimeout(() => finish(false), timeoutMs);
          emittersRef.current
            .ping()
            .then(() => {
              clearTimeout(t);
              finish(true);
            })
            .catch(() => {
              clearTimeout(t);
              finish(false);
            });
        });
      },
      // Cheap NEGATIVE-only signal (a reported-UP socket is never trusted as alive).
      isSocketConnected: () => socketRef.current?.connected ?? false,
      // HTTP fallback: probe the SAME relay endpoint the app uses end-to-end. 200 +
      // {status:'ok'} ⇒ the endpoint is reachable but the WS is wedged; anything else
      // ⇒ the tunnel/endpoint is down. Public route — no auth needed.
      httpProbe: async (timeoutMs) => {
        try {
          const url = await (depsRef.current.getRelayUrl ?? getRelayUrl)();
          if (!url) return false;
          const controller =
            typeof AbortController !== 'undefined' ? new AbortController() : undefined;
          const t = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
          try {
            const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
              signal: controller?.signal,
            });
            if (!res.ok) return false;
            const body = (await res.json().catch(() => null)) as { status?: string } | null;
            return body?.status === 'ok';
          } finally {
            if (t) clearTimeout(t);
          }
        } catch {
          return false;
        }
      },
      // Force a fresh transport. disconnect→connect rebuilds the engine connection
      // (a new handshake to the stable /t/<pcId> relay, now repointed to the live
      // tunnel) — the deterministic recovery socket.io's own auto-reconnect failed to
      // do over the relay. The resulting `connect` calls notifyConnected().
      forceReconnect: (_cause: ReconnectCause) => {
        const sock = socketRef.current;
        if (!sock) return;
        setReconnection(sock, true);
        try {
          sock.disconnect?.();
        } catch {
          // ignore
        }
        try {
          sock.connect?.();
        } catch {
          // ignore
        }
      },
      // Surface the coarse phase for the UI (ReconnectingBanner). Probing is a silent
      // check (no banner flash); only a confirmed reconnect shows "reconnecting".
      onStateChange: (s) => {
        if (s === 'reconnecting') useSocketStore.getState().setConnectionState('reconnecting');
        else if (s === 'healthy') useSocketStore.getState().setConnectionState('connected');
      },
    });
  }, []);

  // --- Socket creation + handler binding (once, after sandbox URL is available) ---
  useEffect(() => {
    let cancelled = false;
    // Build the health machine for this mount BEFORE the socket, so the connect
    // handler (which fires during buildSocket) can reach it via healthRef.
    const monitor = makeHealthMonitor();
    healthRef.current = monitor;
    monitor.start();

    void (async () => {
      const built = await buildSocket();
      // If the component unmounted while we were resolving the URL/token, undo it
      // — with the manager's reconnection disabled FIRST, so no queued retry
      // fires against a dead URL after teardown.
      if (cancelled && built) {
        monitor.stop();
        setReconnection(socketRef.current, false);
        socketRef.current?.disconnect?.();
        socketRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
      monitor.stop();
      healthRef.current = null;
      // Stop the io manager BEFORE disconnecting: with reconnectionAttempts =
      // Infinity a queued retry could otherwise still hit the (possibly dead)
      // URL after this provider unmounts (the epoch remount relies on this
      // teardown to silence the old sandbox's transport for good).
      setReconnection(socketRef.current, false);
      socketRef.current?.disconnect?.();
      socketRef.current = null;
      joinedRooms.current.clear();
      useSocketStore.getState().reset();
      useReadMarkerStore.getState().reset();
      useSystemWarningsStore.getState().reset();
      useChatMessagesStore.getState().reset();
      useChatChromeStore.getState().reset();
      useInteractionStore.getState().reset();
      useRuntimeStore.getState().reset();
    };
    // Socket is built once per mount; deps are read fresh at (re)build time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildSocket, makeHealthMonitor]);

  // --- AppState: reconnect + resync on foreground; pause retries while backgrounded ---
  useEffect(() => {
    const appState = deps.appState ?? defaultAppState;
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Belt-and-braces: while a sandbox-death re-provision is in flight this
        // provider is about to unmount — never resurrect the old (dead-URL)
        // transport from a foreground transition.
        if (useSandboxSessionStore.getState().reprovisioning) return;
        setReconnection(socketRef.current, true);
        // Clean-disconnect recovery stays here (unchanged); the health machine's
        // resume() additionally re-arms the heartbeat so a socket that is lying
        // `connected:true` against a dead endpoint is caught on foreground.
        reconnectAndSync();
        healthRef.current?.resume();
      } else if (next === 'background' || next === 'inactive') {
        // Battery: pause the heartbeat + the io manager's retries while backgrounded.
        healthRef.current?.suspend();
        setReconnection(socketRef.current, false);
      }
    });
    return () => sub.remove();
  }, [reconnectAndSync, resync, deps.appState]);

  // --- NetInfo: proactively reconnect on the offline → online transition ---
  useEffect(() => {
    const netInfo = deps.netInfo ?? defaultNetInfo;
    let prevOnline = true;
    const unsub = netInfo.addEventListener((state) => {
      const online = state.isConnected !== false;
      // Same re-provision guard as the AppState handler.
      if (online && !prevOnline && !useSandboxSessionStore.getState().reprovisioning) {
        reconnectAndSync();
        healthRef.current?.resume();
      } else if (!online && prevOnline) {
        // Device itself went offline — pause the heartbeat (it can't reach the relay
        // anyway); the online edge above re-arms it.
        healthRef.current?.suspend();
      }
      prevOnline = online;
    });
    return unsub;
  }, [reconnectAndSync, deps.netInfo]);

  return { getSocket, emitters: emittersRef.current, joinChat, reconnectAndSync };
}
