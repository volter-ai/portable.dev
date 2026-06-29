/**
 * Test ClaudeService Factory - Real ClaudeService with Mocked SDK
 *
 * Creates real ClaudeService instances for testing with only the external
 * @anthropic-ai/claude-agent-sdk mocked.
 *
 * Philosophy:
 * - ✅ Mock external services → Mock query() from claude-agent-sdk
 * - ✅ Test real internal logic → Use real ClaudeService
 * - ✅ Full integration test → Complete flows through ClaudeService
 *
 * This allows tests to verify:
 * - Session management
 * - System prompt generation
 * - Runtime state formatting
 * - Token adapter integration
 * - MCP service configuration
 *
 * Usage:
 *   const { claudeService, mcpService, tokenAdapter } = await createTestClaudeService(testUserId, authToken);
 *   // Use real ClaudeService in tests
 */

import { ClaudeService } from '../../../src/services/ClaudeService.js';
import { McpService } from '../../../src/services/mcp/McpService.js';
import { ChatService } from '../../../src/services/ChatService.js';
import { generateAuthToken } from '@vgit2/shared/jwt';
import { PlaywrightMcpConfig } from '../../../src/services/mcp/config/PlaywrightMcpConfig.js';
import { StandardMcpServer } from '../../../src/services/mcp/servers/StandardMcpServer.js';
import { RunConnectionMcpServer } from '../../../src/services/mcp/servers/RunConnectionMcpServer.js';
import { McpValidator } from '../../../src/services/mcp/utils/McpValidator.js';

// Local test JWT secret (must match testDatabase.ts)
const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

export interface TestClaudeServiceConfig {
  userId: string;
  username?: string;
  githubToken?: string;
  googleDriveToken?: string;
  googleRefreshToken?: string;
  chatService: ChatService;
  connectionsService?: any; // Optional ConnectionsService for run-connection MCP
}

export interface TestClaudeServiceResult {
  claudeService: ClaudeService;
  mcpService: McpService;
  authToken: string;
}

/**
 * Create a real ClaudeService for testing
 *
 * @param config - Configuration for the test ClaudeService
 * @returns ClaudeService, McpService, and auth token
 */
export async function createTestClaudeService(
  config: TestClaudeServiceConfig
): Promise<TestClaudeServiceResult> {
  const {
    userId,
    username = 'testuser',
    githubToken = 'test_github_token_12345',
    googleDriveToken,
    googleRefreshToken,
    chatService,
    connectionsService,
  } = config;

  // Set JWT_SECRET in environment for token generation
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = JWT_SECRET;

  try {
    // Generate test JWT with tokens
    const authToken = generateAuthToken({
      userId: `user_${userId}`,
      username,
      email: userId,
      githubToken,
      googleDriveToken,
      googleRefreshToken,
    });

    // Create MCP dependencies
    const npxDetector = {
      detectNpxCommand: () => 'npx',
      getCommand: () => 'npx',
      verifyNpxAvailable: () => {}, // No-op for tests
    } as any; // Mock NpxCommandDetector
    const playwrightConfig = new PlaywrightMcpConfig(npxDetector, undefined, true);
    const standardServer = new StandardMcpServer();
    const runConnectionServer = new RunConnectionMcpServer(connectionsService);

    const mcpValidator = new McpValidator();

    // Create real McpService with all dependencies
    const mcpService = new McpService(
      playwrightConfig,
      standardServer,
      runConnectionServer,
      mcpValidator,
      undefined, // gitLocalService
      undefined, // tunnelService
      chatService,
      connectionsService
    );

    // Create real ClaudeService
    const claudeService = new ClaudeService(
      chatService,
      mcpService,
      undefined, // claudeCodeSessions
      undefined, // _containerService
      undefined, // gitLocalService
      undefined, // tunnelService
      undefined, // processTrackerService
      undefined, // secretsService
      connectionsService // connectionsService for run-connection support
    );

    return {
      claudeService,
      mcpService,
      authToken,
    };
  } finally {
    // Restore original JWT_SECRET
    if (originalSecret) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  }
}

/**
 * Simplified factory for common test scenarios
 * Creates ClaudeService with default test tokens
 */
export async function createSimpleTestClaudeService(
  userId: string,
  chatService: ChatService
): Promise<TestClaudeServiceResult> {
  return createTestClaudeService({
    userId,
    chatService,
  });
}
