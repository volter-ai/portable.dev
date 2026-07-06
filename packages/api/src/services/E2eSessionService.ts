/**
 * E2eSessionService — the PC side of the end-to-end encryption layer
 * (portable.dev#13).
 *
 * Holds the PSK (from `PORTABLE_E2E_PSK`, forwarded by the launcher and carried
 * to the phone ONLY inside the pairing QR) and answers the phone's per-session
 * X25519 handshakes (`@vgit2/shared/e2e`). Each completed handshake yields
 * directional session keys with forward secrecy; sessions live in memory with a
 * sliding TTL — a lost session simply re-handshakes (the phone's client does
 * this transparently on a 410).
 *
 * The service is transport-agnostic: `e2e.routes.ts` (HTTP full tunnel) and the
 * Socket.IO frame layer both resolve sessions here.
 */
import crypto from 'crypto';

import {
  decodeBase64,
  respondToHandshake,
  E2eAuthError,
  type E2eHandshakeInit,
  type E2eHandshakeResponse,
  type E2eSessionKeys,
} from '@vgit2/shared/e2e';

/** Sliding session TTL — a phone app session comfortably outlives this via use. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Cap on live sessions (single-user PC — this is a leak backstop, not a limit). */
const MAX_SESSIONS = 256;

interface SessionRecord {
  keys: E2eSessionKeys;
  lastUsedAt: number;
}

export class E2eSessionService {
  private readonly psk: Uint8Array | null;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: { pskBase64?: string; now?: () => number } = {}) {
    const raw = (options.pskBase64 ?? process.env.PORTABLE_E2E_PSK ?? '').trim();
    let psk: Uint8Array | null = null;
    if (raw) {
      try {
        psk = decodeBase64(raw);
      } catch {
        console.error('[e2e] PORTABLE_E2E_PSK is not valid base64 — E2E disabled');
      }
    }
    this.psk = psk && psk.length > 0 ? psk : null;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when a PSK is configured (launcher-spawned local runtime). */
  isConfigured(): boolean {
    return this.psk !== null;
  }

  /**
   * Answer a phone's handshake init. Throws {@link E2eAuthError} when the
   * initiator does not hold the PSK (e.g. the relay probing the route), and a
   * plain Error when E2E is unconfigured (callers map it to 503).
   */
  handshake(init: E2eHandshakeInit): E2eHandshakeResponse {
    if (!this.psk) throw new Error('E2E is not configured on this PC');
    const { message, sessionId, keys } = respondToHandshake(
      this.psk,
      init,
      (n) => new Uint8Array(crypto.randomBytes(n))
    );
    this.evictExpired();
    // Leak backstop: drop the oldest session if somehow at cap.
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt
      )[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    this.sessions.set(sessionId, { keys, lastUsedAt: this.now() });
    return message;
  }

  /** Resolve a live session's keys (sliding TTL touch), or undefined. */
  getSessionKeys(sessionId: string): E2eSessionKeys | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    if (this.now() - record.lastUsedAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    record.lastUsedAt = this.now();
    return record.keys;
  }

  private evictExpired(): void {
    const cutoff = this.now() - SESSION_TTL_MS;
    for (const [id, record] of this.sessions) {
      if (record.lastUsedAt < cutoff) this.sessions.delete(id);
    }
  }
}

export { E2eAuthError };
