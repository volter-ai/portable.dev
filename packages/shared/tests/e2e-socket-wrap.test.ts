/**
 * wrapSocketE2e (portable.dev#13) — client-side socket frame wrapper.
 *
 * Pairs the client wrapper with the SAME transformation the server installer
 * applies, using a fake in-process socket, to prove emit payloads, ack replies,
 * and inbound (server→client) frames round-trip through the envelope and that
 * pass-through properties (`.io`, `.connect`, …) survive the Proxy.
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';

import {
  completeHandshake,
  createHandshakeInit,
  generatePsk,
  openFrameArgs,
  respondToHandshake,
  sealFrameArgs,
  type E2eSessionKeys,
} from '../src/e2e/index.js';
import { wrapSocketE2e } from '../src/socket/e2eSocket.js';
import type { SocketLike } from '../src/socket/createSocket.js';

const random = (n: number): Uint8Array => new Uint8Array(crypto.randomBytes(n));

function keys(): { server: E2eSessionKeys; client: E2eSessionKeys } {
  const psk = generatePsk(random);
  const init = createHandshakeInit(psk, random);
  const server = respondToHandshake(psk, init.message, random);
  const client = completeHandshake(psk, init.state, server.message);
  return { server: server.keys, client: client.keys };
}

/** A fake socket recording emits + letting a test drive inbound events. */
function makeFakeSocket() {
  const emissions: Array<{ event: string; args: unknown[] }> = [];
  const listeners = new Map<string, (...a: unknown[]) => void>();
  const socket = {
    connected: true,
    id: 'fake-1',
    io: { engine: 'manager-passthrough' }, // must survive the Proxy
    emit(event: string, ...args: unknown[]) {
      emissions.push({ event, args });
      return true;
    },
    on(event: string, listener: (...a: unknown[]) => void) {
      listeners.set(event, listener);
      return this;
    },
    connect() {
      return 'connected';
    },
  } as unknown as SocketLike & { io: unknown };
  return {
    socket,
    emissions,
    deliver: (event: string, ...wireArgs: unknown[]) => listeners.get(event)?.(...wireArgs),
  };
}

describe('wrapSocketE2e', () => {
  test('seals an outbound fire-and-forget payload with c2s', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random);

    wrapped.emit('chat:message', { text: 'secret' });
    const sent = fake.emissions[0];
    expect(sent.event).toBe('chat:message');
    expect(openFrameArgs(k.server.c2s, sent.args)).toEqual([{ text: 'secret' }]);
    expect(JSON.stringify(sent.args)).not.toContain('secret');
  });

  test('seals the data + wraps the ack of an emit-with-ack (opens the s2c reply)', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random);

    let acked: unknown;
    wrapped.emit('chat:message', { text: 'q' }, (r: unknown) => {
      acked = r;
    });
    const sent = fake.emissions[0];
    // Last emitted arg is the wrapped ack fn; the rest is the sealed data.
    const wireAck = sent.args[sent.args.length - 1] as (...a: unknown[]) => void;
    const sealedData = sent.args.slice(0, -1);
    expect(openFrameArgs(k.server.c2s, sealedData)).toEqual([{ text: 'q' }]);

    // Server replies by sealing the ack with s2c; the wrapped ack opens it.
    wireAck(...sealFrameArgs(k.server.s2c, [{ ok: true }], random));
    expect(acked).toEqual({ ok: true });
  });

  test('opens an inbound server→client frame with s2c', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random);

    let got: unknown;
    wrapped.on('claude:stream', (payload: unknown) => {
      got = payload;
    });
    fake.deliver('claude:stream', ...sealFrameArgs(k.server.s2c, [{ block: 'streamed' }], random));
    expect(got).toEqual({ block: 'streamed' });
  });

  test('drops an inbound frame that is not sealed (no plaintext passthrough)', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random);

    let called = false;
    wrapped.on('claude:stream', () => {
      called = true;
    });
    fake.deliver('claude:stream', { block: 'plaintext' });
    expect(called).toBe(false);
  });

  test('reserved events pass through unencrypted', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random);

    let connected = false;
    wrapped.on('connect', () => {
      connected = true;
    });
    fake.deliver('connect');
    expect(connected).toBe(true);

    wrapped.emit('disconnect');
    expect(fake.emissions[0]).toEqual({ event: 'disconnect', args: [] });
  });

  test('pass-through properties (.io, .connected, methods) survive the Proxy', () => {
    const k = keys();
    const fake = makeFakeSocket();
    const wrapped = wrapSocketE2e(fake.socket, k.client, random) as SocketLike & { io: unknown };
    expect(wrapped.connected).toBe(true);
    expect(wrapped.id).toBe('fake-1');
    expect(wrapped.io).toEqual({ engine: 'manager-passthrough' });
    expect((wrapped as unknown as { connect: () => string }).connect()).toBe('connected');
  });
});
