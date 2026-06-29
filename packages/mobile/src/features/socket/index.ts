/**
 * Native Socket.IO provider — RN client on the shared transport-agnostic core,
 * with AppState + NetInfo lifecycle injected and connection signals surfaced as
 * Zustand state / callbacks (no `window.dispatchEvent`).
 */

export { useSocketStore, type ConnectionState, type SocketConnectionState } from './socketStore';

export {
  useSystemWarningsStore,
  type SystemWarningsState,
  type IdleWarning,
  type SessionEnded,
  type SessionEndReason,
} from './systemWarningsStore';

export { SystemWarnings, type SystemWarningsProps } from './SystemWarnings';
export { extendSession, ACTIVITY_PING_PATH, type ExtendSessionDeps } from './extendSession';
export { ReconnectingBanner } from './ReconnectingBanner';

export { useReadMarkerStore, type ReadMarkerState } from './readMarkerStore';

export {
  useOfflineMessageQueue,
  type OfflineMessageQueue,
  type OfflineMessageQueueDeps,
} from './useOfflineMessageQueue';

export {
  flushOfflineQueue,
  type FlushQueueDeps,
  type FlushQueueResult,
  type SendAck,
} from './offlineQueue';

export {
  useNativeSocket,
  MOBILE_SOCKET_OPTIONS,
  type NativeSocket,
  type NativeSocketDeps,
} from './useNativeSocket';

export {
  SocketProvider,
  useSocket,
  useOptionalSocket,
  type SocketProviderProps,
} from './SocketProvider';

export {
  defaultAppState,
  defaultNetInfo,
  type AppStateLike,
  type NetInfoLike,
  type AppStateStatus,
} from './lifecycle';
