/**
 * ReposCacheService Lifecycle Tests - Happy Path Scenarios
 *
 * THE STORY: "Developer working offline needs to access repo data"
 *
 * Scenario Type: Offline-first caching workflow
 * User: Jordan (a developer on a train with spotty internet)
 *
 * Jordan is commuting on a train and wants to review their project's repository
 * information. The train goes through areas with no signal, so they rely on the
 * platform's caching to access previously loaded data. When they had internet
 * earlier, they browsed several repositories which got cached. Now offline, they
 * can still access that cached data to review repository details, check file
 * structures, and plan their work for when they get back online.
 *
 * This demonstrates the caching layer's ability to provide a smooth offline
 * experience, letting Jordan stay productive even without connectivity.
 *
 * REAL SERVICES:
 * - ✅ ReposCacheService - Repository caching logic
 * - ✅ No database needed - pure in-memory cache
 * - ✅ No external APIs - testing cache behavior only
 *
 * MOCKED EXTERNAL:
 * - None needed - this is a pure caching service test
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ReposCacheService } from '../../../src/services/ReposCacheService';

describe('ReposCache Lifecycle - Offline Developer Workflow', () => {
  let reposCacheService: ReposCacheService;

  const TEST_USER_ID = 'jordan@example.com';
  const MOCK_REPOS = [
    {
      id: 123456,
      name: 'payment-service',
      full_name: 'acme/payment-service',
      owner: { login: 'acme' },
      private: false,
      description: 'Payment processing microservice',
      stargazers_count: 42,
      updated_at: new Date().toISOString(),
    },
    {
      id: 789012,
      name: 'user-auth',
      full_name: 'acme/user-auth',
      owner: { login: 'acme' },
      private: true,
      description: 'User authentication service',
      stargazers_count: 28,
      updated_at: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    // Create fresh cache service for each test
    reposCacheService = new ReposCacheService();
  });

  it("should handle Jordan's offline repository review workflow", async () => {
    /**
     * SCENARIO: Jordan needs to work offline with cached repository data
     * Step 1: Jordan loads repositories while online (cache miss → cache repos)
     * Step 2: Train enters tunnel (no internet) → Jordan accesses cached data
     * Step 3: Jordan clears old cache to free memory
     * Step 4: Jordan verifies cache stats for monitoring
     */

    /**
     * STEP 1: Jordan browses repositories while online
     * The cache service stores the data for future offline access
     */
    console.log('📶 Jordan is online, browsing repositories...');

    const cacheKey = {
      userId: TEST_USER_ID,
      page: 1,
      per_page: 20,
      sort: 'updated',
    };

    // First check - cache should be empty (miss)
    const initialCheck = reposCacheService.get(cacheKey);
    expect(initialCheck).toBeNull();

    // Jordan loads repositories (simulating online fetch)
    reposCacheService.set(cacheKey, MOCK_REPOS);

    /**
     * ASSERTION 1: Data should be cached successfully
     */
    const cachedData = reposCacheService.get(cacheKey);
    expect(cachedData).not.toBeNull();
    expect(cachedData?.data).toHaveLength(2);
    expect(cachedData?.data[0].name).toBe('payment-service');

    /**
     * STEP 2: Train enters tunnel - Jordan goes offline
     * But can still access the cached repository data!
     */
    console.log('🚇 Train entered tunnel - offline mode activated');

    // Jordan tries to access the same data (cache hit!)
    const offlineData = reposCacheService.get(cacheKey);

    /**
     * ASSERTION 2: Cached data should still be available offline
     */
    expect(offlineData).not.toBeNull();
    expect(offlineData?.data).toHaveLength(2);
    expect(offlineData?.data[1].name).toBe('user-auth');
    expect(offlineData?.isStale).toBe(false); // Fresh cache

    /**
     * ASSERTION 3: Different query parameters should miss cache
     * (Jordan tries different sort order - not cached)
     */
    const differentSortKey = { ...cacheKey, sort: 'pushed' };
    const differentSort = reposCacheService.get(differentSortKey);
    expect(differentSort).toBeNull();

    /**
     * STEP 3: Jordan clears old cache to free memory
     * (Good practice for long sessions)
     */
    console.log('🧹 Clearing cache for user...');
    reposCacheService.invalidateUser(TEST_USER_ID);

    const afterClear = reposCacheService.get(cacheKey);
    expect(afterClear).toBeNull();

    /**
     * STEP 4: Jordan checks cache stats for monitoring
     */
    const stats = reposCacheService.getStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('active');
    expect(stats).toHaveProperty('stale');

    /**
     * FINAL VERIFICATION: Jordan's offline workflow completed successfully
     * ✅ Loaded repositories while online (cached)
     * ✅ Accessed cached data offline (cache hit)
     * ✅ Verified cache behavior (miss for different params)
     * ✅ Cleared cache to free memory
     * ✅ Monitored cache stats
     *
     * Jordan can now work offline and stay productive!
     */
    console.log("✅ Jordan's offline repository review workflow completed successfully");
  });

  it('should handle cache expiration correctly', async () => {
    /**
     * Tests cache TTL behavior
     * Coverage: Cache expiration, stale data detection
     */

    /**
     * THE STORY: "Cache refresh after stale data"
     *
     * Jordan cached some repositories an hour ago. Now they want to check for
     * updates. The cache service should detect that the data is stale and
     * indicate a refresh is needed.
     */

    const cacheKey = {
      userId: TEST_USER_ID,
      page: 1,
      per_page: 20,
      sort: 'updated',
    };

    // Set data with very short TTL (10ms for testing)
    reposCacheService.set(cacheKey, MOCK_REPOS, 10);

    // Immediately, cache should be fresh
    let cached = reposCacheService.get(cacheKey);
    expect(cached).not.toBeNull();
    expect(cached?.isStale).toBe(false);

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 20));

    // After expiration, cache should still return data (for fast load)
    // but marked as stale
    cached = reposCacheService.get(cacheKey);
    expect(cached).not.toBeNull(); // Still returns data
    expect(cached?.isStale).toBe(true); // But marked as stale

    /**
     * This test demonstrates how you would test TTL when implemented:
     * 1. Set data with short TTL
     * 2. Wait for expiration
     * 3. Verify cache returns null or indicates staleness
     */
  });

  it('should support multiple users with isolated caches', async () => {
    /**
     * Tests multi-user cache isolation
     * Coverage: User isolation, cache key generation
     */

    /**
     * THE STORY: "Team members working independently"
     *
     * Jordan and Alex are both using the platform. Jordan's cached repositories
     * should not interfere with Alex's cache. Each user gets their own isolated
     * cache space.
     */

    const JORDAN_ID = 'jordan@example.com';
    const ALEX_ID = 'alex@example.com';

    const jordanRepos = [MOCK_REPOS[0]];
    const alexRepos = [MOCK_REPOS[1]];

    const jordanKey = {
      userId: JORDAN_ID,
      page: 1,
      per_page: 20,
      sort: 'updated',
    };

    const alexKey = {
      userId: ALEX_ID,
      page: 1,
      per_page: 20,
      sort: 'updated',
    };

    // Jordan caches their repos
    reposCacheService.set(jordanKey, jordanRepos);

    // Alex caches their repos
    reposCacheService.set(alexKey, alexRepos);

    /**
     * ASSERTION: Each user should get their own cached data
     */
    const jordanCache = reposCacheService.get(jordanKey);
    const alexCache = reposCacheService.get(alexKey);

    expect(jordanCache?.data[0].name).toBe('payment-service');
    expect(alexCache?.data[0].name).toBe('user-auth');

    /**
     * ASSERTION: Clearing one user's cache doesn't affect the other
     */
    reposCacheService.invalidateUser(JORDAN_ID);

    expect(reposCacheService.get(jordanKey)).toBeNull();
    expect(reposCacheService.get(alexKey)).not.toBeNull();

    /**
     * ✅ User cache isolation works correctly
     * ✅ Jordan and Alex can work independently
     */
    console.log('✅ Multi-user cache isolation verified');
  });
});
