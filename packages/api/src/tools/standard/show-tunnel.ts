import type { ToolExecutionContext, ToolResult } from '../types.js';

// ============================================================================
// SHOW TUNNEL TOOL
// ============================================================================
// Shows existing tunnel information or creates a Cloudflare Quick Tunnel if it
// doesn't exist. Safe to call multiple times - reuses existing tunnels.
// ============================================================================

/**
 * Show Tunnel Tool
 *
 * Display existing tunnel information for a port. Safe to call multiple times - reuses existing tunnels.
 */
export const showTunnelTool = {
  name: 'show_tunnel',
  description: `Display existing tunnel information for a port. Creates a temporary HTTPS tunnel if needed. Use this to show the user tunnel details. Safe to call multiple times - reuses existing tunnels.`,
  inputSchema: {
    type: 'object',
    properties: {
      port: {
        type: 'number',
        description: 'Port number to show tunnel for (e.g., 5173, 3000, 8000)',
      },
      name: {
        type: 'string',
        description:
          "Simple one-word name for the tunnel. Use 'app' or 'site' for single-server projects. Use 'server', 'frontend', 'backend', 'api' for multi-server projects. Examples: 'app', 'site', 'frontend', 'backend', 'server', 'api', 'database'",
      },
      description: {
        type: 'string',
        description:
          "Optional detailed description of what's running (e.g., 'Vite development server', 'Next.js frontend', 'Express API server')",
      },
      main: {
        type: 'boolean',
        description:
          'Set to true to mark this as the main tunnel for the project. Only one tunnel per project can be main. If another tunnel is already main for this project, it will be automatically unset.',
      },
    },
    required: ['port', 'name'],
  },
  execute: async (input: any, context: ToolExecutionContext): Promise<ToolResult> => {
    const { port, name, description, main } = input;

    console.log(
      `[ShowTunnel] port ${port}, name: ${name}, description: ${description || 'none'}, main: ${
        main || false
      }, user: ${context.userId}`
    );

    // Create (or reuse) a Cloudflare Quick Tunnel for the requested port
    if (!context.tunnelService) {
      return {
        content: [
          {
            type: 'text',
            text: `Tunnel service not available. Use localhost URLs with local Playwright instead.`,
          },
        ],
      };
    }

    try {
      console.log(`[ShowTunnel] Creating Cloudflare Quick Tunnel for port ${port}...`);

      // This will return existing tunnel URL if it exists, or create new one
      const tunnelUrl = await context.tunnelService.createLocalTunnel(
        port,
        context.userId,
        context.chatId,
        context.repoPath,
        name,
        description,
        main
      );

      // Emit tunnel event to the client with name, description, and main flag
      if (context.ws) {
        context.ws.send(
          JSON.stringify({
            type: 'tunnel_created',
            chat_id: context.chatId,
            port,
            url: tunnelUrl,
            name,
            description,
            main,
          })
        );
      }

      // Perform health check on the port
      const healthCheck = await context.tunnelService.checkPortHealth(port);

      const descriptionText = description ? `\n\nDescription: ${description}` : '';

      // Generate appropriate message based on health status
      if (healthCheck.healthy) {
        return {
          content: [
            {
              type: 'text',
              text: `✓ Tunnel for port ${port}: ${tunnelUrl}\n\nName: ${name}${descriptionText}\nHealth Status: ✓ HEALTHY (HTTP ${healthCheck.statusCode})\n\nThe tunnel is ready to use.`,
            },
          ],
        };
      } else {
        // Port is unhealthy - generate AI-focused error message
        let errorMessage = `⚠️ ERROR: Tunnel created but port ${port} is NOT accessible\n\nTunnel URL: ${tunnelUrl}\nName: ${name}${descriptionText}\nHealth Check: FAILED - ${healthCheck.error}\n\n`;

        if (healthCheck.error?.includes('404')) {
          errorMessage += `REQUIRED ACTION: The server on port ${port} is returning 404. You must investigate:\n1. Use the Read tool to check if there's an index.html or app entry point\n2. Check the server configuration to see what path it's serving on\n3. Verify the dev server is configured to serve on the root path\n4. Check server logs using the Bash tool to see what routes are available\n\nThe tunnel exists but will not work until the server is properly configured. Do NOT proceed without fixing this issue.`;
        } else if (healthCheck.error?.includes('ECONNREFUSED')) {
          errorMessage += `CRITICAL: No server is listening on port ${port}. You must immediately:\n1. Check what processes are running using: lsof -i :${port} or ps aux\n2. Start the development server if it's not running\n3. Verify the server started successfully by checking its logs\n4. Re-test the connection using curl or a browser\n\nDo NOT tell the user the tunnel is ready. The server must be running first.`;
        } else if (healthCheck.error?.includes('timeout')) {
          errorMessage += `REQUIRED ACTION: The server on port ${port} is not responding. Investigate:\n1. Check if the server is stuck or hung - use ps aux to check the process\n2. Verify the server bound to localhost or 0.0.0.0 (not just 127.0.0.1)\n3. Check if there's a firewall blocking the port\n4. Review server startup logs for initialization errors\n\nDo NOT assume the tunnel works. Verify the server is actually serving traffic.`;
        } else if (
          healthCheck.error?.includes('500') ||
          (healthCheck.statusCode && healthCheck.statusCode >= 500)
        ) {
          errorMessage += `IMMEDIATE ACTION REQUIRED: The server is crashing or misconfigured:\n1. Check server error logs immediately using Bash tool\n2. Look for stack traces or error messages\n3. Verify all dependencies are installed (npm/bun install)\n4. Check environment variables are properly configured\n5. Try restarting the server\n\nThe tunnel exists but the application is broken. Fix the server errors before proceeding.`;
        } else {
          errorMessage += `REQUIRED ACTION: The server on port ${port} has an issue. You must:\n1. Check server logs for errors\n2. Verify the server is running and accessible\n3. Test the server locally before using the tunnel\n\nDo NOT proceed until the server is confirmed working.`;
        }

        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
        };
      }
    } catch (error: any) {
      console.error('[ShowTunnel] show_tunnel error:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Failed to show tunnel: ${error.message}`,
          },
        ],
      };
    }
  },
};
