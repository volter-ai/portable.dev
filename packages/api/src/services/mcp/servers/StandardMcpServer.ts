import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { convertJsonSchemaToZod } from '@vgit2/shared/mcp';

import { standardTools, executeStandardTool } from '../../../tools/standard/index.js';

import type { ToolExecutionContext } from '../../../tools/types.js';

/**
 * StandardMcpServer
 *
 * Factory for creating Standard utility tools MCP server.
 * Handles image/video analysis, tunneling, and secrets management.
 *
 * NOTE: request_user_secrets tool is defined in packages/api/src/tools/standard/request-user-secrets.ts
 * and is imported via standardTools array
 */
export class StandardMcpServer {
  /**
   * Create MCP server with standard utility tools
   * Returns an MCP server object that can be passed to the query() options
   *
   * Standard tools include: image/video analysis, tunneling, and secrets management
   *
   * NOTE: request_user_secrets tool is defined in packages/api/src/tools/standard/request-user-secrets.ts
   * and is imported via standardTools array
   */
  public createServer(toolContext: ToolExecutionContext) {
    console.log('[StandardMcpServer] Creating Standard MCP server...');

    // Convert standard tools to MCP tool definitions using factory
    const mcpTools = standardTools.map((standardTool) => {
      // Use factory function for JSON Schema → Zod conversion
      const zodSchema = convertJsonSchemaToZod(standardTool.inputSchema);

      return tool(
        standardTool.name,
        standardTool.description || '',
        zodSchema as any,
        async (args) => {
          const result = await executeStandardTool(standardTool.name, args, toolContext);
          return {
            content: result.content,
          };
        }
      );
    });

    // Standard MCP server created successfully
    console.log(`[StandardMcpServer] Standard MCP server created with ${mcpTools.length} tools`);

    return createSdkMcpServer({
      name: 'standard',
      version: '1.0.0',
      tools: mcpTools,
      // SDK 0.3.142+ connects MCP servers in the background by default and may
      // defer tools behind tool search. These are in-process custom tools the
      // session relies on from turn 1 — keep them eagerly loaded.
      alwaysLoad: true,
    });
  }
}
