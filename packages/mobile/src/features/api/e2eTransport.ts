/**
 * e2eTransport — the phone half of the HTTP full tunnel (portable.dev#13).
 *
 * Wraps an "outer" fetch (the existing Bearer/refresh `authedFetch`) so that a
 * relative `/api/*` request is sealed inside an AEAD envelope and POSTed to the
 * connected PC's `POST /api/e2e`. The relay + Cloudflare forward only the
 * opaque envelope + the identity Bearer; they never see the method, path, or
 * body.
 *
 * A session is established lazily per pcId via the PSK-authenticated X25519
 * handshake and cached in memory (the keys never touch storage). On a `410`
 * (the PC forgot the session — restart / TTL) the transport re-handshakes once
 * and replays, so a dropped session is invisible to callers.
 *
 * The returned `e2eFetch(innerPath, init)` mimics `fetch`: it resolves to a
 * `Response`-like object carrying the decrypted inner status/headers/body, so
 * `RelayApiClient` consumes it exactly like a direct response.
 */
import {
  completeHandshake,
  createHandshakeInit,
  decodeBase64,
  openJson,
  sealJson,
  textToB64,
  b64ToText,
  type E2eHandshakeResponse,
  type E2eInnerRequest,
  type E2eInnerResponse,
  type E2eSession,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';

import { nativeRandomBytes } from './e2eRandom';

/** A minimal Response-like the RelayApiClient already handles. */
export interface E2eResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** A fetch-shaped tunnel: same signature the RelayApiClient calls today. */
export type E2eFetch = (absoluteUrl: string, init?: RequestInit) => Promise<E2eResponseLike>;

export interface E2eTransportDeps {
  /**
   * The outer transport for the `POST /api/e2e[/handshake]` requests — the
   * existing `authedFetch` so the outer Bearer + `X-Renewed-Token` renewal keep
   * working (identity is by-design visible to the relay).
   */
  outerFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolve the connected pcId (session cache key). */
  getPcId: () => Promise<string | null>;
  /** Resolve the per-PC E2E pre-shared key (base64) stored from the QR. */
  getE2eKey: (pcId: string) => Promise<string | null>;
  /** Resolve the relay base for the connected PC (`<gatewayBase>/t/<pcId>`). */
  getRelayBase: () => Promise<string>;
  /** Injectable CSPRNG (defaults to expo-crypto). */
  random?: typeof nativeRandomBytes;
}

/** Thrown when the connected PC has no stored E2E key (needs a QR re-scan). */
export class NoE2eKeyError extends Error {
  constructor() {
    super('No E2E key for the connected PC — re-scan the pairing QR');
    this.name = 'NoE2eKeyError';
  }
}

/** Split an absolute relay URL back into the inner `/api/...` path the PC sees. */
function innerPathFromUrl(absoluteUrl: string, relayBase: string): string {
  if (absoluteUrl.startsWith(relayBase)) {
    const rest = absoluteUrl.slice(relayBase.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
  // Absolute URL to a different origin — pass the pathname+search through.
  try {
    const u = new URL(absoluteUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    return absoluteUrl;
  }
}

/** Normalize a RequestInit's headers to a plain lowercase-keyed record. */
function headersToRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
  } else if (typeof (h as Headers).forEach === 'function') {
    (h as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** Build the E2eResponseLike from a decrypted inner response. */
function toResponseLike(inner: E2eInnerResponse): E2eResponseLike {
  const headers = inner.headers ?? {};
  return {
    ok: inner.status >= 200 && inner.status < 300,
    status: inner.status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => (inner.bodyB64 ? b64ToText(inner.bodyB64) : ''),
  };
}

export function createE2eFetch(deps: E2eTransportDeps): E2eFetch {
  const random = deps.random ?? nativeRandomBytes;
  // In-memory session cache keyed by pcId (keys never persist — forward secrecy).
  const sessions = new Map<string, E2eSession>();

  async function handshake(pcId: string, relayBase: string): Promise<E2eSession> {
    const keyB64 = await deps.getE2eKey(pcId);
    if (!keyB64) throw new NoE2eKeyError();
    const psk = decodeBase64(keyB64);
    const init = createHandshakeInit(psk, random);
    const res = await deps.outerFetch(`${relayBase}/api/e2e/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(init.message),
    });
    if (!res.ok) {
      throw new Error(`E2E handshake failed (${res.status})`);
    }
    const response = (await res.json()) as E2eHandshakeResponse;
    const session = completeHandshake(psk, init.state, response);
    sessions.set(pcId, session);
    return session;
  }

  async function session(pcId: string, relayBase: string): Promise<E2eSession> {
    return sessions.get(pcId) ?? handshake(pcId, relayBase);
  }

  async function tunnelOnce(
    pcId: string,
    relayBase: string,
    inner: E2eInnerRequest
  ): Promise<{ status: number; response?: E2eInnerResponse }> {
    const sess = await session(pcId, relayBase);
    const payload: E2eTunnelPayload = {
      sid: sess.sessionId,
      env: sealJson(sess.keys.c2s, inner, random),
    };
    const res = await deps.outerFetch(`${relayBase}/api/e2e`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 410) {
      // The PC forgot this session — drop it so the caller re-handshakes.
      sessions.delete(pcId);
      return { status: 410 };
    }
    if (!res.ok) {
      throw new Error(`E2E tunnel error (${res.status})`);
    }
    const body = (await res.json()) as E2eTunnelPayload;
    return { status: 200, response: openJson<E2eInnerResponse>(sess.keys.s2c, body.env) };
  }

  return async function e2eFetch(absoluteUrl, init): Promise<E2eResponseLike> {
    const pcId = await deps.getPcId();
    if (!pcId) throw new Error('No connected PC for E2E transport');
    const relayBase = await deps.getRelayBase();

    const headers = headersToRecord(init);
    const bodyB64 =
      typeof init?.body === 'string' && init.body.length > 0 ? textToB64(init.body) : undefined;
    const inner: E2eInnerRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: innerPathFromUrl(absoluteUrl, relayBase),
      headers,
      bodyB64,
    };

    // First attempt; on a session miss (410) re-handshake once and replay.
    let result = await tunnelOnce(pcId, relayBase, inner);
    if (result.status === 410) {
      await handshake(pcId, relayBase);
      result = await tunnelOnce(pcId, relayBase, inner);
    }
    if (!result.response) {
      throw new Error('E2E session could not be established');
    }
    return toResponseLike(result.response);
  };
}
