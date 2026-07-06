/**
 * e2eTransport (portable.dev#13) — the phone half of the HTTP full tunnel.
 *
 * Drives the real shared crypto against a fake PC that answers the handshake +
 * the tunnel with the SAME `@vgit2/shared/e2e` primitives, proving a JSON
 * request round-trips through the AEAD envelope and that a session miss (410)
 * transparently re-handshakes.
 */
import crypto from 'crypto';

import {
  encodeBase64,
  generatePsk,
  openJson,
  respondToHandshake,
  sealJson,
  textToB64,
  type E2eHandshakeInit,
  type E2eInnerRequest,
  type E2eInnerResponse,
  type E2eSessionKeys,
  type E2eTunnelPayload,
} from '@vgit2/shared/e2e';

import { createE2eFetch } from '../src/features/api/e2eTransport';

const random = (n: number) => new Uint8Array(crypto.randomBytes(n));
const RELAY = 'https://app.portable.dev/t/pc_x';

/**
 * A fake PC that shares `psk` and mirrors E2eSessionService: it completes
 * handshakes and answers tunnelled requests by echoing the inner path. `forget`
 * lets a test force a 410 to exercise the re-handshake path.
 */
function makeFakePc(psk: Uint8Array) {
  const sessions = new Map<string, E2eSessionKeys>();
  let forgetNext = false;
  const seen: E2eInnerRequest[] = [];

  const outerFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (url.endsWith('/api/e2e/handshake')) {
      const { message, sessionId, keys } = respondToHandshake(
        psk,
        body as E2eHandshakeInit,
        random
      );
      sessions.set(sessionId, keys);
      return new Response(JSON.stringify(message), { status: 200 });
    }
    if (url.endsWith('/api/e2e')) {
      const payload = body as E2eTunnelPayload;
      if (forgetNext) {
        forgetNext = false;
        return new Response(JSON.stringify({ error: 'x', code: 'e2e_session_unknown' }), {
          status: 410,
        });
      }
      const keys = sessions.get(payload.sid);
      if (!keys) return new Response('{}', { status: 410 });
      const inner = openJson<E2eInnerRequest>(keys.c2s, payload.env);
      seen.push(inner);
      const response: E2eInnerResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyB64: textToB64(JSON.stringify({ echoedPath: inner.path, method: inner.method })),
      };
      return new Response(
        JSON.stringify({ sid: payload.sid, env: sealJson(keys.s2c, response, random) }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected url ${url}`);
  };

  return { outerFetch, seen, forget: () => (forgetNext = true) };
}

function makeFetch(psk: Uint8Array, pc: ReturnType<typeof makeFakePc>) {
  return createE2eFetch({
    outerFetch: pc.outerFetch,
    getPcId: async () => 'pc_x',
    getE2eKey: async () => encodeBase64(psk),
    getRelayBase: async () => RELAY,
    random,
  });
}

describe('createE2eFetch', () => {
  it('tunnels a GET: handshakes once, seals the inner request, returns the decrypted body', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    const res = await e2eFetch(`${RELAY}/api/chats?limit=5`, { method: 'GET' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(await res.text())).toEqual({
      echoedPath: '/api/chats?limit=5',
      method: 'GET',
    });
    // The PC saw the real path, never exposed to the (fake) relay in cleartext.
    expect(pc.seen).toHaveLength(1);
    expect(pc.seen[0].path).toBe('/api/chats?limit=5');
  });

  it('tunnels a POST body through the envelope', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    await e2eFetch(`${RELAY}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'secret chat' }),
    });
    expect(pc.seen[0].method).toBe('POST');
    expect(pc.seen[0].bodyB64).toBe(textToB64(JSON.stringify({ title: 'secret chat' })));
  });

  it('re-handshakes transparently on a 410 session miss and replays', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    const e2eFetch = makeFetch(psk, pc);

    // Establish a session.
    await e2eFetch(`${RELAY}/api/me`, { method: 'GET' });
    // Force the next tunnel POST to 410; the transport must re-handshake + replay.
    pc.forget();
    const res = await e2eFetch(`${RELAY}/api/me`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).echoedPath).toBe('/api/me');
  });

  it('reuses one session across multiple requests (single handshake)', async () => {
    const psk = generatePsk(random);
    const pc = makeFakePc(psk);
    let handshakes = 0;
    const wrapped = {
      ...pc,
      outerFetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('/handshake')) handshakes++;
        return pc.outerFetch(url, init);
      },
    };
    const e2eFetch = createE2eFetch({
      outerFetch: wrapped.outerFetch,
      getPcId: async () => 'pc_x',
      getE2eKey: async () => encodeBase64(psk),
      getRelayBase: async () => RELAY,
      random,
    });
    await e2eFetch(`${RELAY}/api/a`, { method: 'GET' });
    await e2eFetch(`${RELAY}/api/b`, { method: 'GET' });
    expect(handshakes).toBe(1);
  });
});
