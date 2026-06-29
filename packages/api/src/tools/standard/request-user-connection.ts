import type { ToolExecutionContext, ToolResult } from '../types.js';

// ============================================================================
// REQUEST USER CONNECTION TOOL
// ============================================================================
// This tool requests a service connection from the user.
// Use this when you need credentials for a service like Modal, AWS, Fly.io, etc.
//
// What this tool does:
// 1. Sends a connection request to the client
// 2. Opens the profile settings page and connection modal automatically
// 3. User connects the service through the modal
// 4. After connection succeeds, sends confirmation back to chat
// ============================================================================

/**
 * Request User Connection Tool
 *
 * Requests a service connection from the user. The client will navigate to the profile settings
 * page and open the connection modal for the requested service. After the user successfully
 * connects, a confirmation message is sent back to the chat so the AI can continue.
 */
export const requestUserConnectionTool = {
  name: 'request_user_connection',
  description:
    "Request a service connection from the user (e.g., Modal, AWS, Fly.io, Slack, Linear, Notion, Google Drive, Gmail). **CRITICAL: Use this tool when:** (1) The execute_code tool fails with an error about missing connections, OR (2) The user needs access to a CLI tool (aws-cli, flyio-cli, modal-cli) but hasn't connected it yet, OR (3) You need to use a service SDK (slack, linear, notion, google-drive, gmail) but the connection doesn't exist in the execute_code tool's available connections list. **WORKFLOW:** (1) First check if the connection exists in execute_code's available connections list. (2) If missing, call this tool to request the connection. (3) The user will be navigated to connection settings to authenticate. (4) After successful connection, you'll receive confirmation and can proceed with execute_code.",
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description:
          "The service identifier to request (e.g., 'modal-cli', 'aws-cli', 'flyio-cli', 'slack', 'linear'). Must match a service ID from the available services list.",
        enum: [
          'modal-cli',
          'aws-cli',
          'flyio-cli',
          'slack',
          'linear',
          'notion',
          'google-drive',
          'gmail',
          'apify',
        ],
      },
      reason: {
        type: 'string',
        description:
          "User-friendly explanation of why this connection is needed (e.g., 'To deploy your application to Modal', 'To access your AWS resources')",
      },
      required: {
        type: 'boolean',
        description: 'Whether this connection is required to proceed (default: true)',
      },
    },
    required: ['service', 'reason'],
  },
  execute: async (input: any, context: ToolExecutionContext): Promise<ToolResult> => {
    const { service, reason, required = true } = input;

    // Send connection request to the client (navigates user to profile settings + opens modal)
    if (context.ws) {
      context.ws.send(
        JSON.stringify({
          type: 'request_user_connection',
          chat_id: context.chatId,
          service,
          reason,
          required,
        })
      );
    }

    const responseText = required
      ? `Requesting ${service} connection from user. Reason: ${reason}. User will be navigated to connection settings to connect.`
      : `Requesting optional ${service} connection from user. Reason: ${reason}. User will be navigated to connection settings if they choose to connect.`;

    return {
      content: [
        {
          type: 'text',
          text: responseText,
        },
      ],
    };
  },
};
