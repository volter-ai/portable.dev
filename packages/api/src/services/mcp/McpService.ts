import { debugLog } from '@vgit2/shared/constants';

import { PlaywrightMcpConfig } from './config/PlaywrightMcpConfig.js';
import { RunConnectionMcpServer } from './servers/RunConnectionMcpServer.js';
import { StandardMcpServer } from './servers/StandardMcpServer.js';
import { McpValidator } from './utils/McpValidator.js';
import { getAgentSetup } from '../../config/agentRegistry.js';
import { MCP_REGISTRY, checkMcpRequirements } from '../../config/McpRegistry.js';

import type { ToolExecutionContext } from '../../tools/types.js';
import type { ChatService } from '../ChatService.js';
import type { ConnectionsService } from '../ConnectionsService.js';
import type { GitLocalService } from '../GitLocalService.js';
import type { TunnelService } from '../TunnelService.js';

/**
 * McpService handles MCP (Model Context Protocol) server configuration
 *
 * Responsibilities:
 * - Configure MCP servers (Playwright, GitHub tools)
 * - Define custom MCP tools (start_claude_code_chat, request_user_secrets, etc.)
 * - Build MCP server configuration for Claude Agent SDK
 *
 * This service is injected into ClaudeService to keep MCP configuration
 * separate from session management and streaming logic.
 */
export class McpService {
  constructor(
    private playwrightConfig: PlaywrightMcpConfig,
    private standardServer: StandardMcpServer,
    private runConnectionServer: RunConnectionMcpServer,
    private mcpValidator: McpValidator,
    private gitLocalService?: GitLocalService,
    private tunnelService?: TunnelService,
    private chatService?: ChatService,
    private connectionsService?: ConnectionsService
  ) {
    debugLog('[McpService] 🚀 Environment: LOCAL');

    // No MCP is token-gated. MCP availability is validated against local env
    // (Chromium) at startup and again per chat session.
    debugLog('[McpService] Initialized with configuration:', {
      environment: 'local',
      tunnels: 'Cloudflare Quick Tunnels (on-demand dev-server tunnels)',
      playwright: true,
    });
  }

  /**
   * Check MCP availability at server startup (informational only - does not crash server)
   *
   * Delegates to McpValidator
   */
  public validateMcpServers(): void {
    this.mcpValidator.validateMcpServers();
  }

