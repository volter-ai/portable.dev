/**
 * Test User Fixtures
 * Factory functions for creating test user data
 */

import type { UserInfo, SessionData, AllowedUser } from '@vgit2/shared/types';

/**
 * Create a UserInfo object with sensible defaults
 */
export function createUserInfo(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    email: 'test@example.com',
    username: 'testuser',
    userId: 'user-test-001',
    onWaitlist: false,
    ...overrides,
  };
}

/**
 * Create a SessionData object with sensible defaults
 */
export function createSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubToken: 'github_pat_test123',
    githubUser: {
      login: 'testuser',
      id: 12345,
      avatar_url: 'https://avatar.example.com/testuser.png',
      email: 'test@example.com',
    },
    userEmail: 'test@example.com',
    userId: 'user-test-001',
    username: 'testuser',
    onWaitlist: false,
    ...overrides,
  };
}

/**
 * Create an AllowedUser object with sensible defaults
 */
export function createAllowedUser(overrides: Partial<AllowedUser> = {}): AllowedUser {
  const now = new Date().toISOString();

  return {
    id: 'allowed-user-001',
    email: 'test@example.com',
    username: 'testuser',
    added_by: 'admin@example.com',
    notes: 'Test user for automated testing',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// Predefined test users for common scenarios

export const testUsers = {
  /**
   * Standard test user with full permissions
   */
  defaultUser: (): UserInfo => createUserInfo({
    email: 'test@example.com',
    username: 'testuser',
    userId: 'user-test-001',
    onWaitlist: false,
  }),

  /**
   * User on waitlist
   */
  waitlistUser: (): UserInfo => createUserInfo({
    email: 'waitlist@example.com',
    username: 'waitlistuser',
    userId: 'user-waitlist-001',
    onWaitlist: true,
  }),

  /**
   * Admin user
   */
  adminUser: (): UserInfo => createUserInfo({
    email: 'admin@example.com',
    username: 'admin',
    userId: 'user-admin-001',
    onWaitlist: false,
  }),

  /**
   * Session with GitHub OAuth
   */
  githubSession: (): SessionData => createSessionData({
    githubToken: 'github_pat_test123',
    githubUser: {
      login: 'testuser',
      id: 12345,
      email: 'test@example.com',
    },
  }),

  /**
   * Session with GitHub + Google Drive
   */
  fullSession: (): SessionData => createSessionData({
    githubToken: 'github_pat_test123',
    githubUser: {
      login: 'testuser',
      id: 12345,
      email: 'test@example.com',
    },
    googleDriveToken: 'google_token_test456',
    googleRefreshToken: 'google_refresh_test789',
    googleUser: {
      email: 'test@example.com',
      name: 'Test User',
    },
  }),

  /**
   * Session with Slack integration
   */
  slackSession: (): SessionData => createSessionData({
    githubToken: 'github_pat_test123',
    slackToken: 'xoxp-slack-token-test',
    slackUser: {
      id: 'U12345',
      name: 'testuser',
    },
    slackTeam: {
      id: 'T12345',
      name: 'Test Workspace',
    },
  }),

  /**
   * Multiple users for testing user isolation
   */
  multipleUsers: (count: number): UserInfo[] => {
    return Array.from({ length: count }, (_, i) => createUserInfo({
      email: `user${i + 1}@example.com`,
      username: `user${i + 1}`,
      userId: `user-test-${i + 1}`,
    }));
  },

  /**
   * Users from different domains
   */
  mixedDomainUsers: (): UserInfo[] => [
    createUserInfo({
      email: 'alice@example.com',
      username: 'alice',
      userId: 'user-alice',
    }),
    createUserInfo({
      email: 'bob@company.com',
      username: 'bob',
      userId: 'user-bob',
    }),
    createUserInfo({
      email: 'charlie@organization.org',
      username: 'charlie',
      userId: 'user-charlie',
    }),
  ],

  /**
   * User with special characters in email (for sanitization testing)
   */
  specialCharUser: (): UserInfo => createUserInfo({
    email: 'user+test@example.com',
    username: 'usertest',
    userId: 'user-special-001',
  }),

  /**
   * Allowed user entry
   */
  allowedUser: (email: string, username: string): AllowedUser => createAllowedUser({
    email,
    username,
    id: `allowed-${username}`,
  }),

  /**
   * Multiple allowed users
   */
  allowedUsers: (count: number): AllowedUser[] => {
    return Array.from({ length: count }, (_, i) => createAllowedUser({
      id: `allowed-user-${i + 1}`,
      email: `allowed${i + 1}@example.com`,
      username: `allowed${i + 1}`,
    }));
  },
};
