/**
 * Test Database Helper - Local SQLite for Tests (local-first)
 *
 * Provides utilities for testing against the SAME local SQLite substrate the PC
 * runtime uses in production (SqliteDbAdapter). This is the only test-database
 * harness — the local-first runtime persists everything on local SQLite.
 *
 * Architecture:
 * - Each adapter is backed by a UNIQUE throwaway temp dir, so every test is
 *   isolated by construction (no shared database, no cleanup needed).
 * - Single-user scoping is enforced by SqliteDbAdapter's `user_id` filtering
 *   (there is no RLS). Tests pass an `authToken` per request exactly as before.
 *
 * Usage:
 *   const { adapter, userId, authToken } = await createTestDbAdapter();
 *   // ... run tests ...
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateAuthToken } from '@vgit2/shared/jwt';

import { SqliteDbAdapter } from '../../../src/db/SqliteDbAdapter/index.js';

import type { DbAdapter } from '../../../src/db/DbAdapter.js';

// Local test JWT secret (matches the value preloaded in tests/setup/preload.ts).
export const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

// Counter for generating unique IDs within this process
let uniqueIdCounter = 0;

/** Allocate a fresh, isolated temp dir for one SQLite-backed test adapter. */
function makeTempDataDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `portable-test-${Date.now()}-${++uniqueIdCounter}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export class TestDatabaseHelper {
  private static instance: TestDatabaseHelper;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): TestDatabaseHelper {
    if (!this.instance) {
      this.instance = new TestDatabaseHelper();
    }
    return this.instance;
  }

  /**
   * Generate a unique test user ID for test isolation
   * Format: test-{timestamp}-{counter}-{random}@example.com
   */
  generateTestUserId(): string {
    const timestamp = Date.now();
    const counter = ++uniqueIdCounter;
    const random = Math.random().toString(36).substring(2, 8);
    return `test-${timestamp}-${counter}-${random}@example.com`;
  }

  /**
   * Generate a JWT for a specific user ID
   * @param userId - The user email to generate JWT for
   * @returns JWT token string
   */
  generateTestJWT(userId: string): string {
    return generateAuthToken(
      {
        userId: `user_${userId}`,
        username: 'testuser',
        email: userId,
        githubToken: 'test_github_token_12345',
      },
      JWT_SECRET
    );
  }

  /**
   * Create a test database adapter backed by a unique temp SQLite dir.
   *
   * @param testUserId - Unique email for this test (used in the JWT sub claim)
   * @returns Configured SqliteDbAdapter + the test JWT
   */
  async createTestAdapter(testUserId: string): Promise<{ adapter: DbAdapter; authToken: string }> {
    const authToken = this.generateTestJWT(testUserId);
    const dir = makeTempDataDir();
    const adapter = new SqliteDbAdapter(dir, dir);
    await adapter.initialize();
    return { adapter, authToken };
  }

  /**
   * No-op in the SQLite substrate: the local-first allowlist is the hardcoded
   * ALLOWED_EMAILS list (no remote allowed_users table). Kept for call-site
   * compatibility with older tests.
   */
  async addTestUserToAllowlist(_userId: string): Promise<void> {
    // intentionally empty — no remote allowlist in local-first
  }

  /**
   * No-op in the SQLite substrate: every adapter uses a throwaway temp dir, so
   * there is no shared database to clean between tests. Kept for compatibility.
   */
  async cleanTestData(_userId: string): Promise<void> {
    // intentionally empty — per-test temp dirs provide isolation
  }

  /**
   * Always available: the SQLite substrate has no external dependency to probe.
   * (There is no network reachability race for the local SQLite test database.)
   */
  async verifyConnection(_timeoutMs: number = 2000): Promise<boolean> {
    return true;
  }
}

/**
 * Convenience function for tests
 * Creates a unique test user ID
 */
export function createTestUserId(): string {
  return TestDatabaseHelper.getInstance().generateTestUserId();
}

/**
 * Convenience function for tests
 * Creates a SQLite-backed test adapter with a UNIQUE user ID + temp dir + auth
 * token. Each call is fully isolated (fresh temp database).
 */
export async function createTestDbAdapter(): Promise<{
  adapter: DbAdapter;
  userId: string;
  authToken: string;
}> {
  const helper = TestDatabaseHelper.getInstance();
  const userId = helper.generateTestUserId();
  const authToken = helper.generateTestJWT(userId);
  const dir = makeTempDataDir();
  const adapter = new SqliteDbAdapter(dir, dir);
  await adapter.initialize();
  return { adapter, userId, authToken };
}

/**
 * Helper function for async test timing
 * Polls for messages until expected count is reached or timeout
 */
export async function waitForMessages<T>(
  getMessages: () => Promise<T[]>,
  minCount: number = 1,
  timeoutMs: number = 1000
): Promise<T[]> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const messages = await getMessages();
    if (messages.length >= minCount) return messages;
    await new Promise((r) => setTimeout(r, 50));
  }
  // One final attempt
  const finalMessages = await getMessages();
  if (finalMessages.length >= minCount) return finalMessages;
  throw new Error(
    `Timeout: expected ${minCount} messages, got ${finalMessages.length} after ${timeoutMs}ms`
  );
}

/**
 * Helper to wait for a specific condition with polling
 */
export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number = 1000,
  pollIntervalMs: number = 50
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  // Final check
  if (await condition()) return true;
  throw new Error(`Timeout: condition not met after ${timeoutMs}ms`);
}
