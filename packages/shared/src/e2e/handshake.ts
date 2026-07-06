/**
 * PSK-authenticated X25519 handshake (portable.dev#13) — Noise-NNpsk0-style.
 *
 * Trust model: phone and PC share a 32-byte PSK delivered ONLY inside the
 * pairing QR (the one channel the relay never sees). Each session runs a fresh
 * ephemeral X25519 exchange, authenticated on BOTH legs by HMACs keyed from
 * the PSK, then HKDFs the ECDH output + PSK into directional session keys.
 *
 *   phone                                pc
 *   ─────                                ──
 *   init:  { pub: eC, mac: HMAC(kInit, eC) }        ──►  verify mac (proves PSK)
 *                                                        derive keys
 *   resp:  { pub: eS, mac: HMAC(kAuth, eC‖eS) }     ◄──  kAuth binds PSK+ECDH+transcript
 *   verify mac → derive keys
 *
 * Properties:
 *  - Mutual authentication: neither leg completes without the PSK, so the
 *    relay (which sees the JWT but not the PSK) can neither initiate nor MITM.
 *  - Forward secrecy: session keys derive from ephemeral ECDH; a later PSK
 *    leak does not decrypt recorded sessions.
 *  - Replay binding: the response MAC + all derived keys cover the FULL
 *    transcript (eC‖eS), so a response replayed against a different init fails.
 *
 * Runtime-portable like envelope.ts: injected randomness, no Buffer, pure JS.
 */
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

import { E2E_KEY_BYTES, type RandomBytes, decodeBase64, encodeBase64 } from './envelope.js';

/** PSK size (bytes) — carried in the pairing QR, never transmitted. */
export const E2E_PSK_BYTES = 32;

/** Thrown when a handshake message fails authentication. */
export class E2eAuthError extends Error {
  constructor(message = 'E2E handshake authentication failed') {
    super(message);
    this.name = 'E2eAuthError';
  }
}

/** Directional session keys (client→server and server→client). */
export interface E2eSessionKeys {
  c2s: Uint8Array;
  s2c: Uint8Array;
}

/** Wire form of the initiator's (phone's) first message. */
export interface E2eHandshakeInit {
  v: 1;
  /** Initiator ephemeral X25519 public key (base64). */
  pub: string;
  /** HMAC-SHA256(kInit, pub) proving PSK possession (base64). */
  mac: string;
}

/** Wire form of the responder's (PC's) reply. */
export interface E2eHandshakeResponse {
  v: 1;
  /** Responder ephemeral X25519 public key (base64). */
  pub: string;
  /** HMAC-SHA256(kAuth, clientPub ‖ serverPub) (base64). */
  mac: string;
}

/** Initiator's secret state kept between init and complete. */
export interface E2eHandshakeState {
  priv: Uint8Array;
  pub: Uint8Array;
}

/** A completed session: id (safe to send in the clear) + directional keys. */
export interface E2eSession {
  sessionId: string;
  keys: E2eSessionKeys;
}

const INIT_AUTH_INFO = 'portable-e2e/v1 init-auth';
const SESSION_INFO_AUTH = 'portable-e2e/v1 auth';
const SESSION_INFO_C2S = 'portable-e2e/v1 c2s';
const SESSION_INFO_S2C = 'portable-e2e/v1 s2c';
const SESSION_INFO_ID = 'portable-e2e/v1 session-id';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Constant-time byte-array comparison (MAC checks must not leak timing). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Generate a fresh 32-byte PSK from the injected CSPRNG. */
export function generatePsk(random: RandomBytes): Uint8Array {
  return random(E2E_PSK_BYTES);
}

/** Key for the init-message MAC: derived from the PSK alone (no ECDH yet). */
function initAuthKey(psk: Uint8Array): Uint8Array {
  return hkdf(sha256, psk, undefined, utf8(INIT_AUTH_INFO), E2E_KEY_BYTES);
}

/**
 * Derive everything both sides need from the PSK + ECDH secret + transcript.
 * The transcript (clientPub ‖ serverPub) salts the HKDF, so every derived
 * value — including the response-MAC key — is bound to this exact handshake.
 */
