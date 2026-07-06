/**
 * Server-side Socket.IO E2E frame encryption (portable.dev#13).
 *
 * Installs, on a single connected socket, the two interception points that
 * together encrypt EVERY frame in both directions with the socket's E2E
 * session keys — WITHOUT touching the ~15 scattered `io.emit` / `socket.emit`
 * call sites:
 *
 *   - OUTBOUND: override `socket.packet` (the low-level method a per-socket
 *     `socket.emit` funnels through) to seal EVENT/ACK payloads with `s2c`.
 *   - INBOUND: `socket.use` middleware opens the client's `c2s`-sealed payloads
 *     before any handler runs; an undecryptable frame is rejected.
 *
 * Event NAMES stay in the clear (the adapter routes on them); only payloads are
 * sealed. Reserved lifecycle events pass through untouched.
 *
 * ⚠️ This seals ONLY per-socket emits (`socket.emit`). socket.io room/namespace
 * BROADCASTS (`io.to(room).emit`, `io.emit`) bypass `socket.packet` entirely —
 * the adapter encodes once and writes straight to each client's engine — so a
 * broadcast escapes the seal and an E2E client drops it as unsealed. Every
 * client-facing broadcast MUST fan out per-socket via `socketBroadcast.ts`.
 */
import crypto from 'crypto';

import {
  isReservedSocketEvent,
  openFrameArgs,
  sealFrameArgs,
  type E2eSessionKeys,
} from '@vgit2/shared/e2e';

import type { Socket } from 'socket.io';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));

// socket.io-parser PacketType numeric values.
const EVENT = 2;
const ACK = 3;
const BINARY_EVENT = 5;
const BINARY_ACK = 6;

interface OutboundPacket {
  type: number;
  data?: unknown[];
  [k: string]: unknown;
}

/**
 * Encrypt all traffic on `socket` with `keys`. Idempotent-safe to call once per
 * connection right after the handshake resolves the session.
 */
export function installServerSocketE2e(socket: Socket, keys: E2eSessionKeys): void {
  // ── INBOUND: decrypt the client's c2s-sealed payloads before handlers run ──
  socket.use((packet: unknown[], next: (err?: Error) => void) => {
    const event = packet[0];
    if (typeof event !== 'string' || isReservedSocketEvent(event)) {
      next();
      return;
    }
    // socket.io appends the ack callback to the args array BEFORE middleware
    // runs (for an emit-with-ack), so peel a trailing function off and preserve
    // it — only the sealed data args get decrypted.
    let ackFn: unknown;
    let dataArgs = packet.slice(1);
    if (dataArgs.length > 0 && typeof dataArgs[dataArgs.length - 1] === 'function') {
      ackFn = dataArgs[dataArgs.length - 1];
      dataArgs = dataArgs.slice(0, -1);
    }
    try {
      const opened = openFrameArgs(keys.c2s, dataArgs);
      packet.length = 1;
      for (const arg of opened) packet.push(arg);
      if (ackFn) packet.push(ackFn);
      next();
    } catch {
      // Reject an unsealed/undecryptable inbound frame (relay forgery / bug).
      next(new Error('E2E frame decrypt failed'));
    }
  });

  // ── OUTBOUND: seal EVENT/ACK payloads with s2c at the packet chokepoint ─────
  const socketWithPacket = socket as unknown as {
    packet: (packet: OutboundPacket, opts?: unknown) => void;
  };
  const originalPacket = socketWithPacket.packet.bind(socket);
  socketWithPacket.packet = (packet: OutboundPacket, opts?: unknown) => {
    try {
      if (packet && Array.isArray(packet.data)) {
        if (packet.type === EVENT || packet.type === BINARY_EVENT) {
          const [event, ...args] = packet.data;
          if (typeof event === 'string' && !isReservedSocketEvent(event)) {
            packet.data = [event, ...sealFrameArgs(keys.s2c, args, random)];
            packet.type = EVENT; // sealed payload is pure JSON — never binary
          }
        } else if (packet.type === ACK || packet.type === BINARY_ACK) {
          packet.data = sealFrameArgs(keys.s2c, packet.data, random);
          packet.type = ACK;
        }
      }
    } catch {
      // Never break the socket on a seal failure — fall through unmodified.
    }
    originalPacket(packet, opts);
  };
}
