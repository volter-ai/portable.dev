/**
 * e2eSessionManager — one shared E2E session per connected PC (portable.dev#13).
 *
 * Both transports need the SAME session: the HTTP full tunnel
 * (`e2eTransport`) and the Socket.IO per-frame layer (`useNativeSocket`). This
 * module owns the per-pcId session cache + the PSK-authenticated X25519
 * handshake so a phone handshakes ONCE and both channels share the directional
 * keys. Keys live only in memory (forward secrecy).
 *
 * `configureE2eSessions` wires the runtime seams (the authed outer fetch, the
 * stored PSK reader, the relay-base reader); production calls it from
 * `ApiProvider`. `getOrCreateE2eSession` establishes-or-reuses; `dropE2eSession`
 * is called on a `410` so the next call re-handshakes.
 */
import {
  completeHandshake,
  createHandshakeInit,
  decodeBase64,
  type E2eHandshakeResponse,
  type E2eSession,
} from '@vgit2/shared/e2e';

import { getConnectedPcId } from '../pc-connect/connectedPcStore';
import { getE2eKey } from '../pc-connect/deviceTokenStore';
import { nativeRandomBytes } from './e2eRandom';
import { getRelayUrl } from './relayUrlStore';

export interface E2eSessionDeps {
  /** Outer transport for the handshake POST (the authed fetch). */
  outerFetch: (url: string, init?: RequestInit) => Promise<Response>;
  getPcId?: () => Promise<string | null>;
  getE2eKey?: (pcId: string) => Promise<string | null>;
  getRelayBase?: () => Promise<string>;
  random?: typeof nativeRandomBytes;
}

/** Thrown when the connected PC has no stored E2E key (needs a QR re-scan). */
export class NoE2eKeyError extends Error {
  constructor() {
    super('No E2E key for the connected PC — re-scan the pairing QR');
    this.name = 'NoE2eKeyError';
  }
}

let deps: E2eSessionDeps | null = null;
const sessions = new Map<string, E2eSession>();
const inFlight = new Map<string, Promise<E2eSession>>();

/** Wire the runtime seams (called once by ApiProvider). */
export function configureE2eSessions(d: E2eSessionDeps): void {
  deps = d;
}

/** True once the runtime seams are wired (production). Tests leave it false. */
export function isE2eConfigured(): boolean {
  return deps !== null;
}

/** Test seam: reset all session state + config. */
export function __resetE2eSessions(): void {
  deps = null;
  sessions.clear();
  inFlight.clear();
}

function resolved() {
  if (!deps) throw new Error('E2E sessions not configured');
  return {
    outerFetch: deps.outerFetch,
    getPcId: deps.getPcId ?? getConnectedPcId,
    getE2eKey: deps.getE2eKey ?? getE2eKey,
    getRelayBase: deps.getRelayBase ?? (async () => (await getRelayUrl()) ?? ''),
    random: deps.random ?? nativeRandomBytes,
  };
}

async function handshake(pcId: string): Promise<E2eSession> {
  const { outerFetch, getE2eKey: readKey, getRelayBase, random } = resolved();
  const keyB64 = await readKey(pcId);
  if (!keyB64) throw new NoE2eKeyError();
  const relayBase = await getRelayBase();
  const psk = decodeBase64(keyB64);
  const init = createHandshakeInit(psk, random);
  const res = await outerFetch(`${relayBase}/api/e2e/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.message),
  });
  if (!res.ok) throw new Error(`E2E handshake failed (${res.status})`);
  const response = (await res.json()) as E2eHandshakeResponse;
  const session = completeHandshake(psk, init.state, response);
  sessions.set(pcId, session);
  return session;
}

/**
 * Establish or reuse the E2E session for a pcId (defaults to the connected PC).
 * Concurrent callers share one in-flight handshake.
 */
export async function getOrCreateE2eSession(pcId?: string): Promise<E2eSession> {
  const { getPcId } = resolved();
  const id = pcId ?? (await getPcId());
  if (!id) throw new Error('No connected PC for E2E session');

  const existing = sessions.get(id);
  if (existing) return existing;

  const pending = inFlight.get(id);
  if (pending) return pending;

  const promise = handshake(id).finally(() => inFlight.delete(id));
  inFlight.set(id, promise);
  return promise;
}

/** Peek the cached session without handshaking (undefined if none). */
export function peekE2eSession(pcId: string): E2eSession | undefined {
  return sessions.get(pcId);
}

/** Forget a pcId's session (on a 410 or a re-pair) so the next call re-handshakes. */
export function dropE2eSession(pcId: string): void {
  sessions.delete(pcId);
}

/**
 * Drop the connected PC's cached session so the next `getOrCreateE2eSession`
 * re-handshakes (the socket's recovery after the PC rejects a stale `e2eSid`).
 * Best-effort + no-op when unconfigured; resolves the pcId via the wired seam.
 */
export async function dropConnectedE2eSession(): Promise<void> {
  if (!deps) return;
  try {
    const { getPcId } = resolved();
    const id = await getPcId();
    if (id) sessions.delete(id);
  } catch {
    // Best-effort — a failed pcId read just means the next handshake re-establishes.
  }
}
