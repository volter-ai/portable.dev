/**
 * Tests for the @vgit2/shared/e2e crypto core (portable.dev#13).
 *
 * Covers the three primitives the E2E transport layers build on:
 *  - the AEAD envelope (XChaCha20-Poly1305, random 24-byte nonce)
 *  - the PSK-authenticated X25519 handshake (forward secrecy)
 *  - HKDF-derived directional session keys
 *
 * Randomness is injected everywhere (Hermes has no global crypto), so tests
 * use both real randomness and deterministic stubs.
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';

import {
  E2E_PSK_BYTES,
  E2eAuthError,
  E2eDecryptError,
  completeHandshake,
  createHandshakeInit,
  decodeBase64,
  encodeBase64,
  generatePsk,
  isReservedSocketEvent,
  openEnvelope,
  openFrameArgs,
  respondToHandshake,
  sealEnvelope,
  sealFrameArgs,
} from '../src/e2e/index.js';

const random = (n: number): Uint8Array => new Uint8Array(crypto.randomBytes(n));

/** Run a full handshake between a "phone" and a "pc" sharing `psk`. */
function pairedSessions(psk: Uint8Array) {
  const init = createHandshakeInit(psk, random);
  const server = respondToHandshake(psk, init.message, random);
  const client = completeHandshake(psk, init.state, server.message);
  return { client, server };
}

