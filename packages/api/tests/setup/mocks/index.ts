/**
 * Test Mocks - Export all mock implementations
 *
 * Only includes mocks that are actively used in tests.
 * Unused mocks have been removed to reduce maintenance burden.
 */

// Global fetch mock - blocks ALL external API calls via native fetch()
// This is automatically installed via preload.ts, but can also be imported directly
export {
  installGlobalFetchMock,
  restoreGlobalFetch,
  addMockResponse,
  isGlobalFetchMockInstalled,
} from './globalFetchMock';

// External service mocks (Anthropic API)
export { mockQueryImplementation, query } from './mockClaudeAgentSDK';

// Peripheral service mocks (not core to chat flow)
export { MockProcessTrackerService } from './MockProcessTrackerService';
export { MockTunnelService } from './MockTunnelService';
