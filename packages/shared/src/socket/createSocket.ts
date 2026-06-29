/**
 * Transport-agnostic Socket.IO client factory.
 *
 * `createSocket()` centralises the wire-level connection options used by the
 * React Native (`packages/mobile`) client so the handshake (path, auth shape,
 * reconnection policy, upgrade behaviour) stays consistent. Platform differences — reconnection caps, credentials,
 * transports, and any visibility / offline-persistence behaviour — are
 * *injected* by the caller via `opts`, never baked in here.
 */

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

/**
 * Minimal structural view of a Socket.IO client used by the emit helpers.
 * `socket.io-client`'s `Socket` satisfies this, and tests can supply a mock
 * without pulling the real transport.
 */
export interface SocketLike {
  connected: boolean;
  id?: string;
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
  connect?(): unknown;
  disconnect?(): unknown;
}

/** Options accepted by {@link createSocket}; any Socket.IO manager/socket option is injectable. */
export type CreateSocketOptions = Partial<ManagerOptions & SocketOptions>;

/**
 * Baseline connection options. Identical across platforms; callers override
 * the platform-specific bits (e.g. `reconnectionAttempts: Infinity` and
 * `withCredentials: true` on mobile) by passing them through `opts`.
 */
const DEFAULT_OPTIONS: CreateSocketOptions = {
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  upgrade: true,
  rememberUpgrade: true,
  closeOnBeforeunload: false,
};

/**
 * Create a configured Socket.IO client.
 *
 * @param authToken - Bearer/JWT auth token sent in the handshake `auth.token`.
 *   `null`/`undefined` yields an empty token (server rejects, as today).
 * @param baseUrl - Origin to connect to (`'/'` for same-origin web, the sandbox
 *   URL for native).
 * @param opts - Platform overrides merged over {@link DEFAULT_OPTIONS}. A custom
 *   `auth` object, if provided, takes precedence over `authToken`.
 */
export function createSocket(
  authToken: string | null | undefined,
  baseUrl: string,
  opts: CreateSocketOptions = {}
): Socket {
  const { auth: authOverride, ...rest } = opts;
  return io(baseUrl, {
    ...DEFAULT_OPTIONS,
    ...rest,
    auth: authOverride ?? { token: authToken ?? '' },
  });
}
