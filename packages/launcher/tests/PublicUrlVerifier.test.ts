/**
 * PublicUrlVerifier tests.
 *
 * Ported (pure node:dns + fetch) from volter-twin's `waitForPublicDns` /
 * `verifyPublicUrl`. Driven here with stubbed resolve/fetch seams + a fake clock
 * (a no-op `sleep` that advances the clock `now` reads) so the polling loops run
 * with no real DNS, network, or wall time.
 */
import { describe, expect, it } from 'bun:test';

import {
  publicHealthUrl,
  verifyPublicUrl,
  waitForPublicDns,
  type FetchImpl,
  type ResolveImpl,
} from '../src/PublicUrlVerifier.js';

/**
 * A fake clock: `now()` reads a counter that the (no-op) `sleep` advances by the
 * requested ms. So a loop that sleeps `intervalMs` between attempts advances the
 * budget deterministically and hits its timeout after the expected number of polls.
 */
function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };
}

/** A Response stub good enough for `verifyPublicUrl` (status + text()). */
function res(status: number, body = ''): Response {
  return { status, text: () => Promise.resolve(body) } as unknown as Response;
}

describe('waitForPublicDns', () => {
  it('returns the first IPv4 A record once it resolves', async () => {
    const { now, sleep } = fakeClock();
    const resolveImpl: ResolveImpl = async () => ['203.0.113.7'];
    const ip = await waitForPublicDns('host.example.com', { now, sleep, resolveImpl });
    expect(ip).toBe('203.0.113.7');
  });

  it('skips non-IPv4 noise and trims whitespace', async () => {
    const { now, sleep } = fakeClock();
    const resolveImpl: ResolveImpl = async () => ['not-an-ip', '  198.51.100.42  '];
    const ip = await waitForPublicDns('host.example.com', { now, sleep, resolveImpl });
    expect(ip).toBe('198.51.100.42');
  });

  it('keeps polling through NXDOMAIN then resolves (never throws on a resolve error)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    const resolveImpl: ResolveImpl = async () => {
      calls += 1;
      if (calls < 3) throw new Error('queryA ENOTFOUND');
      return ['192.0.2.9'];
    };
    const ip = await waitForPublicDns('host.example.com', {
      now,
      sleep,
      resolveImpl,
      intervalMs: 1_000,
    });
    expect(ip).toBe('192.0.2.9');
    expect(calls).toBe(3);
  });

  it('returns undefined on timeout (no record ever appears)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    const resolveImpl: ResolveImpl = async () => {
      calls += 1;
      return [];
    };
    const ip = await waitForPublicDns('host.example.com', {
      now,
      sleep,
      resolveImpl,
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    expect(ip).toBeUndefined();
    // started at 0, polls at 0/1k/2k/3k/4k → 5th attempt finds now>=timeout. 6 calls
    // would mean it overran; assert it stopped on budget.
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(calls).toBeLessThanOrEqual(6);
  });
});

describe('publicHealthUrl', () => {
  it('replaces path and strips query/hash, keeping the origin', () => {
    expect(publicHealthUrl('https://h.example.com/x?y=1#z', '/health')).toBe(
      'https://h.example.com/health'
    );
  });
  it('adds a leading slash to a bare path', () => {
    expect(publicHealthUrl('https://h.example.com', 'health')).toBe('https://h.example.com/health');
  });
});

describe('verifyPublicUrl', () => {
  const URL_UNDER_TEST = 'https://named.example.com';

  it('resolves DNS then returns a receipt on the first 2xx', async () => {
    const { now, sleep } = fakeClock();
    const resolveImpl: ResolveImpl = async () => ['203.0.113.7'];
    const fetchImpl: FetchImpl = async () => res(200, 'ok-body');
    const v = await verifyPublicUrl(URL_UNDER_TEST, {
      now,
      sleep,
      resolveImpl,
      fetchImpl,
      nowIso: () => '2026-06-29T00:00:00.000Z',
    });
    expect(v.status).toBe(200);
    expect(v.hostname).toBe('named.example.com');
    expect(v.resolvedIp).toBe('203.0.113.7');
    expect(v.path).toBe('/health');
    expect(v.body).toBe('ok-body');
    expect(v.checkedAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('accepts a 3xx as healthy (>=200 <400)', async () => {
    const { now, sleep } = fakeClock();
    const v = await verifyPublicUrl(URL_UNDER_TEST, {
      now,
      sleep,
      resolveImpl: async () => ['203.0.113.7'],
      fetchImpl: async () => res(302),
    });
    expect(v.status).toBe(302);
  });

  it('retries past 5xx/network errors until it gets a 200', async () => {
    const { now, sleep } = fakeClock();
    let n = 0;
    const fetchImpl: FetchImpl = async () => {
      n += 1;
      if (n === 1) return res(502, 'bad gateway');
      if (n === 2) throw new Error('ECONNRESET');
      return res(200, 'finally');
    };
    const v = await verifyPublicUrl(URL_UNDER_TEST, {
      now,
      sleep,
      resolveImpl: async () => ['203.0.113.7'],
      fetchImpl,
      intervalMs: 2_000,
    });
    expect(v.status).toBe(200);
    expect(v.body).toBe('finally');
    expect(n).toBe(3);
  });

  it('throws when DNS never resolves (carries the hostname + budget)', async () => {
    const { now, sleep } = fakeClock();
    await expect(
      verifyPublicUrl(URL_UNDER_TEST, {
        now,
        sleep,
        resolveImpl: async () => [],
        fetchImpl: async () => res(200),
        dnsTimeoutMs: 3_000,
        dnsIntervalMs: 1_000,
      })
    ).rejects.toThrow(/did not resolve through public DNS within 3000ms: named\.example\.com/);
  });

  it('throws on health timeout, surfacing the last status seen', async () => {
    const { now, sleep } = fakeClock();
    const v = verifyPublicUrl(URL_UNDER_TEST, {
      now,
      sleep,
      resolveImpl: async () => ['203.0.113.7'],
      fetchImpl: async () => res(503, 'still booting'),
      timeoutMs: 6_000,
      intervalMs: 2_000,
    });
    await expect(v).rejects.toThrow(/did not pass health verification/);
    await expect(v).rejects.toThrow(/HTTP 503/);
  });
});
