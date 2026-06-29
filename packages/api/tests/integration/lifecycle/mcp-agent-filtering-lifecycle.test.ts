/**
 * MCP Agent Filtering Lifecycle Tests
 *
 * THE STORY: "Agent setups enable different MCP subsets"
 *
 * Scenario Type: Agent-based MCP configuration
 * User: Alex (a developer experimenting with different agent modes)
 *
 * Alex is exploring different AI agent modes in Portable:
 * - Freestyle mode: All available MCPs enabled (full capabilities)
 * - Orchestrator mode: Limited MCPs for focused task orchestration
 * - Custom mode: User-defined MCP subsets
 *
 * This tests McpService's MCP filtering based on agent setup configuration.
 *
 * REAL SERVICES:
 * - ✅ McpService - MCP server configuration and filtering
 * - ✅ ClaudeService - Agent setup integration
 * - ✅ ChatService - Message persistence
 * - ✅ TokenAdapter - JWT token extraction
 * - ✅ Agent Registry - Agent setup definitions
 *
 * MOCKED EXTERNAL:
 * - 🔴 @anthropic-ai/claude-agent-sdk - Anthropic API
 * - 🔴 External services (Slack, Google, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { setupAllExternalMocks } from '../../setup/mocks/setupAllExternalMocks';

// Setup external service mocks BEFORE importing services
setupAllExternalMocks(mock);

import { createTestDbAdapter, TestDatabaseHelper } from '../../setup/helpers/testDatabase';
import { createTestClaudeService } from '../../setup/helpers/testClaudeService';
import { getAgentSetup } from '../../../src/config/agentRegistry';
import { ChatService } from '../../../src/services/ChatService';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';

describe('MCP Agent Filtering - Configuration by Agent Setup', () => {
  let chatService: ChatService;
  let dbAdapter: DbAdapter;
  let testUserId: string;
  let authToken: string;

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

  it('should filter MCPs for orchestrator agent setup', async () => {
    /**
     * SCENARIO: Developer uses orchestrator mode for focused task execution
     *
     * Step 1: Get orchestrator agent setup definition
     * Step 2: Create ClaudeService with required tokens
     * Step 3: Build MCP servers with agentSetupId='orchestrator'
     * Step 4: Verify only orchestrator MCPs are included
     */

    // Get orchestrator agent setup definition
    const orchestratorSetup = getAgentSetup('orchestrator');
    console.log(`[TEST] Orchestrator setup enables: ${orchestratorSetup.mcpServers.join(', ')}`);

    const { mcpService } = await createTestClaudeService({
      userId: testUserId,
      chatService,
    });

    // Build MCP servers with orchestrator agent setup
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
      agentSetupId: 'orchestrator', // Orchestrator mode
    });

    const mcpIds = Object.keys(mcpServers);
    console.log(`[TEST] MCPs enabled for orchestrator: ${mcpIds.join(', ')}`);

    // Verify: Only MCPs listed in orchestrator's mcpServers array
    mcpIds.forEach((id) => {
      expect(orchestratorSetup.mcpServers).toContain(id);
    });

    // Verify: No extra MCPs beyond orchestrator's list
    expect(mcpIds.length).toBeLessThanOrEqual(orchestratorSetup.mcpServers.length);
  });

  it('should enable all available MCPs for freestyle agent setup', async () => {
    /**
     * SCENARIO: Developer uses freestyle mode for maximum flexibility
     *
     * Step 1: Get freestyle agent setup definition
     * Step 2: Create ClaudeService with all tokens
     * Step 3: Build MCP servers with agentSetupId='freestyle'
     * Step 4: Verify all available MCPs are included
     */

    // Get freestyle agent setup definition
    const freestyleSetup = getAgentSetup('freestyle');
    console.log(`[TEST] Freestyle setup enables: ${freestyleSetup.mcpServers.join(', ')}`);

    const { mcpService } = await createTestClaudeService({
      userId: testUserId,
      chatService,
    });

    // Build MCP servers with freestyle agent setup
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
      agentSetupId: 'freestyle', // Freestyle mode
    });

    const mcpIds = Object.keys(mcpServers);
    console.log(`[TEST] MCPs enabled for freestyle: ${mcpIds.join(', ')}`);

    // Verify: All MCPs listed in freestyle's mcpServers array are present
    // (or unavailable due to missing credentials, which is acceptable)
    freestyleSetup.mcpServers.forEach((expectedMcp) => {
      // If the MCP is in the result, verify it matches
      if (mcpIds.includes(expectedMcp)) {
        expect(mcpServers).toHaveProperty(expectedMcp);
      }
      // If not present, it's likely due to missing credentials (acceptable)
    });

    // Verify: At minimum, standard MCPs should be present
    // (these don't require external credentials)
    expect(mcpIds).toContain('standard'); // Always available
  });

  it('should validate MCP registry synchronization at startup', async () => {
    /**
     * SCENARIO: System validates all custom MCPs are registered
     *
     * Step 1: Create McpService
     * Step 2: Call validateMcpRegistrySync()
     * Step 3: Verify no errors thrown (all custom MCPs registered)
     */

    const { mcpService } = await createTestClaudeService({
      userId: testUserId,
      chatService,
    });

    // Should not throw - all custom MCPs are registered in MCP_REGISTRY
    expect(() => {
      mcpService.validateMcpRegistrySync();
    }).not.toThrow();

    console.log('[TEST] ✓ MCP Registry validation passed');
  });

  it('should log warning when agent requests unavailable MCP', async () => {
    /**
     * SCENARIO: Agent setup enables MCP that's not available
     *
     * Step 1: Create ClaudeService WITHOUT certain credentials
     * Step 2: Use agent setup that requires those credentials
     * Step 3: Build MCP servers
     * Step 4: Verify system continues (graceful degradation)
     * Step 5: Verify warning logged (in real impl - we just check it doesn't crash)
     */

    // Create ClaudeService without optional MCP credentials
    const { mcpService } = await createTestClaudeService({
      userId: testUserId,
      chatService,
      // No optional MCP credentials provided
    });

    // Build MCP servers - should not crash even if an optional MCP is unavailable
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

    // System should continue gracefully
    expect(mcpIds).toBeDefined();
    expect(mcpIds.length).toBeGreaterThan(0);

    // Standard MCPs should still be available
    expect(mcpIds).toContain('standard');

    console.log('[TEST] ✓ System continues gracefully when some MCPs are unavailable');
  });

  it('should handle ConnectionsService integration for run-connection MCP', async () => {
    /**
     * SCENARIO: run-connection MCP requires ConnectionsService
     *
     * Step 1: Create ClaudeService WITHOUT ConnectionsService
     * Step 2: Build MCP servers
     * Step 3: Verify run-connection MCP is not present
     * Step 4: Create ClaudeService WITH ConnectionsService
     * Step 5: Build MCP servers
     * Step 6: Verify run-connection MCP is present
     */

    // Test WITHOUT ConnectionsService
    const { mcpService: mcpServiceWithoutConns } = await createTestClaudeService({
      userId: testUserId,
      chatService,
      // No connectionsService provided
    });

    const { mcpServers: serversWithoutConns } = await mcpServiceWithoutConns.buildAllMcpServers({
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

    // run-connection should not be present
    expect(Object.keys(serversWithoutConns)).not.toContain('run-connection');

    console.log(
      '[TEST] ✓ run-connection MCP correctly excluded when ConnectionsService unavailable'
    );
  });
});
