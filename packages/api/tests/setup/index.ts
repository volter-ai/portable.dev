/**
 * Test Setup - Main entry point for all test utilities
 *
 * Import from here for all test infrastructure needs:
 *   import { TestEmitter, testChats, testMessages, createTestDbAdapter } from '../setup';
 *
 * Architecture:
 * - helpers/ - Test utilities (TestEmitter, TestContextBuilder, database helpers)
 * - mocks/ - Service mocks for external dependencies (only actively used mocks)
 * - fixtures/ - Test data factories (chats, messages, users)
 *
 * Philosophy: Mock external services (Anthropic API, GitHub API), test real internal logic
 */

// Test Helpers
export { TestEmitter } from './helpers/TestEmitter';
export { TestContextBuilder } from './helpers/testContext';
export { TestDatabaseHelper, createTestUserId, createTestDbAdapter } from './helpers/testDatabase';
export { createSimpleTestClaudeService } from './helpers/testClaudeService';

// Mocks (only actively used)
export {
  mockQueryImplementation,
  query,
  MockProcessTrackerService,
  MockTunnelService,
} from './mocks';

// Test Fixtures
export {
  // Chats
  createStoredChat,
  createChat,
  createChatListItem,
  testChats,

  // Messages
  createBufferedMessage,
  createChatMessage,
  createContentBlock,
  testMessages,
  testBlocks,

  // Users
  createUserInfo,
  createSessionData,
  createAllowedUser,
  testUsers,
} from './fixtures';
