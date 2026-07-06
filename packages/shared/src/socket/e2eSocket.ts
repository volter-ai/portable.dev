/**
 * Client-side Socket.IO E2E wrapper (portable.dev#13).
 *
 * Wraps a real socket in a Proxy that seals every outbound event payload (and
 * unwraps ack replies) with `c2s` and opens every inbound event payload with
 * `s2c`. ONLY `emit`, `on`, and `once` are intercepted; every other property
 * (`.io` manager for reconnection, `.connect`, `.disconnect`, `.connected`,
 * `.id`, …) passes straight through to the real socket, so the reconnect /
 * health machinery keeps working untouched. Reserved lifecycle events are not
 * encrypted.
 *
 * Because it presents the SAME surface, all existing call sites (the
 * `emitWithAck`/`emitFireAndForget` funnels, `bindHandlers` `on`) go through
 * encryption transparently — no per-call-site change.
 */
import {
  isReservedSocketEvent,
  openFrameArgs,
  sealFrameArgs,
  type E2eSessionKeys,
  type RandomBytes,
} from '../e2e/index.js';

import type { SocketLike } from './createSocket.js';

type Listener = (...args: unknown[]) => void;

/** Wrap `on`/`once` so inbound payloads are opened before the handler sees them. */
function wrapOn(original: (event: string, listener: Listener) => unknown, keys: E2eSessionKeys) {
  return (event: string, listener: Listener): unknown => {
    if (isReservedSocketEvent(event)) return original(event, listener);
    return original(event, (...wireArgs: unknown[]) => {
      // A trailing function is a server-initiated ack callback — preserve it.
      let ackFn: unknown;
      let payloadWire = wireArgs;
      if (wireArgs.length > 0 && typeof wireArgs[wireArgs.length - 1] === 'function') {
        ackFn = wireArgs[wireArgs.length - 1];
        payloadWire = wireArgs.slice(0, -1);
      }
      try {
        const opened = openFrameArgs(keys.s2c, payloadWire);
        if (ackFn) listener(...opened, ackFn);
        else listener(...opened);
      } catch {
        // Drop an undecryptable/unsealed frame rather than surface plaintext.
      }
    });
  };
}

export function wrapSocketE2e<T extends SocketLike>(
  socket: T,
  keys: E2eSessionKeys,
  random: RandomBytes
): T {
  const emit = (event: string, ...args: unknown[]): unknown => {
    if (isReservedSocketEvent(event)) return socket.emit(event, ...args);
    // Peel a trailing ack callback (emit-with-ack) off the data args.
    let ack: Listener | undefined;
    let data = args;
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      ack = args[args.length - 1] as Listener;
      data = args.slice(0, -1);
    }
    const sealed = sealFrameArgs(keys.c2s, data, random);
    if (ack) {
      const wrappedAck = (...ackArgs: unknown[]) => {
        try {
          ack!(...openFrameArgs(keys.s2c, ackArgs));
        } catch {
          ack!();
        }
      };
      return socket.emit(event, ...sealed, wrappedAck);
    }
    return socket.emit(event, ...sealed);
  };

  const onWrapped = wrapOn((e, l) => socket.on(e, l), keys);
  const socketWithOnce = socket as SocketLike & {
    once?: (event: string, listener: Listener) => unknown;
  };
  const onceWrapped = socketWithOnce.once
    ? wrapOn((e, l) => socketWithOnce.once!(e, l), keys)
    : undefined;

  return new Proxy(socket, {
    get(target, prop, receiver) {
      if (prop === 'emit') return emit;
      if (prop === 'on') return onWrapped;
      if (prop === 'once' && onceWrapped) return onceWrapped;
      const value = Reflect.get(target, prop, receiver);
      // Bind plain methods to the real socket so `this` stays correct.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}
