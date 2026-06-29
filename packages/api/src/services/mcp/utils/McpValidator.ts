import { debugLog } from '@vgit2/shared/constants';

import { MCP_REGISTRY, checkMcpRequirements, getMcpMetadata } from '../../../config/McpRegistry.js';

/**
 * McpValidator
 *
 * Handles MCP server validation and registry synchronization.
 */
export class McpValidator {
  /**
   * Check MCP availability at server startup (informational only - does not crash server)
   *
   * This method logs which MCPs are configured and available, but does NOT enforce
   * that they must be present. Actual validation happens per-session when chats are created.
   *
   * Behavior:
   * - Logs available MCPs (helpful for debugging)
   * - Logs missing MCPs as warnings (does not crash)
   * - Required MCPs (defaultEnabled: true) are checked when chat sessions start
   *
   * Why not validate at startup?
   * - Production: User tokens (GITHUB_TOKEN, etc.) only exist after OAuth
   * - Development: User tokens come from session after OAuth login
   * - Different users may have different tokens available
   *
   * Uses MCP_REGISTRY for centralized validation logic
   */
  public validateMcpServers(): void {
    debugLog('[McpValidator] Checking MCP availability (informational only)...');

    const available: string[] = [];
    const unavailable: string[] = [];
    const unavailableRequired: string[] = [];

    for (const [id, metadata] of Object.entries(MCP_REGISTRY)) {
      const { available: isAvailable, missingEnv } = checkMcpRequirements(id);

      if (isAvailable) {
        const requiredLabel = metadata.defaultEnabled ? ' (required)' : ' (optional)';
        available.push(`${metadata.name}${requiredLabel}`);
      } else {
        const missing = [...missingEnv];
        const requiredLabel = metadata.defaultEnabled ? ' (required)' : ' (optional)';
        const entry = `${metadata.name}${requiredLabel}: missing ${missing.join(', ')}`;
        unavailable.push(entry);

        // Track unavailable required MCPs separately for non-DEBUG warning
        if (metadata.defaultEnabled) {
          unavailableRequired.push(entry);
        }
      }
    }

    if (unavailableRequired.length > 0) {
      console.log('[McpValidator] ⚠️  Unavailable MCPs at startup:');
      unavailableRequired.forEach((name) => console.log(`  - ${name}`));
    }
  }

  /**
   * Validate that all custom MCPs are registered in MCP_REGISTRY
   *
   * This ensures the registry and actual instantiation stay in sync.
   * Should be called once at service initialization.
   *
   * @throws Error if validation fails
   */
  public validateMcpRegistrySync(): void {
    // List of all custom MCP IDs that we create in buildAllMcpServers()
    // NOTE: google-drive-tools and slack-tools are NOT in this list
    // because they're managed via ConnectionsService, not MCP_REGISTRY
    const createdCustomMcps = [
      'run-connection', // Run Connection (replaces individual service executors)
    ];

    const missingFromRegistry: string[] = [];

    for (const mcpId of createdCustomMcps) {
      const metadata = getMcpMetadata(mcpId);
      if (!metadata) {
        missingFromRegistry.push(mcpId);
      } else if (metadata.type !== 'custom') {
        console.warn(
          `[McpValidator] WARNING: ${mcpId} is marked as '${metadata.type}' in registry but created as custom MCP`
        );
      }
    }

    if (missingFromRegistry.length > 0) {
      const errorMsg = [
        '❌ MCP Registry validation failed!',
        `The following MCPs are created in buildAllMcpServers() but missing from MCP_REGISTRY:`,
        ...missingFromRegistry.map((id) => `  - ${id}`),
        '',
        'Fix: Add missing entries to packages/shared/src/mcp/McpRegistry.ts',
      ].join('\n');

      throw new Error(errorMsg);
    }

    debugLog(
      `[McpValidator] ✅ MCP Registry validation passed (${createdCustomMcps.length} custom MCPs registered)`
    );
  }
}
