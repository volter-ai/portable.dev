/**
 * MockReposCacheService
 *
 * Mock implementation of ReposCacheService for testing.
 * Provides in-memory cache without persistence.
 */

export class MockReposCacheService {
  private cache: Map<string, any> = new Map();

  /**
   * Get value from cache
   */
  get(key: string): any {
    return this.cache.get(key);
  }

  /**
   * Set value in cache
   */
  set(key: string, value: any, ttlSeconds?: number): void {
    this.cache.set(key, value);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Delete specific cache entry
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }
}