describe('base64 codec (RN-safe, no Buffer/atob)', () => {
  test('round-trips arbitrary bytes including all byte values', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  test('matches Node Buffer base64 output', () => {
    const bytes = new Uint8Array(crypto.randomBytes(97));
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  test('handles empty input', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('');
    expect(decodeBase64('')).toEqual(new Uint8Array(0));
  });
});

describe('generatePsk', () => {
  test('produces 32 bytes from the injected randomness', () => {
    const psk = generatePsk(random);
    expect(psk.length).toBe(E2E_PSK_BYTES);
    expect(E2E_PSK_BYTES).toBe(32);
  });

  test('two generations differ', () => {
    expect(generatePsk(random)).not.toEqual(generatePsk(random));
  });
});

describe('envelope seal/open', () => {
  const key = new Uint8Array(crypto.randomBytes(32));

  test('round-trips plaintext', () => {
    const plaintext = new TextEncoder().encode('{"method":"POST","path":"/api/chats"}');
    const env = sealEnvelope(key, plaintext, random);
    expect(env.v).toBe(1);
    expect(openEnvelope(key, env)).toEqual(plaintext);
  });

  test('each seal uses a fresh nonce → distinct ciphertexts for same plaintext', () => {
    const plaintext = new TextEncoder().encode('same');
    const a = sealEnvelope(key, plaintext, random);
    const b = sealEnvelope(key, plaintext, random);
    expect(a.n).not.toBe(b.n);
    expect(a.ct).not.toBe(b.ct);
  });

  test('wrong key fails with E2eDecryptError', () => {
    const env = sealEnvelope(key, new TextEncoder().encode('secret'), random);
    const wrongKey = new Uint8Array(crypto.randomBytes(32));
    expect(() => openEnvelope(wrongKey, env)).toThrow(E2eDecryptError);
  });

  test('tampered ciphertext fails with E2eDecryptError', () => {
    const env = sealEnvelope(key, new TextEncoder().encode('secret'), random);
    const ct = decodeBase64(env.ct);
    ct[0] ^= 0xff;
    expect(() => openEnvelope(key, { ...env, ct: encodeBase64(ct) })).toThrow(E2eDecryptError);
  });

  test('AAD binds context: mismatched AAD fails, matching AAD succeeds', () => {
    const plaintext = new TextEncoder().encode('bound');
    const aad = new TextEncoder().encode('session-123');
    const env = sealEnvelope(key, plaintext, random, aad);
    expect(openEnvelope(key, env, aad)).toEqual(plaintext);
    expect(() => openEnvelope(key, env, new TextEncoder().encode('session-999'))).toThrow(
      E2eDecryptError
    );
    expect(() => openEnvelope(key, env)).toThrow(E2eDecryptError);
  });
});

describe('socket frame codec', () => {
  const psk = generatePsk(random);

  function pair() {
    const init = createHandshakeInit(psk, random);
    const server = respondToHandshake(psk, init.message, random);
    const client = completeHandshake(psk, init.state, server.message);
    return { client, server };
  }

  test('client→server single-payload frame round-trips via c2s', () => {
    const { client, server } = pair();
    const wire = sealFrameArgs(client.keys.c2s, [{ chatId: 'c1', text: 'secret' }], random);
    expect(openFrameArgs(server.keys.c2s, wire)).toEqual([{ chatId: 'c1', text: 'secret' }]);
  });

  test('server→client frame round-trips via s2c (streaming direction)', () => {
    const { client, server } = pair();
    const wire = sealFrameArgs(server.keys.s2c, ['claude:stream', { block: 'x' }], random);
    expect(openFrameArgs(client.keys.s2c, wire)).toEqual(['claude:stream', { block: 'x' }]);
  });

  test('empty arg list (fire-and-forget, no payload) round-trips', () => {
    const { client, server } = pair();
    expect(openFrameArgs(server.keys.c2s, sealFrameArgs(client.keys.c2s, [], random))).toEqual([]);
  });

  test('the payload is not readable on the wire', () => {
    const { client } = pair();
    const wire = sealFrameArgs(client.keys.c2s, [{ text: 'topsecret' }], random);
    expect(JSON.stringify(wire)).not.toContain('topsecret');
  });

  test('a tampered frame fails to open', () => {
    const { client, server } = pair();
    const wire = sealFrameArgs(client.keys.c2s, [{ text: 'x' }], random);
    wire[0].__e2e.ct = encodeBase64(new Uint8Array([1, 2, 3]));
    expect(() => openFrameArgs(server.keys.c2s, wire)).toThrow();
  });

  test('a non-sealed frame is rejected (no plaintext passthrough)', () => {
    const { server } = pair();
    expect(() => openFrameArgs(server.keys.c2s, [{ plain: 'nope' }])).toThrow();
  });

  test('reserved lifecycle events are flagged', () => {
    expect(isReservedSocketEvent('connect')).toBe(true);
    expect(isReservedSocketEvent('disconnect')).toBe(true);
    expect(isReservedSocketEvent('chat:message')).toBe(false);
  });
});

describe('handshake', () => {
  const psk = generatePsk(random);

  test('both sides derive the same session id and directional keys', () => {
    const { client, server } = pairedSessions(psk);
    expect(client.sessionId).toBe(server.sessionId);
    expect(client.keys.c2s).toEqual(server.keys.c2s);
    expect(client.keys.s2c).toEqual(server.keys.s2c);
    // Directional keys must differ from each other.
    expect(client.keys.c2s).not.toEqual(client.keys.s2c);
    expect(client.keys.c2s.length).toBe(32);
    expect(client.keys.s2c.length).toBe(32);
    expect(client.sessionId.length).toBeGreaterThanOrEqual(16);
  });

  test('client→server traffic encrypts under c2s and decrypts server-side', () => {
    const { client, server } = pairedSessions(psk);
    const msg = new TextEncoder().encode('hello pc');
    const env = sealEnvelope(client.keys.c2s, msg, random);
    expect(openEnvelope(server.keys.c2s, env)).toEqual(msg);
  });

  test('two handshakes with the same PSK yield different session keys (forward secrecy)', () => {
    const a = pairedSessions(psk);
    const b = pairedSessions(psk);
    expect(a.client.sessionId).not.toBe(b.client.sessionId);
    expect(a.client.keys.c2s).not.toEqual(b.client.keys.c2s);
    expect(a.client.keys.s2c).not.toEqual(b.client.keys.s2c);
  });

  test('responder rejects an init from a party without the PSK', () => {
    const attacker = createHandshakeInit(generatePsk(random), random);
    expect(() => respondToHandshake(psk, attacker.message, random)).toThrow(E2eAuthError);
  });

  test('responder rejects a tampered init message', () => {
    const init = createHandshakeInit(psk, random);
    const pub = decodeBase64(init.message.pub);
    pub[3] ^= 0x01;
    expect(() =>
      respondToHandshake(psk, { ...init.message, pub: encodeBase64(pub) }, random)
    ).toThrow(E2eAuthError);
  });

  test('initiator rejects a response forged without the PSK (MITM relay)', () => {
    const init = createHandshakeInit(psk, random);
    // A relay that intercepted the init but lacks the PSK responds with its own key
    // (it can only produce MACs under a PSK it invents itself).
    const attackerPsk = generatePsk(random);
    const forged = respondToHandshake(
      attackerPsk,
      createHandshakeInit(attackerPsk, random).message,
      random
    );
    expect(() => completeHandshake(psk, init.state, forged.message)).toThrow(E2eAuthError);
  });

  test('initiator rejects a replayed response from a different handshake', () => {
    const initA = createHandshakeInit(psk, random);
    const initB = createHandshakeInit(psk, random);
    const serverForB = respondToHandshake(psk, initB.message, random);
    // Response transcript is bound to init B; init A must reject it.
    expect(() => completeHandshake(psk, initA.state, serverForB.message)).toThrow(E2eAuthError);
  });

  test('handshake messages are JSON-serializable (they cross the wire)', () => {
    const init = createHandshakeInit(psk, random);
    const roundTripped = JSON.parse(JSON.stringify(init.message));
    const server = respondToHandshake(psk, roundTripped, random);
    const client = completeHandshake(psk, init.state, JSON.parse(JSON.stringify(server.message)));
    expect(client.sessionId).toBe(server.sessionId);
  });
});
