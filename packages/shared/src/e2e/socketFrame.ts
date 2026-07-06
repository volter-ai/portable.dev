/**
 * E2E Socket.IO frame codec (portable.dev#13).
 *
 * Socket.IO carries the live chat stream. To keep the event NAME visible (the
 * relay/adapter routes on it) while hiding the PAYLOAD, each frame's argument
 * list is sealed as ONE AEAD envelope: the wire args become `[{ __e2e: env }]`.
 * Acks are argument lists too, so the same pair covers emits AND ack callbacks.
 *
 * Directional keys (from the handshake): the client seals with `c2s` / opens
 * with `s2c`; the PC seals with `s2c` / opens with `c2s`.
 *
 * Reserved socket.io lifecycle events (connect/disconnect/…) carry no app
 * payload and MUST NOT be wrapped — {@link isReservedSocketEvent} gates them.
 */
import { openEnvelope, sealEnvelope, type E2eEnvelope, type RandomBytes } from './envelope.js';

/** Wire shape of a sealed frame's single argument. */
export interface E2eFrameEnvelope {
  __e2e: E2eEnvelope;
}

/** socket.io lifecycle events that must pass through unencrypted. */
const RESERVED_SOCKET_EVENTS = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
  'error',
]);

/** True for a socket.io lifecycle event that must not be wrapped. */
export function isReservedSocketEvent(event: string): boolean {
  return RESERVED_SOCKET_EVENTS.has(event);
}

/** True when `arg` is an already-sealed frame envelope. */
export function isFrameEnvelope(arg: unknown): arg is E2eFrameEnvelope {
  return (
    typeof arg === 'object' &&
    arg !== null &&
    typeof (arg as E2eFrameEnvelope).__e2e === 'object' &&
    (arg as E2eFrameEnvelope).__e2e !== null
  );
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Seal an argument list into the single-envelope wire form `[{ __e2e }]`.
 * `undefined` entries are preserved via JSON (they serialize to null), so a
 * fire-and-forget `emit(event)` with no payload round-trips as `[]`.
 */
export function sealFrameArgs(
  key: Uint8Array,
  args: unknown[],
  random: RandomBytes
): [E2eFrameEnvelope] {
  const plaintext = textEncoder.encode(JSON.stringify(args ?? []));
  return [{ __e2e: sealEnvelope(key, plaintext, random) }];
}

/**
 * Open a sealed wire arg list back to the original argument array. Throws
 * {@link E2eDecryptError} (from openEnvelope) on tampering/wrong key.
 */
export function openFrameArgs(key: Uint8Array, wireArgs: unknown[]): unknown[] {
  const first = wireArgs[0];
  if (!isFrameEnvelope(first)) {
    // Not an E2E frame — a protocol violation once E2E is active. Surfacing the
    // raw args would leak plaintext expectations, so treat as empty.
    throw new Error('socket frame is not E2E-sealed');
  }
  const plaintext = openEnvelope(key, first.__e2e);
  const parsed = JSON.parse(textDecoder.decode(plaintext));
  return Array.isArray(parsed) ? parsed : [parsed];
}
