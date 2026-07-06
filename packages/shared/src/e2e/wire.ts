/**
 * E2E wire protocol — the full-tunnel HTTP shapes + JSON envelope helpers
 * (portable.dev#13).
 *
 * All phone↔PC HTTP (minus the documented plaintext exemptions) rides ONE
 * opaque route, `POST /api/e2e`, whose AEAD envelope carries the REAL request
 * — method, path, headers, body — so the relay cannot even see which endpoint
 * is called. The PC decrypts, dispatches internally, and encrypts the full
 * response back. Runtime-portable like the rest of `@vgit2/shared/e2e`.
 */
import {
  decodeBase64,
  encodeBase64,
  openEnvelope,
  sealEnvelope,
  type E2eEnvelope,
  type RandomBytes,
} from './envelope.js';

/** The real HTTP request carried INSIDE the envelope. */
export interface E2eInnerRequest {
  method: string;
  /** Path + query as the PC api should see it (e.g. `/api/chats?limit=50`). */
  path: string;
  /** End-to-end headers (Authorization, Content-Type, Accept, …). */
  headers: Record<string, string>;
  /** Request body bytes, base64 (absent for body-less methods). */
  bodyB64?: string;
}

/** The real HTTP response carried INSIDE the envelope. */
export interface E2eInnerResponse {
  status: number;
  /** End-to-end response headers (Content-Type, X-Renewed-Token, …). */
  headers: Record<string, string>;
  /** Response body bytes, base64 (absent for empty bodies). */
  bodyB64?: string;
}

/** Outer wire shape of a tunnelled exchange: the session id + the envelope. */
export interface E2eTunnelPayload {
  /** Session id from the handshake (routing only — keys stay private). */
  sid: string;
  /** The sealed envelope. */
  env: E2eEnvelope;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Seal any JSON-serializable value into an envelope under `key`. */
export function sealJson(
  key: Uint8Array,
  value: unknown,
  random: RandomBytes,
  aad?: Uint8Array
): E2eEnvelope {
  return sealEnvelope(key, textEncoder.encode(JSON.stringify(value)), random, aad);
}

/**
 * Open an envelope and parse its plaintext as JSON. Throws {@link E2eDecryptError}
 * (from openEnvelope) on any crypto failure; a JSON parse failure of an
 * AUTHENTICATED plaintext indicates a protocol bug and throws SyntaxError.
 */
export function openJson<T>(key: Uint8Array, env: E2eEnvelope, aad?: Uint8Array): T {
  return JSON.parse(textDecoder.decode(openEnvelope(key, env, aad))) as T;
}

/** Encode UTF-8 text as the base64 body field. */
export function textToB64(text: string): string {
  return encodeBase64(textEncoder.encode(text));
}

/** Decode a base64 body field back to UTF-8 text. */
export function b64ToText(b64: string): string {
  return textDecoder.decode(decodeBase64(b64));
}
