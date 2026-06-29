// ============================================================================
// STANDARD TOOLS - CENTRAL EXPORT
// ============================================================================
// This module exports all standard utility tools for development.
// These are general-purpose tools not specific to GitHub API.
// ============================================================================

import { createTunnelTool } from './create-tunnel.js';
import { displayVideoTool } from './display-video.js';
import { linkIssueToChatTool } from './link-issue-to-chat.js';
import { portableExecuteTool } from './portable-execute.js';
import { requestUserSecretsTool } from './request-user-secrets.js';
import { showTunnelTool } from './show-tunnel.js';

export type { ToolExecutionContext, ToolResult } from '../types.js';

// Export all tools in a unified array
export const standardTools = [
  // Display Video Tool (UI display)
  displayVideoTool,

  // Tunnel Tools (localhost exposure)
  createTunnelTool,
  showTunnelTool,

  // Secrets Tool (secure secrets form)
  requestUserSecretsTool,

  // Link Issue to Chat Tool (chat-issue integration)
  linkIssueToChatTool,

  // Portable SDK Tool (programmatic access to local Portable instance)
  portableExecuteTool,
];

// Helper function to execute a tool
export async function executeStandardTool(
  toolName: string,
  input: any,
  context: any
): Promise<any> {
  console.log(`[StandardTool] ${toolName} called with:`, JSON.stringify(input, null, 2));

  const tool = standardTools.find((t) => t.name === toolName);

  if (!tool) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  try {
    const result = await tool.execute(input, context);
    console.log(`[StandardTool] ${toolName} completed successfully`);
    console.log(`[StandardTool] ${toolName} FULL RESPONSE:`);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error: any) {
    console.error(`[StandardTool] ${toolName} error:`, error);

    // Send error to the client if context has emitEvent
    if (context.emitEvent) {
      context.emitEvent('tool:error', {
        chatId: context.chatId,
        tool: toolName,
        error: {
          message: error.message,
          code: error.status || 'UNKNOWN_ERROR',
        },
      });
    }

    // Return error to agent
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: {
                message: error.message,
                code: error.status || 'UNKNOWN_ERROR',
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
}