  /**
   * Build complete MCP servers configuration for Claude Agent SDK
   * Combines all MCP servers: GitHub tools, Playwright, Google Drive, Slack
   * Filters MCPs based on agentSetup.mcpServers configuration
   *
   * @param params.agentSetupId - Agent setup ID to determine which MCPs to enable
   */
  public async buildAllMcpServers(params: {
    toolContext: ToolExecutionContext;
    repoPath: string;
    userId: string;
    chatId: string;
    playwrightDevice: 'mobile' | 'desktop';
    agentSetupId?: string; // Optional agent setup ID for MCP filtering (defaults to 'freestyle')
  }): Promise<{
    mcpServers: any;
    tunnelMappings: Array<{ port: number; url: string }>;
  }> {
    const {
      toolContext,
      repoPath,
      userId,
      chatId,
      playwrightDevice,
      agentSetupId = 'freestyle', // Default to freestyle if not provided
    } = params;

    // Get agent setup for MCP filtering
    const agentSetup = getAgentSetup(agentSetupId);
    console.log(`[McpService] Using agent setup: ${agentSetup.id} (${agentSetup.name})`);
    console.log(`[McpService] Enabled MCPs: ${agentSetup.mcpServers.join(', ')}`);

    // VALIDATION: Check that all required MCPs (defaultEnabled: true) are available
    // This prevents chat creation if essential MCPs are missing
    console.log('[McpService] Validating required MCPs for chat session...');
    const missingRequiredMcps: string[] = [];

    for (const [id, metadata] of Object.entries(MCP_REGISTRY)) {
      if (metadata.defaultEnabled) {
        const { available, missingEnv } = checkMcpRequirements(id);

        if (!available) {
          const missing = [...missingEnv].join(', ');
          missingRequiredMcps.push(`${metadata.name} (missing: ${missing})`);
          console.error(
            `[McpService] ❌ Required MCP "${metadata.name}" is not available: ${missing}`
          );
        } else {
          console.log(`[McpService] ✓ Required MCP "${metadata.name}" is available`);
        }
      }
    }

    // If any required MCPs are missing, fail chat creation
    if (missingRequiredMcps.length > 0) {
      const errorMessage = `Cannot create chat session - required MCPs are not available:\n${missingRequiredMcps.map((m) => `  - ${m}`).join('\n')}\n\nPlease ensure you are logged in with the necessary permissions.`;
      console.error(`[McpService] ${errorMessage}`);
      throw new Error(errorMessage);
    }

    console.log('[McpService] ✓ All required MCPs are available - proceeding with chat creation');

    console.log('[McpService] 🔍 buildAllMcpServers() called');

    // 1. GitHub tools removed - system now uses gh CLI exclusively
    // No MCP server created for GitHub operations - users call gh CLI via bash

    // 2. Build Playwright MCP config (creates dev-server tunnels on demand)
    const { config: playwrightConfig, tunnelMappings } =
      await this.playwrightConfig.buildPlaywrightConfig({
        userId,
        chatId,
        repoPath,
        playwrightDevice,
      });

    // Google Drive and Slack are user connections managed by ConnectionsService
    // They're accessed via the run-connection MCP server, not as separate MCPs

    // 7. Create Standard MCP server (always available)
    const standardMcpServer = {
      standard: this.standardServer.createServer(toolContext),
    };

    // 8. Create Run Connection MCP server if ConnectionsService available
    let runConnectionMcpServer: any = {};
    if (this.connectionsService) {
      // CRITICAL: authToken is required to return the user's connections
      if (!toolContext.authToken) {
        console.error('[McpService] ⚠️  CRITICAL: No authToken in toolContext!');
        console.error('[McpService]    getUserConnections will return 0 results without it.');
        console.error(
          '[McpService]    User connections will NOT be available in run-connection MCP.'
        );
        console.error(
          '[McpService]    Check that authToken is being passed through the request chain.'
        );
      }

      // Fetch user's connected services to dynamically generate the connections schema
      const userConnections = await this.connectionsService.getUserConnections({
        userId,
        authToken: toolContext.authToken,
      });

      // Filter to only SDK connections (exclude CLI connections like AWS CLI, Fly.io CLI, GitHub, etc.)
      const sdkConnections = userConnections.filter((c) => c.serviceType === 'sdk');
      const connectionSummary = sdkConnections.map((c) => ({
        connectionName: c.connectionId,
        service: c.service,
      }));

      runConnectionMcpServer = {
        'run-connection': this.runConnectionServer.createServer(toolContext, connectionSummary),
      };
    } else {
      console.log(
        '[McpService] Skipping Run Connection MCP server - ConnectionsService not available'
      );
    }

    // 9. Combine all MCP servers
    // Note: Google Drive, Slack, GitHub are accessed via run-connection, not as separate MCPs
    const allMcpServers = {
      ...playwrightConfig,
      ...standardMcpServer,
      ...runConnectionMcpServer,
    };

    // 10. Filter MCPs based on agentSetup.mcpServers configuration
    const filteredMcpServers: any = {};
    const availableMcpIds = Object.keys(allMcpServers);

    console.log(`[McpService] Available MCPs before filtering: ${availableMcpIds.join(', ')}`);

    for (const mcpId of agentSetup.mcpServers) {
      if (allMcpServers[mcpId]) {
        filteredMcpServers[mcpId] = allMcpServers[mcpId];
      } else {
        console.warn(
          `[McpService] AgentSetup '${agentSetup.id}' enables MCP '${mcpId}' but it's not available`
        );
      }
    }

    const filteredMcpIds = Object.keys(filteredMcpServers);
    const excludedMcpIds = availableMcpIds.filter((id) => !filteredMcpIds.includes(id));

    console.log(`[McpService] Filtered MCPs (enabled): ${filteredMcpIds.join(', ')}`);
    if (excludedMcpIds.length > 0) {
      console.log(`[McpService] Excluded MCPs (not in agent setup): ${excludedMcpIds.join(', ')}`);
    }

    return { mcpServers: filteredMcpServers, tunnelMappings };
  }

  /**
   * Validate that all custom MCPs are registered in MCP_REGISTRY
   *
   * Delegates to McpValidator
   *
   * @throws Error if validation fails
   */
  public validateMcpRegistrySync(): void {
    this.mcpValidator.validateMcpRegistrySync();
  }
}
