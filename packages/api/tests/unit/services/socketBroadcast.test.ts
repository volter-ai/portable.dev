/**
 * socketBroadcast (portable.dev#13) — per-socket broadcast fan-out.
 *
 * The regression: room/namespace broadcasts (`io.to(room).emit`, `io.emit`)
 * bypass each socket's `.packet()`, which is where the E2E seal lives — so a
 * broadcast reached an E2E client as plaintext and was dropped, silently losing
 * the live chat stream + metrics. `emitToRoom`/`emitToAllSockets` fan out per
 * socket via `socket.emit`, which funnels through the sealed `.packet()`.
 *
 * These tests model socket.io's semantics faithfully enough to prove BOTH the
 * targeting (room membership) AND the crucial property: a fanned-out broadcast
 * is E2E-SEALED (goes through the `installServerSocketE2e` override), openable
 * only by the client's s2c key.
 */
import { describe, expect, it } from 'bun:test';
import crypto from 'crypto';

import {
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  openFrameArgs,
  respondToHandshake,
  type E2eSessionKeys,
} from '@vgit2/shared/e2e';

import { installServerSocketE2e } from '../../../src/services/socketE2e.js';
import { emitToAllSockets, emitToRoom } from '../../../src/services/socketBroadcast.js';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));

/**
 * Fake socket that mirrors socket.io's real `Socket.emit` → `this.packet(...)`
 * funnel, so `installServerSocketE2e`'s `.packet()` override is exercised exactly
 * as it is in production when a per-socket emit fires.
 */
function makeFakeSocket(id: string, rooms: string[]) {
  const outbound: Array<{ type: number; data?: unknown[] }> = [];
  const socket = {
    id,
    rooms: new Set<string>([id, ...rooms]),
    data: {} as Record<string, unknown>,
    use(_fn: (packet: unknown[], next: (err?: Error) => void) => void) {
      // inbound middleware — unused here
    },
    packet(pkt: { type: number; data?: unknown[] }) {
      outbound.push(pkt);
    },
    emit(event: string, ...args: unknown[]) {
      // socket.io's Socket.emit funnels through this.packet (EVENT = type 2).
      (this as unknown as { packet: (p: unknown) => void }).packet({
        type: 2,
        data: [event, ...args],
      });
      return true;
    },
  };
  return { socket, outbound };
}

function makeIo(sockets: Array<ReturnType<typeof makeFakeSocket>['socket']>) {
  const map = new Map<string, unknown>();
  for (const s of sockets) map.set(s.id, s);
  return { sockets: { sockets: map } } as never;
}

function keys(): { server: E2eSessionKeys; client: E2eSessionKeys } {
  const psk = generatePsk(random);
  const init = createHandshakeInit(psk, random);
  const server = respondToHandshake(psk, init.message, random);
  const client = completeHandshake(psk, init.state, server.message);
  return { server: server.keys, client: client.keys };
}

describe('emitToRoom', () => {
  it('emits only to sockets joined to the room', () => {
    const inRoom = makeFakeSocket('a', ['chat-1']);
    const outOfRoom = makeFakeSocket('b', ['chat-2']);
    const io = makeIo([inRoom.socket, outOfRoom.socket]);

    emitToRoom(io, 'chat-1', 'claude:stream', { block: 'x' });

    expect(inRoom.outbound).toHaveLength(1);
    expect(inRoom.outbound[0].data![0]).toBe('claude:stream');
    expect(outOfRoom.outbound).toHaveLength(0);
  });

  it('seals the broadcast so ONLY the client s2c key opens it (the fix)', () => {
    const k = keys();
    const member = makeFakeSocket('a', ['chat-1']);
    installServerSocketE2e(member.socket as never, k.server);
    const io = makeIo([member.socket]);

    emitToRoom(io, 'chat-1', 'claude:stream', { block: 'streamed-secret' });

    const sent = member.outbound[0];
    expect(sent.type).toBe(2);
    expect(sent.data![0]).toBe('claude:stream'); // event name stays visible
    // Payload is sealed — plaintext must not appear on the wire...
    expect(JSON.stringify(sent.data)).not.toContain('streamed-secret');
    // ...and the client opens it with s2c back to the original args.
    expect(openFrameArgs(k.client.s2c, sent.data!.slice(1))).toEqual([
      { block: 'streamed-secret' },
    ]);
  });
});

describe('emitToAllSockets', () => {
  it('emits to every connected socket, per-socket (sealed)', () => {
    const k = keys();
    const s1 = makeFakeSocket('a', []);
    const s2 = makeFakeSocket('b', []);
    installServerSocketE2e(s1.socket as never, k.server);
    installServerSocketE2e(s2.socket as never, k.server);
    const io = makeIo([s1.socket, s2.socket]);

    emitToAllSockets(io, 'sandbox:metrics', { cpuUsagePercent: 42 });

    for (const s of [s1, s2]) {
      expect(s.outbound).toHaveLength(1);
      expect(s.outbound[0].data![0]).toBe('sandbox:metrics');
      expect(JSON.stringify(s.outbound[0].data)).not.toContain('42');
      expect(openFrameArgs(k.client.s2c, s.outbound[0].data!.slice(1))).toEqual([
        { cpuUsagePercent: 42 },
      ]);
    }
  });
});
