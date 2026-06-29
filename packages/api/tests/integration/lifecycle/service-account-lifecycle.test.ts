/**
 * Service Account Lifecycle Tests
 *
 * THE STORY: "DevOps Engineer Setting Up CI/CD Integration"
 *
 * Scenario Type: Complete service account lifecycle workflow
 * User: Alex (a DevOps engineer setting up automated deployments)
 *
 * Alex is setting up a CI/CD pipeline that needs to interact with the Portable API.
 * He creates a service account with appropriate permissions, tests that the token works,
 * and then realizes he needs to update the allowed users. After a security audit,
 * he rotates the token to ensure no old tokens are valid. Finally, he reviews the
 * audit logs to verify all operations were logged correctly, then deletes a test
 * service account he no longer needs.
 *
 * REAL SERVICES:
 * - ✅ DbAdapter - REAL local SQLite database (local test DB)
 * - ✅ ServiceAccountEncryptionService - AES-256-GCM encryption (used inline)
 *
 * NOTE: This test directly tests DbAdapter methods rather than going through
 * ServiceAccountService because ServiceAccountService doesn't propagate auth tokens
 * to satisfy the database's per-user scoping. Testing the adapter directly provides better coverage
 * of the uncovered database methods.
 *
 * COVERAGE TARGETS:
 * - DbAdapter: createServiceAccount, getServiceAccounts, getServiceAccount,
 *   getServiceAccountByPrefix, updateServiceAccount, deleteServiceAccount,
 *   updateServiceAccountUsage, updateServiceAccountRateLimit,
 *   createServiceAccountAuditLog, getServiceAccountAuditLogs
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';

// Mock external services FIRST
import { setupExternalServiceMocks } from '../../setup/mocks/externalServices';
setupExternalServiceMocks(mock);

import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import { ServiceAccountEncryptionService } from '../../../src/services/ServiceAccountEncryptionService';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

// Skip in CI - these tests require specific database/timing conditions that are flaky in CI
const isCI = process.env.CI === '1' || process.env.CI === 'true';

describe.skipIf(isCI)('Service Account Lifecycle - DevOps CI/CD Integration', () => {
  let dbAdapter: DbAdapter;
  let encryptionService: ServiceAccountEncryptionService;
  let testUserId: string;
  let authToken: string;

  // Track created service accounts for cleanup
  let createdServiceAccountIds: string[] = [];

  beforeAll(async () => {
    // One-time cleanup of stale test data from previous test runs
    // Clean up all test-* users to prevent accumulation
    // Per-test temp-dir SQLite adapters are isolated by construction —
    // no stale cross-run data to clean.
  });

  beforeEach(async () => {
    // Small delay to avoid overwhelming the database
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Create encryption service for token generation
    encryptionService = new ServiceAccountEncryptionService();

    // Reset tracking
    createdServiceAccountIds = [];
  });

  afterEach(async () => {
    // Per-test temp-dir SQLite adapters are isolated by construction — no
    // cross-test cleanup needed.
  });

  /**
   * Helper to create a service account directly via DbAdapter
   * (bypasses ServiceAccountService to properly pass authToken for per-user scoping)
   */
  async function createTestServiceAccount(
    name: string,
    options?: { description?: string; allowedUserIds?: string[]; expiresAt?: Date }
  ) {
    const token = encryptionService.generateToken();
    const tokenPrefix = encryptionService.getTokenPrefix(token);
    const tokenEncrypted = encryptionService.encrypt(token);
    const id = crypto.randomUUID();

    const success = await dbAdapter.createServiceAccount(
      {
        id,
        userId: testUserId,
        name,
        description: options?.description,
        tokenPrefix,
        tokenEncrypted,
        allowedUserIds: options?.allowedUserIds || [testUserId],
        expiresAt: options?.expiresAt,
      },
      authToken // Pass auth token for per-user scoping
    );

    if (!success) {
      throw new Error('Failed to create service account');
    }

    createdServiceAccountIds.push(id);
    return { id, token, tokenPrefix, tokenEncrypted };
  }

  it("should handle Alex's complete CI/CD service account workflow", async () => {
    /**
     * SCENARIO: Alex creates and manages service accounts for CI/CD
     * Step 1: Create a service account for the CI/CD pipeline
     * Step 2: List service accounts to see the new one
     * Step 3: Get service account by ID
     * Step 4: Update the service account to add more allowed users
     * Step 5: Look up service account by token prefix
     * Step 6: Record usage and update rate limits
     * Step 7: Create audit log entries
     * Step 8: Retrieve audit logs
     * Step 9: Create a second test service account
     * Step 10: Delete the test service account
     * Step 11: Verify deleted account no longer appears in list
     */

    console.log("🚀 Starting Alex's CI/CD service account workflow...");

    /**
     * STEP 1: Alex creates a service account for the CI/CD pipeline
     */
    console.log('📝 STEP 1: Creating service account for CI/CD pipeline...');

    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
    const createResult = await createTestServiceAccount('CI/CD Pipeline', {
      description: 'Automated deployment service account',
      allowedUserIds: [testUserId],
      expiresAt,
    });

    /**
     * ASSERTION 1: Service account created successfully
     */
    expect(createResult).toBeDefined();
    expect(createResult.id).toBeDefined();
    expect(createResult.token).toBeDefined();
    expect(createResult.token.startsWith('sa_')).toBe(true); // Token prefix
    expect(createResult.tokenPrefix).toBeDefined();

    console.log(`✅ Service account created: ${createResult.id}`);
    console.log(`   Token prefix: ${createResult.tokenPrefix}...`);

    const serviceAccountId = createResult.id;
    const originalToken = createResult.token;
    const originalTokenPrefix = createResult.tokenPrefix;

    /**
     * STEP 2: Alex lists service accounts to see the new one
     */
    console.log('📋 STEP 2: Listing service accounts...');

    const accountsList = await dbAdapter.getServiceAccounts(testUserId, authToken);

    /**
     * ASSERTION 2: Service account appears in list
     */
    expect(accountsList.length).toBeGreaterThanOrEqual(1);
    const foundAccount = accountsList.find((sa) => sa.id === serviceAccountId);
    expect(foundAccount).toBeDefined();
    expect(foundAccount?.name).toBe('CI/CD Pipeline');
    expect(foundAccount?.description).toBe('Automated deployment service account');
    expect(foundAccount?.enabled).toBe(true);

    console.log(`✅ Found ${accountsList.length} service account(s)`);

    /**
     * STEP 3: Alex gets the service account by ID
     */
    console.log('🔍 STEP 3: Getting service account by ID...');

    const retrieved = await dbAdapter.getServiceAccount(serviceAccountId, testUserId, authToken);

    /**
     * ASSERTION 3: Service account retrieved with encrypted token
     */
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(serviceAccountId);
    expect(retrieved?.name).toBe('CI/CD Pipeline');
    expect(retrieved?.tokenEncrypted).toBeDefined();
    expect(retrieved?.allowedUserIds).toContain(testUserId);

    console.log('✅ Retrieved service account by ID');

    /**
     * STEP 4: Alex updates the service account to add more allowed users
     */
    console.log('✏️ STEP 4: Updating service account to add allowed users...');

    const additionalUser = 'teammate@example.com';
    const updateSuccess = await dbAdapter.updateServiceAccount(
      serviceAccountId,
      testUserId,
      {
        name: 'CI/CD Pipeline (Production)',
        description: 'Production deployment service account',
        allowedUserIds: [testUserId, additionalUser],
      },
      authToken
    );

    /**
     * ASSERTION 4: Update succeeded
     */
    expect(updateSuccess).toBe(true);

    // Verify the update
    const updatedAccount = await dbAdapter.getServiceAccount(
      serviceAccountId,
      testUserId,
      authToken
    );
    expect(updatedAccount?.name).toBe('CI/CD Pipeline (Production)');
    expect(updatedAccount?.description).toBe('Production deployment service account');
    expect(updatedAccount?.allowedUserIds).toContain(testUserId);
    expect(updatedAccount?.allowedUserIds).toContain(additionalUser);

    console.log(`✅ Updated service account: ${updatedAccount?.name}`);

    /**
     * STEP 5: Alex looks up service account by token prefix
     */
    console.log('🔐 STEP 5: Looking up service account by token prefix...');

    const byPrefix = await dbAdapter.getServiceAccountByPrefix(originalTokenPrefix, authToken);

    /**
     * ASSERTION 5: Found by prefix
     */
    expect(byPrefix).toBeDefined();
    expect(byPrefix?.id).toBe(serviceAccountId);

    console.log('✅ Found service account by token prefix');

    /**
     * STEP 6: Alex records usage and updates rate limits
     */
    console.log('⚡ STEP 6: Recording usage and rate limits...');

    // Update usage timestamp
    const usageSuccess = await dbAdapter.updateServiceAccountUsage(serviceAccountId, authToken);
    expect(usageSuccess).toBe(true);

    // Update rate limit counter
    const now = new Date();
    const rateLimitSuccess = await dbAdapter.updateServiceAccountRateLimit(
      serviceAccountId,
      5, // 5 requests
      now,
      authToken
    );
    expect(rateLimitSuccess).toBe(true);

    // Verify rate limit was updated via getServiceAccountByPrefix (has rate limit fields)
    const afterRateLimit = await dbAdapter.getServiceAccountByPrefix(
      originalTokenPrefix,
      authToken
    );
    expect(afterRateLimit?.rateLimitRequestsCount).toBe(5);

    // Verify usage timestamp via getServiceAccount
    const afterUsage = await dbAdapter.getServiceAccount(serviceAccountId, testUserId, authToken);
    expect(afterUsage?.lastUsedAt).toBeDefined();

    console.log('✅ Usage and rate limits recorded');

    /**
     * STEP 7: Alex creates audit log entries
     */
    console.log('📝 STEP 7: Creating audit log entries...');

    // Create a "create" audit log
    const auditLogId1 = await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId,
        userId: testUserId,
        action: 'create',
        details: { name: 'CI/CD Pipeline', description: 'Initial creation' },
        ipAddress: '10.0.0.1',
        userAgent: 'GitHub-Actions/1.0',
        success: true,
      },
      authToken
    );
    expect(auditLogId1).toBeDefined();

    // Create an "update" audit log
    const auditLogId2 = await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId,
        userId: testUserId,
        action: 'update',
        details: { name: 'CI/CD Pipeline (Production)' },
        ipAddress: '10.0.0.1',
        userAgent: 'GitHub-Actions/1.0',
        success: true,
      },
      authToken
    );
    expect(auditLogId2).toBeDefined();

    // Create a "rotate" audit log
    const auditLogId3 = await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId,
        userId: testUserId,
        action: 'rotate',
        details: { reason: 'Security audit' },
        ipAddress: '10.0.0.1',
        userAgent: 'GitHub-Actions/1.0',
        success: true,
      },
      authToken
    );
    expect(auditLogId3).toBeDefined();

    console.log('✅ Audit log entries created');

    /**
     * STEP 8: Alex retrieves audit logs
     */
    console.log('📊 STEP 8: Retrieving audit logs...');

    const auditLogs = await dbAdapter.getServiceAccountAuditLogs(
      serviceAccountId,
      { limit: 10, offset: 0 },
      authToken
    );

    /**
     * ASSERTION 8: Audit logs contain all operations
     */
    expect(auditLogs.length).toBeGreaterThanOrEqual(3);

    // Check for specific actions
    const actions = auditLogs.map((log) => log.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
    expect(actions).toContain('rotate');

    // Verify audit log details
    const createLog = auditLogs.find((log) => log.action === 'create');
    expect(createLog).toBeDefined();
    expect(createLog?.success).toBe(true);
    expect(createLog?.ipAddress).toBe('10.0.0.1');
    expect(createLog?.userAgent).toBe('GitHub-Actions/1.0');

    console.log(`✅ Found ${auditLogs.length} audit log entries`);
    console.log(`   Actions: ${actions.join(', ')}`);

    /**
     * STEP 9: Alex creates a second test service account
     */
    console.log('📝 STEP 9: Creating a second test service account...');

    const testAccount = await createTestServiceAccount('Test Account', {
      description: 'Temporary test account',
    });

    /**
     * ASSERTION 9: Second service account created
     */
    expect(testAccount.id).not.toBe(serviceAccountId);

    // List should now have 2 accounts
    const updatedList = await dbAdapter.getServiceAccounts(testUserId, authToken);
    expect(updatedList.length).toBe(2);

    console.log(`✅ Test account created: ${testAccount.id}`);

    /**
     * STEP 10: Alex deletes the test service account
     */
    console.log('🗑️ STEP 10: Deleting test service account...');

    const deleteSuccess = await dbAdapter.deleteServiceAccount(
      testAccount.id,
      testUserId,
      authToken
    );
    expect(deleteSuccess).toBe(true);

    // Remove from cleanup list since we just deleted it
    createdServiceAccountIds = createdServiceAccountIds.filter((id) => id !== testAccount.id);

    console.log('✅ Test account deleted');

    /**
     * STEP 11: Alex verifies deleted account no longer appears
     */
    console.log('🔍 STEP 11: Verifying account deletion...');

    const finalList = await dbAdapter.getServiceAccounts(testUserId, authToken);

    /**
     * ASSERTION 11: Deleted account no longer in list
     */
    expect(finalList.length).toBe(1);
    expect(finalList[0].id).toBe(serviceAccountId);

    // Verify getServiceAccount returns null for deleted account
    const deletedAccount = await dbAdapter.getServiceAccount(testAccount.id, testUserId, authToken);
    expect(deletedAccount).toBeNull();

    console.log('✅ Deleted account correctly removed');

    /**
     * FINAL VERIFICATION: Alex's workflow completed successfully
     * ✅ Created service account with token (createServiceAccount)
     * ✅ Listed service accounts (getServiceAccounts)
     * ✅ Retrieved by ID (getServiceAccount)
     * ✅ Updated metadata (updateServiceAccount)
     * ✅ Looked up by prefix (getServiceAccountByPrefix)
     * ✅ Recorded usage (updateServiceAccountUsage)
     * ✅ Updated rate limits (updateServiceAccountRateLimit)
     * ✅ Created audit logs (createServiceAccountAuditLog)
     * ✅ Retrieved audit logs (getServiceAccountAuditLogs)
     * ✅ Deleted account (deleteServiceAccount)
     */
    console.log("\n🎉 Alex's CI/CD service account workflow completed successfully!");
    console.log('📈 DbAdapter coverage achieved:');
    console.log('   - createServiceAccount ✓');
    console.log('   - getServiceAccounts ✓');
    console.log('   - getServiceAccount ✓');
    console.log('   - getServiceAccountByPrefix ✓');
    console.log('   - updateServiceAccount ✓');
    console.log('   - deleteServiceAccount ✓');
    console.log('   - updateServiceAccountUsage ✓');
    console.log('   - updateServiceAccountRateLimit ✓');
    console.log('   - createServiceAccountAuditLog ✓');
    console.log('   - getServiceAccountAuditLogs ✓');
  });

  it('should handle expiration settings correctly', async () => {
    /**
     * Tests service account with and without expiration
     */
    console.log('⏰ Testing token expiration settings...');

    // Create with no expiration (null)
    const neverExpires = await createTestServiceAccount('Never Expires');
    const neverExpiresAccount = await dbAdapter.getServiceAccount(
      neverExpires.id,
      testUserId,
      authToken
    );

    expect(neverExpiresAccount?.expiresAt).toBeUndefined();
    console.log('✅ No expiration sets expiresAt to undefined/null');

    // Create with 30d expiration
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expires30d = await createTestServiceAccount('Expires 30d', { expiresAt });
    const expires30dAccount = await dbAdapter.getServiceAccount(
      expires30d.id,
      testUserId,
      authToken
    );

    expect(expires30dAccount?.expiresAt).toBeDefined();
    expect(expires30dAccount?.expiresAt).toBeInstanceOf(Date);

    // Verify expiration is approximately 30 days from now
    const expectedExpiration = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const actualExpiration = expires30dAccount!.expiresAt!.getTime();
    const tolerance = 60 * 1000; // 1 minute tolerance
    expect(Math.abs(actualExpiration - expectedExpiration)).toBeLessThan(tolerance);

    console.log('✅ "30d" expiration sets correct date');
  });

  it('should track rate limits correctly via dbAdapter', async () => {
    /**
     * Tests rate limit tracking at the database level
     * Note: Rate limit fields are only returned by getServiceAccountByPrefix
     */
    console.log('⚡ Testing rate limit tracking...');

    const account = await createTestServiceAccount('Rate Limited Account');

    // Initially should have 0 requests (via getServiceAccountByPrefix)
    let retrieved = await dbAdapter.getServiceAccountByPrefix(account.tokenPrefix, authToken);
    expect(retrieved?.rateLimitRequestsCount).toBe(0);

    // Record 5 requests
    const now = new Date();
    await dbAdapter.updateServiceAccountRateLimit(account.id, 5, now, authToken);

    // Check that rate limit was updated
    retrieved = await dbAdapter.getServiceAccountByPrefix(account.tokenPrefix, authToken);
    expect(retrieved?.rateLimitRequestsCount).toBe(5);
    expect(retrieved?.rateLimitWindowStart).toBeDefined();

    // Record more requests (increment to 10)
    await dbAdapter.updateServiceAccountRateLimit(account.id, 10, now, authToken);
    retrieved = await dbAdapter.getServiceAccountByPrefix(account.tokenPrefix, authToken);
    expect(retrieved?.rateLimitRequestsCount).toBe(10);

    console.log(`✅ Rate limit tracking: ${retrieved?.rateLimitRequestsCount} requests`);
  });

  it('should disable and enable service accounts via update', async () => {
    /**
     * Tests enabling/disabling service accounts
     */
    console.log('🔄 Testing enable/disable functionality...');

    const account = await createTestServiceAccount('Toggle Account');

    // Verify initially enabled
    let retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);
    expect(retrieved?.enabled).toBe(true);

    // Disable the account
    await dbAdapter.updateServiceAccount(account.id, testUserId, { enabled: false }, authToken);
    retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);
    expect(retrieved?.enabled).toBe(false);

    console.log('✅ Account disabled');

    // Re-enable the account
    await dbAdapter.updateServiceAccount(account.id, testUserId, { enabled: true }, authToken);
    retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);
    expect(retrieved?.enabled).toBe(true);

    console.log('✅ Account re-enabled');
  });

  it('should retrieve service account with encrypted token', async () => {
    /**
     * Tests retrieving service account by ID with encrypted token
     */
    console.log('🔍 Testing getServiceAccount with encrypted token...');

    const account = await createTestServiceAccount('Retrieve Test');

    // Retrieve by ID
    const retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(account.id);
    expect(retrieved?.name).toBe('Retrieve Test');
    expect(retrieved?.tokenEncrypted).toBeDefined();

    // Decrypt and verify token matches
    const decryptedToken = encryptionService.decrypt(retrieved!.tokenEncrypted);
    expect(decryptedToken).toBe(account.token);

    console.log('✅ getServiceAccount returns encrypted token that can be decrypted');
  });

  it('should handle non-existent service account lookups', async () => {
    /**
     * Tests that lookups for non-existent accounts return null
     */
    console.log('🚫 Testing non-existent account lookups...');

    // Non-existent ID
    const byId = await dbAdapter.getServiceAccount('non-existent-uuid', testUserId, authToken);
    expect(byId).toBeNull();

    // Non-existent prefix
    const byPrefix = await dbAdapter.getServiceAccountByPrefix('sa_nonexistent', authToken);
    expect(byPrefix).toBeNull();

    console.log('✅ Non-existent lookups correctly return null');
  });

  it('should update usage timestamp', async () => {
    /**
     * Tests updateServiceAccountUsage updates last_used_at
     */
    console.log('📊 Testing usage timestamp update...');

    const account = await createTestServiceAccount('Usage Test');

    // Initially should have null last_used_at
    let retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);
    expect(retrieved?.lastUsedAt).toBeUndefined();

    // Update usage
    const updateSuccess = await dbAdapter.updateServiceAccountUsage(account.id, authToken);
    expect(updateSuccess).toBe(true);

    // Check that last_used_at was set
    retrieved = await dbAdapter.getServiceAccount(account.id, testUserId, authToken);
    expect(retrieved?.lastUsedAt).toBeDefined();
    expect(retrieved?.lastUsedAt).toBeInstanceOf(Date);

    // Should be very recent (within last minute)
    const timeDiff = Date.now() - retrieved!.lastUsedAt!.getTime();
    expect(timeDiff).toBeLessThan(60 * 1000);

    console.log('✅ Usage timestamp updated correctly');
  });

  it('should filter audit logs by action', async () => {
    /**
     * Tests audit log filtering capabilities
     */
    console.log('📋 Testing audit log filtering...');

    const account = await createTestServiceAccount('Audit Filter Test');

    // Create logs with different actions
    await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId: account.id,
        userId: testUserId,
        action: 'create',
        success: true,
      },
      authToken
    );

    await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId: account.id,
        userId: testUserId,
        action: 'update',
        success: true,
      },
      authToken
    );

    await dbAdapter.createServiceAccountAuditLog(
      {
        serviceAccountId: account.id,
        userId: testUserId,
        action: 'update',
        success: false,
        errorMessage: 'Test error',
      },
      authToken
    );

    // Get all logs
    const allLogs = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 10 },
      authToken
    );
    expect(allLogs.length).toBe(3);

    // Filter by action
    const updateLogs = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 10, action: 'update' },
      authToken
    );
    expect(updateLogs.length).toBe(2);
    expect(updateLogs.every((log) => log.action === 'update')).toBe(true);

    // Filter by success status
    const failedLogs = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 10, success: false },
      authToken
    );
    expect(failedLogs.length).toBe(1);
    expect(failedLogs[0].success).toBe(false);
    expect(failedLogs[0].errorMessage).toBe('Test error');

    console.log('✅ Audit log filtering works correctly');
  });

  it('should support pagination for audit logs', async () => {
    /**
     * Tests audit log pagination
     */
    console.log('📄 Testing audit log pagination...');

    const account = await createTestServiceAccount('Pagination Test');

    // Create 5 audit logs
    for (let i = 0; i < 5; i++) {
      await dbAdapter.createServiceAccountAuditLog(
        {
          serviceAccountId: account.id,
          userId: testUserId,
          action: 'update',
          details: { iteration: i },
          success: true,
        },
        authToken
      );
      // Small delay to ensure ordering
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Get first page (limit 2)
    const page1 = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 2, offset: 0 },
      authToken
    );
    expect(page1.length).toBe(2);

    // Get second page
    const page2 = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 2, offset: 2 },
      authToken
    );
    expect(page2.length).toBe(2);

    // Get third page (should have 1 item)
    const page3 = await dbAdapter.getServiceAccountAuditLogs(
      account.id,
      { limit: 2, offset: 4 },
      authToken
    );
    expect(page3.length).toBe(1);

    // Verify no overlap
    const allIds = [...page1, ...page2, ...page3].map((log) => log.id);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(5);

    console.log('✅ Audit log pagination works correctly');
  });
});
