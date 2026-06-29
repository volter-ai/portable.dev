import type { ActiveGitHubConnection } from './ConnectionsService.js';

/**
 * Cache stats counters, exposed for diagnostics via getStats().
 */
export interface ActiveGitHubConnectionCacheStats {
  hits: number;
  misses: number;
  deduped: number;
  invalidations: number;
}

interface CacheEntry {
  value: ActiveGitHubConnection;
  /** ms epoch after which the entry is stale and must be refetched */
  validUntil: number;
}

interface InFlightEntry {
  promise: Promise<ActiveGitHubConnection>;
  /** generation captured when the fetch started — see invalidate() */
  generation: number;
}

export interface ActiveGitHubConnectionCacheOptions {
  /** Injectable clock for tests (defaults to Date.now) */
  now?: () => number;
  /** Soft TTL for oauth connections (OAuth tokens don't expire; lazy revalidation) */
  oauthTtlMs?: number;
  /** Negative-cache TTL for type 'none' results fetched with an authToken */
  noneTtlMs?: number;
  /** Refetch app tokens this long before their expiresAt */
  appExpiryBufferMs?: number;
}

const DEFAULT_OAUTH_TTL_MS = 12 * 60 * 1000; // 12 min
const DEFAULT_NONE_TTL_MS = 45 * 1000; // 45 s
const DEFAULT_APP_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min (matches getGitHubAppToken)

/**
 * Per-user memoization of ConnectionsService.getActiveGitHubConnection.
 *
 * Every consumer of the GitHub token funnels through that method, and before
 * this cache each call ran the full sandbox → gateway → Clerk chain (a DB
 * query + HTTP to the gateway + live Clerk Backend API call). Clerk's rate
 * limit is global per instance, so uncached traffic from one sandbox degrades
 * every user.
 *
 * Policy:
 * - oauth: soft TTL (default 12 min)
 * - app:   honor the token's expiresAt with a 5-min buffer; entries without
 *          expiresAt fall back to the oauth soft TTL
 * - none:  negative-cache 45s, but ONLY when the fetch ran with an authToken —
 *          a 'none' without authToken may just mean the Clerk fallback inside
 *          fetchActiveGitHubConnection was skipped
 * - errors are never cached; a rejected in-flight promise is cleared
 * - concurrent get() calls share one fetch (in-flight dedup)
 * - a per-user generation counter makes invalidate() during an in-flight fetch
 *   prevent that fetch's result from being cached
 */
export class ActiveGitHubConnectionCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, InFlightEntry>();
  private generations = new Map<string, number>();
  /** users invalidated since their last fetch — only used to log the fetch reason */
  private invalidatedUsers = new Set<string>();
  private stats: ActiveGitHubConnectionCacheStats = {
    hits: 0,
    misses: 0,
    deduped: 0,
    invalidations: 0,
  };

  private readonly now: () => number;
  private readonly oauthTtlMs: number;
  private readonly noneTtlMs: number;
  private readonly appExpiryBufferMs: number;

  constructor(options: ActiveGitHubConnectionCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.oauthTtlMs = options.oauthTtlMs ?? DEFAULT_OAUTH_TTL_MS;
    this.noneTtlMs = options.noneTtlMs ?? DEFAULT_NONE_TTL_MS;
    this.appExpiryBufferMs = options.appExpiryBufferMs ?? DEFAULT_APP_EXPIRY_BUFFER_MS;
  }

  /**
   * Get the (possibly cached) active GitHub connection for a user.
   *
   * @param userId - cache key
   * @param fetcher - runs the real (uncached) lookup on miss
   * @param opts.hasAuthToken - whether the fetch runs with a JWT; gates negative caching
   */
  async get(
    userId: string,
    fetcher: () => Promise<ActiveGitHubConnection>,
    opts: { hasAuthToken?: boolean } = {}
  ): Promise<ActiveGitHubConnection> {
    const cached = this.entries.get(userId);
    if (cached && this.now() < cached.validUntil) {
      this.stats.hits++;
      return cached.value;
    }

    const existing = this.inFlight.get(userId);
    if (existing) {
      this.stats.deduped++;
      return existing.promise;
    }

    this.stats.misses++;
    const reason = this.invalidatedUsers.has(userId) ? 'invalidated' : cached ? 'expired' : 'miss';
    this.invalidatedUsers.delete(userId);
    console.log(`[GitHubConnCache] fetch user=${userId} reason=${reason}`);

    const generation = this.generations.get(userId) ?? 0;
    const promise = (async () => {
      try {
        const value = await fetcher();
        // Only cache if no invalidate() happened while this fetch was in flight.
        if ((this.generations.get(userId) ?? 0) === generation) {
          const validUntil = this.computeValidUntil(value, opts.hasAuthToken === true);
          if (validUntil !== undefined) {
            this.entries.set(userId, { value, validUntil });
          }
        }
        return value;
      } finally {
        // Clear in-flight on success AND failure so errors are never cached.
        // Generation-compared: invalidate() may have already replaced this
        // slot with a newer fetch, which must not be deleted by the old one.
        const current = this.inFlight.get(userId);
        if (current && current.generation === generation) {
          this.inFlight.delete(userId);
        }
      }
    })();

    this.inFlight.set(userId, { promise, generation });
    return promise;
  }

  /**
   * Drop the cached entry for a user and prevent any in-flight fetch from
   * caching its result. Call whenever connections change (store/delete/activate).
   */
  invalidate(userId: string): void {
    this.stats.invalidations++;
    this.entries.delete(userId);
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    // Detach the in-flight slot too: its waiters still get their result, but a
    // get() arriving after this invalidation must start a fresh fetch instead
    // of joining a lookup that predates the mutation.
    this.inFlight.delete(userId);
    this.invalidatedUsers.add(userId);
  }

  getStats(): ActiveGitHubConnectionCacheStats {
    return { ...this.stats };
  }

  /**
   * Returns the ms-epoch the entry stays valid until, or undefined when the
   * result must not be cached at all.
   */
  private computeValidUntil(
    value: ActiveGitHubConnection,
    hasAuthToken: boolean
  ): number | undefined {
    const now = this.now();

    if (value.type === 'none') {
      return hasAuthToken ? now + this.noneTtlMs : undefined;
    }

    if (value.type === 'app' && value.expiresAt) {
      const expiresAtMs = new Date(value.expiresAt).getTime();
      if (!Number.isNaN(expiresAtMs)) {
        return expiresAtMs - this.appExpiryBufferMs;
      }
    }

    // oauth, or app without a parseable expiresAt
    return now + this.oauthTtlMs;
  }
}
