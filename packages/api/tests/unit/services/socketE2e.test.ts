/**
 * installServerSocketE2e (portable.dev#13) — server-side socket frame glue.
 *
 * Real socket.io wire delivery under Bun is a device-deferred smoke; this tests
 * the two interception points deterministically against a faithful fake socket
 * that models socket.io's semantics:
 *   - INBOUND: `socket.use` receives `[event, ...args]`, and for an emit-with-ack
 *     socket.io has ALREADY appended the ack fn to that array before middleware.
 *   - OUTBOUND: `socket.packet({type, data})` is the chokepoint every emit /
 *     broadcast funnels through.
 *
 * The client counterpart (`wrapSocketE2e`) is covered in the shared suite; the
 * envelope crypto in `packages/shared/tests/e2e-crypto.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import crypto from 'crypto';

import {
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  openFrameArgs,
  respondToHandshake,
  sealFrameArgs,
  type E2eSessionKeys,
} from '@vgit2/shared/e2e';

import { installServerSocketE2e } from '../../../src/services/socketE2e.js';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));

/** Faithful-enough fake of the socket.io Socket surface the installer touches. */
function makeFakeSocket() {
  let useFn: ((packet: unknown[], next: (err?: Error) => void) => void) | undefined;
  const outbound: Array<{ type: number; data?: unknown[] }> = [];
  const socket = {
    use(fn: (packet: unknown[], next: (err?: Error) => void) => void) {
      useFn = fn;
    },
    // The ORIGINAL packet, captured post-override so we can inspect sealed frames.
    packet(pkt: { type: number; data?: unknown[] }) {
      outbound.push(pkt);
    },
  };
  return {
    socket,
    outbound,
    runInbound: (packet: unknown[]) =>
      new Promise<{ packet: unknown[]; error?: Error }>((resolve) => {
        useFn!(packet, (error?: Error) => resolve({ packet, error }));
      }),
  };
}

function keys(): { server: E2eSessionKeys; client: E2eSessionKeys } {
  const psk = generatePsk(random);
  const init = createHandshakeInit(psk, random);
  const server = respondToHandshake(psk, init.message, random);
  const client = completeHandshake(psk, init.state, server.message);
  return { server: server.keys, client: client.keys };
}

describe('installServerSocketE2e — inbound decrypt (socket.use)', () => {
  it('decrypts a client c2s-sealed payload in place', async () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    const sealed = sealFrameArgs(k.client.c2s, [{ text: 'secret' }], random);
    const { packet, error } = await fake.runInbound(['chat:message', ...sealed]);
    expect(error).toBeUndefined();
    expect(packet).toEqual(['chat:message', { text: 'secret' }]);
  });

  it('preserves a trailing ack fn (socket.io appends it before middleware)', async () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    const ack = () => {};
    const sealed = sealFrameArgs(k.client.c2s, [{ text: 'secret' }], random);
    const { packet, error } = await fake.runInbound(['chat:message', ...sealed, ack]);
    expect(error).toBeUndefined();
    expect(packet[0]).toBe('chat:message');
    expect(packet[1]).toEqual({ text: 'secret' });
    expect(packet[2]).toBe(ack); // ack survived decryption
  });

  it('rejects an unsealed (plaintext) inbound frame — hard cutover', async () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    const { error } = await fake.runInbound(['chat:message', { text: 'plaintext' }]);
    expect(error).toBeInstanceOf(Error);
  });

  it('passes reserved lifecycle events through untouched', async () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    const { packet, error } = await fake.runInbound(['disconnect', 'transport close']);
    expect(error).toBeUndefined();
    expect(packet).toEqual(['disconnect', 'transport close']);
  });
});

describe('installServerSocketE2e — outbound seal (socket.packet override)', () => {
  it('seals an EVENT payload with s2c (readable only by the client)', () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    (fake.socket as unknown as { packet: (p: unknown) => void }).packet({
      type: 2,
      data: ['claude:stream', { block: 'streamed-secret' }],
    });

    const sent = fake.outbound[0];
    expect(sent.type).toBe(2);
    expect(sent.data![0]).toBe('claude:stream'); // event name visible
    // The client opens it with s2c back to the original args.
    expect(openFrameArgs(k.client.s2c, sent.data!.slice(1))).toEqual([
      { block: 'streamed-secret' },
    ]);
    expect(JSON.stringify(sent.data)).not.toContain('streamed-secret');
  });

  it('seals an ACK payload with s2c', () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    (fake.socket as unknown as { packet: (p: unknown) => void }).packet({
      type: 3,
      data: [{ ok: true, secret: 'ackbody' }],
    });

    const sent = fake.outbound[0];
    expect(sent.type).toBe(3);
    expect(openFrameArgs(k.client.s2c, sent.data!)).toEqual([{ ok: true, secret: 'ackbody' }]);
    expect(JSON.stringify(sent.data)).not.toContain('ackbody');
  });

  it('does not seal reserved-event packets', () => {
    const k = keys();
    const fake = makeFakeSocket();
    installServerSocketE2e(fake.socket as never, k.server);

    (fake.socket as unknown as { packet: (p: unknown) => void }).packet({
      type: 2,
      data: ['disconnect', 'io server disconnect'],
    });
    expect(fake.outbound[0].data).toEqual(['disconnect', 'io server disconnect']);
  });
});
