/**
 * ActiveGitHubConnectionCache Unit Tests
 *
 * Memoization layer for ConnectionsService.getActiveGitHubConnection that
 * prevents the sandbox → gateway → Clerk chain from running on every request.
 *
 * Policy under test:
 * - oauth: soft TTL 12 min
 * - app: honor expiresAt with a 5-min buffer
 * - none: negative-cache 45s, but ONLY when the fetch had an authToken
 * - errors are never cached; in-flight fetches are deduped
 * - invalidate() during an in-flight fetch prevents that result from caching
 */

import { describe, it, expect, mock } from 'bun:test';

import { ActiveGitHubConnectionCache } from '../../../src/services/ActiveGitHubConnectionCache';

import type { ActiveGitHubConnection } from '../../../src/services/ConnectionsService';

const MINUTE = 60 * 1000;

function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function oauthConnection(token = 'gho_test'): ActiveGitHubConnection {
  return { type: 'oauth', token };
}

function appConnection(token: string, expiresAtMs: number): ActiveGitHubConnection {
  return { type: 'app', token, expiresAt: new Date(expiresAtMs).toISOString() };
}

describe('ActiveGitHubConnectionCache', () => {
  describe('cache hits (oauth soft TTL)', () => {
    it('calls the fetcher once across N sequential get() calls within the TTL', async () => {
      const clock = makeClock();
      const cache = new ActiveGitHubConnectionCache({ now: clock.now });
      const fetcher = mock(async () => oauthConnection());

      const first = await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      for (let i = 0; i < 4; i++) {
        clock.advance(MINUTE); // stay well inside the 12-min TTL
        const result = await cache.get('user@test.com', fetcher, { hasAuthToken: true });
        expect(result).toBe(first);
      }

      expect(fetcher).toHaveBeenCalledTimes(1);
      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(4);
    });

    it('refetches an oauth entry after the 12-min soft TTL elapses', async () => {
      const clock = makeClock();
      const cache = new ActiveGitHubConnectionCache({ now: clock.now });
      const fetcher = mock(async () => oauthConnection());

      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      clock.advance(12 * MINUTE + 1);
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('caches per-user (different users do not share entries)', async () => {
      const cache = new ActiveGitHubConnectionCache();
      const fetcherA = mock(async () => oauthConnection('token-a'));
      const fetcherB = mock(async () => oauthConnection('token-b'));

      const a = await cache.get('a@test.com', fetcherA, { hasAuthToken: true });
      const b = await cache.get('b@test.com', fetcherB, { hasAuthToken: true });

      expect(a.token).toBe('token-a');
      expect(b.token).toBe('token-b');
      expect(fetcherA).toHaveBeenCalledTimes(1);
      expect(fetcherB).toHaveBeenCalledTimes(1);
    });
  });

  describe('in-flight dedup', () => {
    it('two concurrent get() calls share exactly one fetcher invocation', async () => {
      const cache = new ActiveGitHubConnectionCache();
      let resolveFetch!: (value: ActiveGitHubConnection) => void;
      const fetcher = mock(
        () => new Promise<ActiveGitHubConnection>((resolve) => (resolveFetch = resolve))
      );

      const p1 = cache.get('user@test.com', fetcher, { hasAuthToken: true });
      const p2 = cache.get('user@test.com', fetcher, { hasAuthToken: true });

      resolveFetch(oauthConnection());
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
      expect(cache.getStats().deduped).toBe(1);
    });
  });

  describe('app token expiry (5-min buffer)', () => {
    it('refetches when the app entry expiresAt is inside the 5-min buffer', async () => {
      const clock = makeClock();
      const cache = new ActiveGitHubConnectionCache({ now: clock.now });
      // Token expires in 4 minutes — already inside the 5-min buffer.
      const fetcher = mock(async () => appConnection('ghs_short', clock.now() + 4 * MINUTE));

      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('serves a cached app entry while expiresAt is outside the 5-min buffer', async () => {
      const clock = makeClock();
      const cache = new ActiveGitHubConnectionCache({ now: clock.now });
      // Token expires in 1 hour.
      const fetcher = mock(async () => appConnection('ghs_long', clock.now() + 60 * MINUTE));

      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      clock.advance(30 * MINUTE); // expiresAt - now = 30min > 5min buffer
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('negative caching of type "none"', () => {
    it('caches "none" for 45s when fetched WITH an authToken', async () => {
      const clock = makeClock();
      const cache = new ActiveGitHubConnectionCache({ now: clock.now });
      const fetcher = mock(async (): Promise<ActiveGitHubConnection> => ({ type: 'none' }));

      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      clock.advance(30 * 1000);
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      expect(fetcher).toHaveBeenCalledTimes(1);

      clock.advance(16 * 1000); // total 46s — past the 45s negative TTL
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does NOT cache "none" when fetched WITHOUT an authToken', async () => {
      const cache = new ActiveGitHubConnectionCache();
      const fetcher = mock(async (): Promise<ActiveGitHubConnection> => ({ type: 'none' }));

      await cache.get('user@test.com', fetcher, { hasAuthToken: false });
      await cache.get('user@test.com', fetcher, { hasAuthToken: false });

      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('still caches a real connection fetched WITHOUT an authToken', async () => {
      const cache = new ActiveGitHubConnectionCache();
      const fetcher = mock(async () => oauthConnection());

      await cache.get('user@test.com', fetcher, { hasAuthToken: false });
      await cache.get('user@test.com', fetcher, { hasAuthToken: false });

      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidation', () => {
    it('invalidate(userId) forces a refetch on the next get()', async () => {
      const cache = new ActiveGitHubConnectionCache();
      const fetcher = mock(async () => oauthConnection());

      await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      cache.invalidate('user@test.com');
      await cache.get('user@test.com', fetcher, { hasAuthToken: true });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(cache.getStats().invalidations).toBe(1);
    });

    it('invalidate() during an in-flight fetch prevents that result from being cached', async () => {
      const cache = new ActiveGitHubConnectionCache();
      let resolveFetch!: (value: ActiveGitHubConnection) => void;
      const fetcher = mock(
        () => new Promise<ActiveGitHubConnection>((resolve) => (resolveFetch = resolve))
      );

      const pending = cache.get('user@test.com', fetcher, { hasAuthToken: true });
      cache.invalidate('user@test.com'); // generation bump while fetch is in flight
      resolveFetch(oauthConnection('stale-token'));
      const result = await pending;
      expect(result.token).toBe('stale-token'); // caller still gets the value...

      // ...but it was NOT cached: the next get() fetches again.
      const freshFetcher = mock(async () => oauthConnection('fresh-token'));
      const next = await cache.get('user@test.com', freshFetcher, { hasAuthToken: true });
      expect(next.token).toBe('fresh-token');
      expect(freshFetcher).toHaveBeenCalledTimes(1);
    });

    it('a get() arriving AFTER an invalidation does not join the stale in-flight fetch', async () => {
      const cache = new ActiveGitHubConnectionCache();
      let resolveStale!: (value: ActiveGitHubConnection) => void;
      const staleFetcher = mock(
        () => new Promise<ActiveGitHubConnection>((resolve) => (resolveStale = resolve))
      );

      const stalePending = cache.get('user@test.com', staleFetcher, { hasAuthToken: true });
      cache.invalidate('user@test.com');

      // New get while the stale fetch is STILL in flight → must run its own fetch
      const freshFetcher = mock(async () => oauthConnection('fresh-token'));
      const fresh = await cache.get('user@test.com', freshFetcher, { hasAuthToken: true });
      expect(fresh.token).toBe('fresh-token');
      expect(freshFetcher).toHaveBeenCalledTimes(1);

      resolveStale(oauthConnection('stale-token'));
      const stale = await stalePending;
      expect(stale.token).toBe('stale-token'); // original waiter unaffected

      // The fresh result stays cached — the stale fetch must not clobber it.
      const after = await cache.get('user@test.com', freshFetcher, { hasAuthToken: true });
      expect(after.token).toBe('fresh-token');
      expect(freshFetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('propagates fetcher rejection, caches nothing, and re-invokes on the next call', async () => {
      const cache = new ActiveGitHubConnectionCache();
      let shouldFail = true;
      const fetcher = mock(async () => {
        if (shouldFail) throw new Error('gateway down');
        return oauthConnection();
      });

      await expect(cache.get('user@test.com', fetcher, { hasAuthToken: true })).rejects.toThrow(
        'gateway down'
      );

      shouldFail = false;
      const result = await cache.get('user@test.com', fetcher, { hasAuthToken: true });
      expect(result.type).toBe('oauth');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('clears a rejected in-flight promise so concurrent waiters all reject but later calls recover', async () => {
      const cache = new ActiveGitHubConnectionCache();
      let rejectFetch!: (err: Error) => void;
      const fetcher = mock(
        () => new Promise<ActiveGitHubConnection>((_, reject) => (rejectFetch = reject))
      );

      const p1 = cache.get('user@test.com', fetcher, { hasAuthToken: true });
      const p2 = cache.get('user@test.com', fetcher, { hasAuthToken: true });
      // allSettled attaches handlers BEFORE the rejection (no unhandled
      // rejection) without bun's expect(...).rejects, which evaluates
      // synchronously and would deadlock on a still-pending promise.
      const settled = Promise.allSettled([p1, p2]);
      rejectFetch(new Error('boom'));
      const [r1, r2] = await settled;

      expect(r1.status).toBe('rejected');
      expect(r2.status).toBe('rejected');
      expect((r1 as PromiseRejectedResult).reason.message).toBe('boom');
      expect((r2 as PromiseRejectedResult).reason.message).toBe('boom');

      const recovery = mock(async () => oauthConnection());
      const result = await cache.get('user@test.com', recovery, { hasAuthToken: true });
      expect(result.type).toBe('oauth');
      expect(recovery).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats()', () => {
    it('returns {hits, misses, deduped, invalidations}', async () => {
      const cache = new ActiveGitHubConnectionCache();
      const fetcher = mock(async () => oauthConnection());

      await cache.get('user@test.com', fetcher, { hasAuthToken: true }); // miss
      await cache.get('user@test.com', fetcher, { hasAuthToken: true }); // hit
      cache.invalidate('user@test.com'); // invalidation

      const stats = cache.getStats();
      expect(stats).toEqual({ hits: 1, misses: 1, deduped: 0, invalidations: 1 });
    });
  });
});
