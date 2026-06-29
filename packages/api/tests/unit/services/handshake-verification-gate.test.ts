/**
 * Unit tests for HandshakeVerificationGate (block kill switch).
 *
 * The gate fetches the gateway's `VERIFY_HANDSHAKE` flag
 * (`GET ${GATEWAY_URL}/api/verify-handshake`), caches it, and FAILS OPEN — any
 * failure resolves to `false` (never block). Pure-logic, no network: an injected
 * `fetchImpl` + clock drive every case. Lives in the `unit` shard.
 */
import { describe, expect, it } from 'bun:test';

import { HandshakeVerificationGate } from '../../../src/services/HandshakeVerificationGate';

/** Build a Response-like stub for the injected fetch. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

/** A counting fetch stub that always returns the same JSON body. */
function countingFetch(body: unknown, ok = true) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(body, ok);
  };
  return { fetchImpl, calls: () => calls };
}

describe('HandshakeVerificationGate (kill switch)', () => {
  it('returns true when the gateway reports verifyHandshake: true', async () => {
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => jsonResponse({ verifyHandshake: true }),
    });
    expect(await gate.isEnabled()).toBe(true);
  });

  it('returns false when the gateway reports verifyHandshake: false', async () => {
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => jsonResponse({ verifyHandshake: false }),
    });
    expect(await gate.isEnabled()).toBe(false);
  });

  it('treats a non-boolean / missing field as false (only strict true enables)', async () => {
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => jsonResponse({ verifyHandshake: 'true' }), // string, not boolean
    });
    expect(await gate.isEnabled()).toBe(false);
  });

  it('fails OPEN (false) when GATEWAY_URL is unset', async () => {
    let fetched = false;
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => undefined,
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({ verifyHandshake: true });
      },
    });
    expect(await gate.isEnabled()).toBe(false);
    expect(fetched).toBe(false); // never even attempts a fetch with no base URL
  });

  it('fails OPEN (false) when the fetch throws (gateway unreachable)', async () => {
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await gate.isEnabled()).toBe(false);
  });

  it('fails OPEN (false) on a non-2xx response', async () => {
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => jsonResponse({ verifyHandshake: true }, /* ok */ false),
    });
    expect(await gate.isEnabled()).toBe(false);
  });

  it('requests GET ${GATEWAY_URL}/api/verify-handshake, stripping a trailing slash', async () => {
    let seenUrl = '';
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com/',
      fetchImpl: async (url: string) => {
        seenUrl = url;
        return jsonResponse({ verifyHandshake: true });
      },
    });
    await gate.isEnabled();
    expect(seenUrl).toBe('https://gw.example.com/api/verify-handshake');
  });

  it('caches the result within the TTL (one fetch for repeated calls)', async () => {
    let t = 1_000;
    const f = countingFetch({ verifyHandshake: true });
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: f.fetchImpl,
      now: () => t,
      ttlMs: 60_000,
    });
    expect(await gate.isEnabled()).toBe(true);
    t += 30_000; // still inside the TTL window
    expect(await gate.isEnabled()).toBe(true);
    expect(f.calls()).toBe(1);
  });

  it('refetches after the TTL elapses', async () => {
    let t = 1_000;
    const f = countingFetch({ verifyHandshake: true });
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: f.fetchImpl,
      now: () => t,
      ttlMs: 60_000,
    });
    expect(await gate.isEnabled()).toBe(true);
    t += 60_001; // past the TTL
    expect(await gate.isEnabled()).toBe(true);
    expect(f.calls()).toBe(2);
  });

  it('caches a failed (fail-open false) result too, so a down gateway is not hammered', async () => {
    let t = 1_000;
    let calls = 0;
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('down');
      },
      now: () => t,
      ttlMs: 60_000,
    });
    expect(await gate.isEnabled()).toBe(false);
    t += 30_000;
    expect(await gate.isEnabled()).toBe(false);
    expect(calls).toBe(1);
  });

  it('dedups concurrent callers into a single in-flight fetch', async () => {
    let calls = 0;
    let resolveFetch: (r: Response) => void = () => {};
    const gate = new HandshakeVerificationGate({
      getGatewayUrl: () => 'https://gw.example.com',
      fetchImpl: () => {
        calls += 1;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });
    const a = gate.isEnabled();
    const b = gate.isEnabled();
    resolveFetch(jsonResponse({ verifyHandshake: true }));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(calls).toBe(1);
  });
});
