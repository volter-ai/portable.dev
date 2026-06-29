/**
 * ReposCacheService - In-memory cache for repository lists
 *
 * Provides fast repository list loading by:
 * 1. Returning cached data immediately (instant load)
 * 2. Refreshing cache in background (prime for next request)
 * 3. User-specific caching (per-user cache keys)
 * 4. TTL-based expiration (configurable cache lifetime)
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

interface ReposCacheKey {
  userId: string;
  page: number;
  per_page: number;
  search?: string;
  language?: string;
  sort?: string;
  blockedOrgs?: string;
  /** rev9 D27a: workspace-only listing (no GitHub fetch) — a DISTINCT cache namespace
   *  from the GitHub-seeded list, or the two would collide for the same params. */
  localOnly?: boolean;
}

export class ReposCacheService {
  private cache: Map<string, CacheEntry<any>>;
  private lastRefreshTime: Map<string, number>; // Track last background refresh time per key
  private defaultTTL: number; // in milliseconds
  private refreshThrottleMs: number; // Minimum time between background refreshes (default: 30 minutes)

  constructor(ttlMinutes: number = 5, refreshThrottleMinutes: number = 30) {
    this.cache = new Map();
    this.lastRefreshTime = new Map();
    this.defaultTTL = ttlMinutes * 60 * 1000;
    this.refreshThrottleMs = refreshThrottleMinutes * 60 * 1000;
    // console.log(`[ReposCacheService] Initialized with TTL: ${ttlMinutes} minutes, refresh throttle: ${refreshThrottleMinutes} minutes`);
  }

  /**
   * Generate cache key from request parameters
   */
  private getCacheKey(key: ReposCacheKey): string {
    const parts = [key.userId, `page:${key.page}`, `per_page:${key.per_page}`];

    if (key.search) parts.push(`search:${key.search}`);
    if (key.language) parts.push(`lang:${key.language}`);
    if (key.sort) parts.push(`sort:${key.sort}`);
    if (key.blockedOrgs) parts.push(`blocked:${key.blockedOrgs}`);
    if (key.localOnly) parts.push('localOnly:1');

    return parts.join('|');
  }

  /**
   * Get cached data if available and not expired
   */
  get<T>(
    key: ReposCacheKey
  ): { data: T; isStale: boolean; ageMs: number; needsRefresh: boolean } | null {
    const cacheKey = this.getCacheKey(key);
    const entry = this.cache.get(cacheKey);

    if (!entry) {
      return null;
    }

    const now = Date.now();
    const isStale = now > entry.expiresAt;
    const ageMs = now - entry.timestamp;

    // Check if we need to trigger background refresh
    // Only refresh if cache age > refresh throttle time
    const lastRefresh = this.lastRefreshTime.get(cacheKey) || 0;
    const timeSinceLastRefresh = now - lastRefresh;
    const needsRefresh = timeSinceLastRefresh > this.refreshThrottleMs;

    // Return data even if stale (for fast initial load)
    return {
      data: entry.data as T,
      isStale,
      ageMs,
      needsRefresh,
    };
  }

  /**
   * Store data in cache with timestamp
   */
  set<T>(key: ReposCacheKey, data: T, ttl?: number): void {
    const cacheKey = this.getCacheKey(key);
    const now = Date.now();
    const expiresAt = now + (ttl || this.defaultTTL);

    this.cache.set(cacheKey, {
      data,
      timestamp: now,
      expiresAt,
    });

    // console.log(`[ReposCacheService] Cached data for key: ${cacheKey} (expires in ${Math.round((expiresAt - now) / 1000)}s)`);
  }

  /**
   * Record that a background refresh was triggered for this key
   * Used to throttle refresh frequency
   */
  recordRefresh(key: ReposCacheKey): void {
    const cacheKey = this.getCacheKey(key);
    this.lastRefreshTime.set(cacheKey, Date.now());
  }

  /**
   * Delete cached entry
   */
  delete(key: ReposCacheKey): boolean {
    const cacheKey = this.getCacheKey(key);
    this.lastRefreshTime.delete(cacheKey); // Also clean up refresh tracking
    return this.cache.delete(cacheKey);
  }

  /**
   * Invalidate all cache entries for a user
   */
  invalidateUser(userId: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}|`)) {
        this.cache.delete(key);
        this.lastRefreshTime.delete(key); // Also clean up refresh tracking
        count++;
      }
    }
    // console.log(`[ReposCacheService] Invalidated ${count} cache entries for user: ${userId}`);
    return count;
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.lastRefreshTime.clear(); // Also clear refresh tracking
    // console.log(`[ReposCacheService] Cleared ${count} cache entries`);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let activeCount = 0;
    let staleCount = 0;

    for (const entry of this.cache.values()) {
      if (now <= entry.expiresAt) {
        activeCount++;
      } else {
        staleCount++;
      }
    }

    return {
      total: this.cache.size,
      active: activeCount,
      stale: staleCount,
      ttlMinutes: this.defaultTTL / 60000,
    };
  }

  /**
   * Cleanup expired entries (garbage collection)
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      // Remove entries that have been stale for more than 2x TTL
      if (now > entry.expiresAt + this.defaultTTL) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      // console.log(`[ReposCacheService] Cleanup: removed ${removed} expired entries`);
    }

    return removed;
  }
}
