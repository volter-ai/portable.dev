/**
 * E2E AEAD envelope — XChaCha20-Poly1305 (portable.dev#13).
 *
 * The sealed unit that crosses the relay: the gateway + Cloudflare forward it
 * but cannot read or forge it. Framework-free and runtime-portable — the SAME
 * code runs on Bun (api/launcher) and Hermes (React Native), which is why:
 *  - randomness is INJECTED (`RandomBytes`) — Hermes has no global
 *    `crypto.getRandomValues`; RN passes expo-crypto, Node passes node:crypto;
 *  - base64 is hand-rolled — no `Buffer`, no `atob`.
 *
 * XChaCha's 24-byte nonce is large enough that random nonces need no counter
 * coordination between the two ends (birthday bound ~2^96 messages).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

/** Injected CSPRNG seam: return `n` cryptographically random bytes. */
export type RandomBytes = (n: number) => Uint8Array;

/** XChaCha20-Poly1305 nonce size (bytes). */
export const E2E_NONCE_BYTES = 24;
/** Symmetric key size (bytes) for session keys and the PSK. */
export const E2E_KEY_BYTES = 32;

/** Wire form of one sealed message. All fields base64 (standard, padded). */
export interface E2eEnvelope {
  /** Envelope format version. */
  v: 1;
  /** 24-byte nonce. */
  n: string;
  /** Ciphertext + 16-byte Poly1305 tag. */
  ct: string;
}

/** Thrown when an envelope fails to open (wrong key, tampering, bad AAD). */
export class E2eDecryptError extends Error {
  constructor(message = 'E2E envelope failed to decrypt') {
    super(message);
    this.name = 'E2eDecryptError';
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]] = i;

/** Encode bytes as standard base64 (RN-safe: no Buffer/btoa). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/** Decode standard base64 to bytes (RN-safe: no Buffer/atob). */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let idx = 0;
  for (const ch of clean) {
    const val = B64_LOOKUP[ch];
    if (val === undefined) throw new Error(`invalid base64 character: ${JSON.stringify(ch)}`);
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Seal `plaintext` under `key` with a fresh random nonce. Optional `aad`
 * cryptographically binds context (e.g. the session id) without shipping it.
 */
export function sealEnvelope(
  key: Uint8Array,
  plaintext: Uint8Array,
  random: RandomBytes,
  aad?: Uint8Array
): E2eEnvelope {
  const nonce = random(E2E_NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { v: 1, n: encodeBase64(nonce), ct: encodeBase64(ct) };
}

/**
 * Open an envelope. Throws {@link E2eDecryptError} on ANY failure (wrong key,
 * tampered ciphertext/nonce, AAD mismatch, malformed base64) — callers never
 * need to distinguish, and a uniform error avoids oracle leaks.
 */
export function openEnvelope(key: Uint8Array, env: E2eEnvelope, aad?: Uint8Array): Uint8Array {
  try {
    const nonce = decodeBase64(env.n);
    const ct = decodeBase64(env.ct);
    return xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    throw new E2eDecryptError();
  }
}
