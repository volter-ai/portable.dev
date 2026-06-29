/**
 * MCP Edge Cases Lifecycle Tests
 *
 * THE STORY: "Developer encounters MCP configuration edge cases"
 *
 * Scenario Type: MCP configuration resilience and error handling
 * User: Alex (a developer working with various MCP configurations)
 *
 * Alex is developing with Portable and encounters various edge cases:
 * - Playwright runs in local mode (no remote CDP endpoint)
 * - Required tokens are not configured
 * - Required MCPs are unavailable
 *
 * These tests verify that the system handles these edge cases gracefully,
 * providing clear error messages and falling back to safe defaults when possible.
 *
 * REAL SERVICES:
 * - ✅ McpService - MCP server configuration and validation
 * - ✅ PlaywrightMcpConfig - Playwright configuration with fallbacks
 * - ✅ McpValidator - MCP validation logic
 *
 * MOCKED EXTERNAL:
 * - 🔴 Slack / Google APIs (via setupAllExternalMocks)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import { createTestClaudeService } from '../../setup/helpers/testClaudeService';
import { NpxCommandDetector } from '../../../src/services/mcp/config/NpxCommandDetector';
import { PlaywrightMcpConfig } from '../../../src/services/mcp/config/PlaywrightMcpConfig';
import { generateAuthToken } from '@vgit2/shared/jwt';
import { ChatService } from '../../../src/services/ChatService';
import { MCP_REGISTRY } from '../../../src/config/McpRegistry';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

describe('MCP Edge Cases - Configuration Resilience', () => {
  let chatService: ChatService;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

  // JWT secret for test token generation (matches testDatabase.ts)
  const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

  beforeEach(async () => {
    // Create unique test user and database adapter
    const { adapter, userId, authToken: token } = await createTestDbAdapter();
    dbAdapter = adapter;
    testUserId = userId;
    authToken = token;

    // Create ChatService with REAL database
    chatService = new ChatService(dbAdapter);
  });

  afterEach(async () => {
    // Clean up test data from REAL database
    await TestDatabaseHelper.getInstance().cleanTestData(testUserId);
  });

  it('should build local Playwright config (no cdpEndpoint)', async () => {
    /**
     * SCENARIO: local-first Playwright MCP config
     *
     * Step 1: Build Playwright config
     * Step 2: Verify Playwright MCP uses local mode (no cdpEndpoint)
     */

    const npxDetector = new NpxCommandDetector();
    const playwrightConfig = new PlaywrightMcpConfig(
      npxDetector,
      true // enablePlaywright
    );

    // Build Playwright config (local mode)
    const { config } = await playwrightConfig.buildPlaywrightConfig({
      userId: testUserId,
      chatId: 'chat-test-001',
      repoPath: '/test/repo',
      playwrightDevice: 'desktop',
    });

    // Verify: Playwright MCP present
    expect(config).toHaveProperty('playwright');

    // Verify: Config uses local mode (no cdpEndpoint in args)
    const playwrightArgs = config.playwright.args;
    expect(playwrightArgs).toBeDefined();
    expect(playwrightArgs.join(' ')).not.toContain('--cdp-endpoint');

    // Verify: Config has viewport-size (desktop local mode)
    expect(playwrightArgs.join(' ')).toContain('--viewport-size');
  });

  it('should NOT block chat creation when no platform tokens are present (local-first)', async () => {
    /**
     * SCENARIO (regression guard): local-first chat with no platform tokens.
     *
     * The launcher-minted JWT carries no platform billing tokens, so chat
     * creation must NOT throw "Cannot create chat session - required MCPs are not
     * available". Playwright stays required and is available here (preload sets
     * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).
     *
     * Step 1: Build a JWT WITHOUT any platform tokens.
     * Step 2: Build MCP servers.
     * Step 3: Verify it RESOLVES (no throw) and the always-available MCP
     *         (standard) is present.
     */
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;

    try {
      // A launcher-minted JWT carries no platform billing tokens.
      generateAuthToken({
        userId: `user_${testUserId}`,
        username: 'testuser',
        email: testUserId,
        // No platform tokens.
      });

      const { mcpService } = await createTestClaudeService({
        userId: testUserId,
        chatService,
        // No platform tokens provided.
      });

      const { mcpServers } = await mcpService.buildAllMcpServers({
        toolContext: {
          userId: testUserId,
          chatId: 'chat-test-001',
          emitEvent: () => {},
          authToken,
        },
        repoPath: '/test/repo',
        userId: testUserId,
        chatId: 'chat-test-001',
        playwrightDevice: 'desktop',
        agentSetupId: 'freestyle',
      });

      const mcpIds = Object.keys(mcpServers);
      // Did not throw → chat creation proceeds.
      expect(mcpIds).toContain('standard');
    } finally {
      if (originalSecret) {
        process.env.JWT_SECRET = originalSecret;
      } else {
        delete process.env.JWT_SECRET;
      }
    }
  });

  it('keeps Playwright and standard required in the MCP registry', () => {
    /**
     * Encodes the local-first product decision directly on the registry (the
     * single source of the required-MCP gate). Playwright stays required (browser
     * automation is core) and `standard` is always available.
     */
    expect(MCP_REGISTRY['playwright'].defaultEnabled).toBe(true);
    expect(MCP_REGISTRY['standard'].defaultEnabled).toBe(true);
  });
});