function deriveSession(
  psk: Uint8Array,
  shared: Uint8Array,
  clientPub: Uint8Array,
  serverPub: Uint8Array
): { session: E2eSession; authKey: Uint8Array } {
  const ikm = concatBytes(psk, shared);
  const salt = concatBytes(clientPub, serverPub);
  const authKey = hkdf(sha256, ikm, salt, utf8(SESSION_INFO_AUTH), E2E_KEY_BYTES);
  const c2s = hkdf(sha256, ikm, salt, utf8(SESSION_INFO_C2S), E2E_KEY_BYTES);
  const s2c = hkdf(sha256, ikm, salt, utf8(SESSION_INFO_S2C), E2E_KEY_BYTES);
  const sessionId = encodeBase64(hkdf(sha256, ikm, salt, utf8(SESSION_INFO_ID), 16))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { session: { sessionId, keys: { c2s, s2c } }, authKey };
}

/** Phone side, step 1: build the init message + the state to complete later. */
export function createHandshakeInit(
  psk: Uint8Array,
  random: RandomBytes
): { message: E2eHandshakeInit; state: E2eHandshakeState } {
  const priv = random(E2E_KEY_BYTES); // x25519 clamps internally per RFC 7748
  const pub = x25519.getPublicKey(priv);
  const mac = hmac(sha256, initAuthKey(psk), pub);
  return {
    message: { v: 1, pub: encodeBase64(pub), mac: encodeBase64(mac) },
    state: { priv, pub },
  };
}

/**
 * PC side: verify the init proves PSK possession, then answer with our
 * ephemeral key + a transcript-bound MAC, and return the derived session.
 * Throws {@link E2eAuthError} if the initiator does not hold the PSK.
 */
export function respondToHandshake(
  psk: Uint8Array,
  init: E2eHandshakeInit,
  random: RandomBytes
): { message: E2eHandshakeResponse; sessionId: string; keys: E2eSessionKeys } {
  let clientPub: Uint8Array;
  let initMac: Uint8Array;
  try {
    clientPub = decodeBase64(init.pub);
    initMac = decodeBase64(init.mac);
  } catch {
    throw new E2eAuthError('malformed handshake init');
  }
  const expectedInitMac = hmac(sha256, initAuthKey(psk), clientPub);
  if (!timingSafeEqual(initMac, expectedInitMac)) {
    throw new E2eAuthError('handshake init MAC mismatch');
  }

  const priv = random(E2E_KEY_BYTES);
  const serverPub = x25519.getPublicKey(priv);
  const shared = x25519.getSharedSecret(priv, clientPub);
  const { session, authKey } = deriveSession(psk, shared, clientPub, serverPub);
  const mac = hmac(sha256, authKey, concatBytes(clientPub, serverPub));
  return {
    message: { v: 1, pub: encodeBase64(serverPub), mac: encodeBase64(mac) },
    sessionId: session.sessionId,
    keys: session.keys,
  };
}

/**
 * Phone side, step 2: verify the responder's transcript MAC (proves it holds
 * the PSK AND is answering THIS handshake) and derive the session.
 * Throws {@link E2eAuthError} on any mismatch.
 */
export function completeHandshake(
  psk: Uint8Array,
  state: E2eHandshakeState,
  response: E2eHandshakeResponse
): E2eSession {
  let serverPub: Uint8Array;
  let respMac: Uint8Array;
  try {
    serverPub = decodeBase64(response.pub);
    respMac = decodeBase64(response.mac);
  } catch {
    throw new E2eAuthError('malformed handshake response');
  }
  const shared = x25519.getSharedSecret(state.priv, serverPub);
  const { session, authKey } = deriveSession(psk, shared, state.pub, serverPub);
  const expectedMac = hmac(sha256, authKey, concatBytes(state.pub, serverPub));
  if (!timingSafeEqual(respMac, expectedMac)) {
    throw new E2eAuthError('handshake response MAC mismatch');
  }
  return session;
}
