/**
 * Test Preload File
 *
 * This file is automatically loaded before all tests via bunfig.toml.
 * It sets up critical mocks and environment variables BEFORE any test code runs.
 *
 * CRITICAL: SDK Mock Setup
 * ES modules are hoisted - all static imports resolve BEFORE any code runs.
 * When test files import helpers like testClaudeService.ts, those helpers
 * import ClaudeService.ts, which imports the SDK. By the time mock.module()
 * runs in the test file, the real SDK is already loaded.
 *
 * By setting up the mock here in the preload file, it's in place BEFORE any
 * test file (and their transitive imports) are loaded.
 *
 * IMPORTANT: The imports in this file (bun:test, mockClaudeAgentSDK, globalFetchMock)
 * do NOT transitively import @vgit2/shared/constants, so the env var loop below
 * runs BEFORE constants.ts is ever loaded (which happens when test files load).
 *
 * What this does:
 * - Sets environment variables to match CI EXACTLY (for consistent behavior)
 * - Sets up @anthropic-ai/claude-agent-sdk mock BEFORE any modules load
 * - Installs a fetch interceptor that blocks external API calls
 * - Returns mock responses for common external APIs (GitHub, Google, Slack, etc.)
 * - Throws clear error messages when unmocked external APIs are called
 */

// =============================================================================
// SDK Mock Setup - MUST be done BEFORE any test code imports ClaudeService
// =============================================================================
// Import mock.module from bun:test - this is safe in preload as of Bun 1.0+
import os from 'os';
import path from 'path';

import { mock } from 'bun:test';

// Import the shared mock implementation (has no SDK imports, safe to load early)
import { query as mockQuery } from './mocks/mockClaudeAgentSDK';

// Set up the SDK mock BEFORE any module that imports it is loaded
// This is the key fix for ES module hoisting issues
// IMPORTANT: Must export ALL values that are imported from the SDK (not just types)
// - ClaudeService imports: query, AgentDefinition (value)
// - McpService imports: tool, createSdkMcpServer
// - AskUserMcpServer imports: createSdkMcpServer
console.log('[Test Preload] Setting up @anthropic-ai/claude-agent-sdk mock...');
console.log('[Test Preload] mockQuery type:', typeof mockQuery);
console.log(
  '[Test Preload] mockQuery is generator function:',
  mockQuery?.constructor?.name === 'GeneratorFunction'
);

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  console.log('[Test Preload] Mock module factory executing for @anthropic-ai/claude-agent-sdk');
  return {
    query: mockQuery,
    tool: (schema: any) => schema,
    createSdkMcpServer: (config: any) => ({
      ...config,
      close: () => {},
    }),
    // AgentDefinition is imported as a value (not type) by ClaudeService
    // It's used as: Record<string, AgentDefinition>
    // Provide an empty object/class to satisfy the import
    AgentDefinition: class AgentDefinition {},
  };
});

console.log('[Test Preload] @anthropic-ai/claude-agent-sdk mock configured');

// =============================================================================
// Global Fetch Mock
// =============================================================================
// Import and auto-install the global fetch mock
// The import itself triggers installGlobalFetchMock() via side effect
import './mocks/globalFetchMock';

// =============================================================================
// CI Environment Variables - Set AFTER imports but BEFORE test files load
// =============================================================================
// These are set after our preload imports (which don't load constants.ts)
// but BEFORE test files are loaded (which DO load constants.ts)
// This ensures getEnv() in constants.ts reads our test values from process.env

const CI_ENV_VARS: Record<string, string> = {
  // CI detection
  CI: '1',
  NO_COLOR: '1',

  // Local JWT signing secret for tests (the api validates with verifyAuthToken).
  JWT_SECRET: 'super-secret-jwt-token-with-at-least-32-characters-long',

  // OAuth credentials for testing (not real - just to generate redirect URLs)
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  SLACK_CLIENT_ID: 'test-slack-client-id',
  SLACK_CLIENT_SECRET: 'test-slack-client-secret',
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-client-secret',

  // OAuth service URL - must match the mocked URL in globalFetchMock.ts
  // FORCE-SET: This must override any .env value for tests to work
  GITHUB_APP_SERVICE_URL: 'https://this-is-not-a-real-url.github-app-service-mock.modal.run',

  // Clerk credentials for testing
  CLERK_SECRET_KEY: 'sk_test_placeholder',
  CLERK_PUBLISHABLE_KEY: 'pk_test_placeholder',

  // Playwright MCP availability - the local-first gate keys on a resolvable Chromium
  // (checkMcpRequirements() truthy-checks PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, not its existence).
  // McpService validates this before allowing chat creation; without it, agent-setup tests fail locally.
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/test/chromium',

  // rev9 D27: the per-user workspace layer is COLLAPSED (getUserWorkspaceDir now
  // returns WORKSPACE_DIR directly). Tests that clone into / rm getUserWorkspaceDir
  // would otherwise hit the operator's REAL ~/claude-workspace repos root. Pin
  // WORKSPACE_DIR to a unique tmp dir for the whole test process — set BEFORE
  // constants.ts loads so the frozen WORKSPACE_DIR const picks it up. This restores
  // the test isolation the per-user subdir used to provide.
  WORKSPACE_DIR: path.join(os.tmpdir(), `portable-test-workspace-${process.pid}`),
};

// Env vars that MUST be force-set (override .env values)
const FORCE_SET_VARS = [
  'GITHUB_APP_SERVICE_URL',
  'JWT_SECRET', // local JWT signing secret for tests (verifyAuthToken)
  'WORKSPACE_DIR', // rev9 D27: override the operator's .env so tests never touch the real workspace
];

// Apply CI environment variables
for (const [key, value] of Object.entries(CI_ENV_VARS)) {
  if (FORCE_SET_VARS.includes(key)) {
    // Force-set these to ensure tests use the mocked values
    process.env[key] = value;
  } else if (!process.env[key]) {
    process.env[key] = value;
  }
}

// Log that preload is active (BEFORE suppressing console output)
if (process.env.DEBUG || process.env.CI) {
  console.log('[Test Preload] ========================================');
  console.log('[Test Preload] Preload executed successfully');
  console.log('[Test Preload] Bun version:', process.versions.bun || 'unknown');
  console.log('[Test Preload] Environment variables set:');
  console.log('[Test Preload]   JWT_SECRET:', process.env.JWT_SECRET);
  console.log('[Test Preload]   CI:', process.env.CI);
  console.log('[Test Preload] Global fetch mock installed - external API calls will be blocked');
  console.log('[Test Preload] ========================================');
}

// Suppress console output during tests to reduce noise
// Error handling code paths log errors which are expected during error scenario tests
// Set DEBUG=true to see all console output
if (!process.env.DEBUG) {
  const noop = () => {};
  console.log = noop;
  console.error = noop;
  console.warn = noop;
  console.info = noop;

  if (process.env.CI) {
    // In CI, keep console.log for important messages but suppress others
    // This ensures test output shows important logs like preload confirmation
  }
}
