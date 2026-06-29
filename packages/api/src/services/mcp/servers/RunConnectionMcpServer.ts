import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { convertJsonSchemaToZod } from '@vgit2/shared/mcp';
import { z } from 'zod';

import { requestUserConnectionTool } from '../../../tools/standard/request-user-connection.js';
import { RunConnectionService } from '../../RunConnectionService.js';

import type { ConnectionsService } from '../../ConnectionsService.js';

/**
 * RunConnectionMcpServer
 *
 * Factory for creating Run Connection MCP server.
 * Provides unified code executor with connections.
 *
 * This is the FUTURE unified executor that will replace individual service executors.
 * For now, it coexists with slack/google-drive executors for backward compatibility.
 * Once fully tested, this will become the primary way to execute code with external services.
 *
 * Uses optimistic execution: declares connections upfront, fails fast if missing
 */
export class RunConnectionMcpServer {
  constructor(private connectionsService?: ConnectionsService) {}

  /**
   * Create MCP server with Run Connection
   * Returns an MCP server object that can be passed to the query() options
   *
   * This is the FUTURE unified executor that will replace individual service executors.
   * For now, it coexists with slack/google-drive executors for backward compatibility.
   * Once fully tested, this will become the primary way to execute code with external services.
   *
   * Uses optimistic execution: declares connections upfront, fails fast if missing
   */
  public createServer(
    toolContext: any,
    userConnections: Array<{ connectionName: string; service: string }>
  ) {
    if (!this.connectionsService) {
      throw new Error('ConnectionsService is required for run connection');
    }

    // Build dynamic connections schema based on user's actual connections
    const connectionNames = userConnections.map((c) => c.connectionName);

    // Build a descriptive list showing connection name + service type
    const connectionsWithTypes = userConnections
      .map((c) => `${c.connectionName} (${c.service})`)
      .join(', ');

    // If user has no connections, use a placeholder schema that explains the situation
    const connectionsSchema =
      connectionNames.length > 0
        ? z
            .array(z.enum(connectionNames as [string, ...string[]]))
            .describe(`Connected services to use. Available: ${connectionsWithTypes}`)
        : z
            .array(z.string())
            .describe(
              'No connections available. User needs to connect services first (slack, linear, notion, google-drive).'
            );

    // Build description showing available connections
    const availableConnectionsList =
      userConnections.length > 0
        ? userConnections.map((c) => `- ${c.connectionName} (${c.service})`).join('\n')
        : '(No connections configured - user needs to connect services first)';

    // Build a dynamic example using the first connection if available
    const exampleConnection = userConnections.length > 0 ? userConnections[0] : null;
    const exampleCode = exampleConnection
      ? `execute_code({
  connections: ['${exampleConnection.connectionName}'],
  code: \`
    // The '${exampleConnection.connectionName}' client is available directly
    const result = await ${exampleConnection.connectionName}.someMethod();
    return result;
  \`
})`
      : `// No connections available yet`;

    // Create request_user_connection tool using convertJsonSchemaToZod factory
    const requestConnectionZodSchema = convertJsonSchemaToZod(
      requestUserConnectionTool.inputSchema
    );
    const requestConnectionMcpTool = tool(
      requestUserConnectionTool.name,
      requestUserConnectionTool.description,
      requestConnectionZodSchema as any,
      async (args) => {
        const result = await requestUserConnectionTool.execute(args as any, toolContext);
        return {
          content: result.content,
        };
      }
    );

    // Create unified code executor tool
    const executeCodeMcpTool = tool(
      'execute_code',
      `Execute TypeScript code with authenticated API clients.

**IMPORTANT: Use ONLY the exact connection names listed below.**

**Available Connections:**
${availableConnectionsList}

**Usage:**
\`\`\`typescript
${exampleCode}
\`\`\`

**Notes:**
- The 'connections' parameter MUST use exact names from "Available Connections" above
- Each connection name becomes a variable in your code (e.g., '${exampleConnection?.connectionName || 'my_connection'}' becomes the client)
- Code has access to: connection clients, context object, require(), console`,
      {
        connections: connectionsSchema as any,
        code: z.string().describe('TypeScript code to execute'),
        description: z
          .string()
          .optional()
          .describe('Human-readable description of what the code does'),
      } as any,
      async (args: any) => {
        const availableList =
          userConnections.length > 0
            ? userConnections.map((c) => `  - ${c.connectionName} (${c.service})`).join('\n')
            : '  (none)';

        if (!args.connections || args.connections.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `ERROR: You must specify at least one connection.\n\nAvailable connections:\n${availableList}`,
              },
            ],
          };
        }

        const invalidConnections = args.connections.filter(
          (conn: string) => !connectionNames.includes(conn)
        );
        if (invalidConnections.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `ERROR: Invalid connection(s): ${invalidConnections.join(', ')}\n\nAvailable connections:\n${availableList}`,
              },
            ],
          };
        }

        const executor = new RunConnectionService(this.connectionsService!);

        const result = await executor.execute({
          connections: args.connections,
          code: args.code,
          description: args.description,
          userId: toolContext.userId,
          chatId: toolContext.chatId,
          emitEvent: toolContext.emitEvent,
          authToken: toolContext.authToken,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );

    return createSdkMcpServer({
      name: 'run-connection',
      version: '1.0.0',
      tools: [requestConnectionMcpTool, executeCodeMcpTool],
      // Eagerly load (in-process tools needed from turn 1; SDK 0.3.142+ defers
      // by default).
      alwaysLoad: true,
    });
  }
}
