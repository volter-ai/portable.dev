/**
 * mockSocket — reusable Socket.IO mocking layer for `packages/mobile`
 * integration tests, the second half of the test harness.
 *
 * The shared transport-agnostic core (`@vgit2/shared/socket`) builds its client
 * by calling `io()` from `socket.io-client`. To exercise any code that goes
 * through `createSocket()` without opening a real transport, a test virtually
 * mocks `socket.io-client` so `io()` returns a {@link MockSocketController}'s
 * recording socket:
 *
 * ```ts
 * jest.mock(
 *   'socket.io-client',
 *   () => require('../src/test/mockSocket').createSocketIoMock(),
 *   { virtual: true }
 * );
 * // ...later, in a test:
 * const { __controller } = jest.requireMock('socket.io-client') as MockSocketIoModule;
 * __controller.emitServerEvent('chat:new_message', { ... });
 * ```
 *
 * The controller can drive **server → client** events (`emitServerEvent`) to any
 * listener registered via `socket.on(...)`, auto-acks **client → server** emits
 * (override per event), and records every client emission for assertions. This
 * mirrors the inline mock used by `socket-core.test.ts`, lifted into shared,
 * reusable harness infrastructure.
 */

import type { SocketLike } from '@vgit2/shared/socket';

/** A client→server emission observed by the mock socket. */
export interface RecordedEmission {
  event: string;
  /** Positional emit args excluding a trailing ack callback. */
  args: unknown[];
  /** Whether an ack callback was supplied as the last arg. */
  hadAck: boolean;
}

export interface MockSocketController {
  /** The mock socket itself — pass anywhere a `SocketLike` is expected. */
  readonly socket: SocketLike;
  /** All client→server emissions since the last `reset()`. */
  readonly emissions: RecordedEmission[];
  /**
   * Drive a server→client event to every listener registered for `event`.
   * Returns the number of listeners notified.
   */
  emitServerEvent(event: string, ...args: unknown[]): number;
  /** Override the ack value returned for a given client event. */
  setAck(event: string, ack: unknown): void;
  /** Toggle `socket.connected` and fire the matching connect/disconnect event. */
  setConnected(connected: boolean): void;
  /** Clear recorded emissions, ack overrides, and listeners. */
  reset(): void;
}

export interface MockSocketOptions {
  /** Initial `connected` state (default `true`). */
  connected?: boolean;
  /** Default ack value per client event (default `{ success: true }` each). */
  acks?: Record<string, unknown>;
}

/**
 * Build a standalone mock Socket.IO socket plus a controller to drive it. Use
 * this directly when you hold the `SocketLike` yourself; use
 * {@link createSocketIoMock} when the code under test obtains its socket through
 * `createSocket()` / `io()`.
 */
export function createMockSocket(options: MockSocketOptions = {}): MockSocketController {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emissions: RecordedEmission[] = [];
  const acks: Record<string, unknown> = { ...(options.acks ?? {}) };
  let connected = options.connected ?? true;

  const addListener = (event: string, fn: (...args: unknown[]) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
  };

  const socket: SocketLike = {
    get connected() {
      return connected;
    },
    id: 'mock-socket',
    emit(event: string, ...args: unknown[]) {
      const last = args[args.length - 1];
      const hadAck = typeof last === 'function';
      const positional = hadAck ? args.slice(0, -1) : args;
      emissions.push({ event, args: positional, hadAck });
      if (hadAck) {
        const ack = event in acks ? acks[event] : { success: true };
        (last as (a: unknown) => void)(ack);
      }
      return socket;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      addListener(event, listener);
      return socket;
    },
    off(event: string, listener?: (...args: unknown[]) => void) {
      if (!listener) listeners.delete(event);
      else listeners.get(event)?.delete(listener);
      return socket;
    },
    connect() {
      controller.setConnected(true);
      return socket;
    },
    disconnect() {
      controller.setConnected(false);
      return socket;
    },
  };

  const controller: MockSocketController = {
    socket,
    emissions,
    emitServerEvent(event, ...args) {
      const set = listeners.get(event);
      if (!set) return 0;
      // Snapshot so a listener that (un)subscribes during dispatch is safe.
      for (const fn of [...set]) fn(...args);
      return set.size;
    },
    setAck(event, ack) {
      acks[event] = ack;
    },
    setConnected(next) {
      connected = next;
      controller.emitServerEvent(next ? 'connect' : 'disconnect');
    },
    reset() {
      emissions.length = 0;
      listeners.clear();
      for (const k of Object.keys(acks)) delete acks[k];
      if (options.acks) Object.assign(acks, options.acks);
    },
  };

  return controller;
}

/** Shape returned by {@link createSocketIoMock} — the mocked `socket.io-client` module. */
export interface MockSocketIoModule {
  __esModule: true;
  io: (...args: unknown[]) => SocketLike;
  default: (...args: unknown[]) => SocketLike;
  /** The controller backing the single socket `io()` hands out. */
  __controller: MockSocketController;
}

/**
 * Build a virtual `socket.io-client` replacement whose `io()` returns a single
 * mock socket, exposing the driving controller as `__controller`. Designed to
 * be the factory for `jest.mock('socket.io-client', () => …, { virtual: true })`.
 * Read the controller back in tests via `jest.requireMock('socket.io-client')`.
 */
export function createSocketIoMock(options: MockSocketOptions = {}): MockSocketIoModule {
  const controller = createMockSocket(options);
  const io = (..._args: unknown[]) => controller.socket;
  return { __esModule: true, io, default: io, __controller: controller };
}
