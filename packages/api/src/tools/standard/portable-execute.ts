/**
 * portable_execute - Execute TypeScript code with access to the Portable SDK
 *
 * This tool gives Claude programmatic access to the local Portable instance,
 * allowing operations like listing chats, getting messages, checking runtime state, etc.
 */

import { PortableSDK } from '../../services/PortableSDK.js';
import { ToolExecutionContext, ToolResult } from '../types.js';

export const portableExecuteTool = {
  name: 'portable_execute',

  description: `Execute TypeScript code with access to the Portable SDK.

The 'portable' object is available in your code with these methods:

## Chat Operations
- portable.chat.list({ limit?, status? }) - List all chats
- portable.chat.get(chatId) - Get chat details
- portable.chat.create({ owner, repo, message, agent_setup_id, model?, title? }) - Create new chat with initial message (starts execution)
- portable.chat.getMessages(chatId, { limit?, offset? }) - Get chat messages as array (supports slicing: .slice(-5) for last 5, etc.)
- portable.chat.send(chatId, message) - Send message to chat and start Claude execution
- portable.chat.archive(chatId) - Archive a chat

## Project Operations
- portable.projects.list() - List local projects (based on chat activity)
- portable.projects.get(projectPath) - Get project details
- portable.projects.getRecent(limit?) - Get recently accessed projects

## Runtime Operations
- portable.runtime.getState() - Get full runtime state (tunnels)
- portable.runtime.getTunnels() - List active tunnels

## User Operations
- portable.user.getInfo() - Get current user/session info
- portable.user.getSecrets() - List user secrets (values masked)
- portable.user.setSecret(key, value) - Set a secret
- portable.user.getConnections() - List user connections (Slack, etc.)

## Context Operations
- portable.context.getCurrentChat() - Get current chat
- portable.context.getCurrentRepo() - Get current repo path
- portable.context.getModel() - Get current model setting

## Example
\`\`\`typescript
// List recent projects and their chat counts
const projects = await portable.projects.getRecent(5);
const chats = await portable.chat.list();

const projectChatCounts = projects.map(p => ({
  name: p.name,
  chatCount: chats.filter(c => c.repo_path?.includes(p.name)).length
}));

return { projects: projectChatCounts };
\`\`\`
`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string',
        description: "TypeScript code to execute. The 'portable' SDK client is available.",
      },
      description: {
        type: 'string',
        description: 'Optional description of what the code does',
      },
    },
    required: ['code'],
  },

  execute: async (
    input: { code: string; description?: string },
    context: ToolExecutionContext
  ): Promise<ToolResult> => {
    console.log(
      `[portable_execute] Executing code${input.description ? `: ${input.description}` : ''}`
    );

    try {
      // Validate required services
      if (!context.chatService) {
        throw new Error('ChatService not available in context');
      }

      // Create SDK instance with injected services
      const portable = new PortableSDK(
        {
          chatService: context.chatService,
          tunnelService: context.tunnelService,
          secretsService: context.secretsService,
          chatExecutionService: context.chatExecutionService,
          connectionsService: context.connectionsService,
          emitter: context.emitter, // Pass emitter for real-time notifications
        },
        {
          userId: context.userId,
          chatId: context.chatId,
          authToken: context.authToken || '',
          repoPath: context.repoPath,
          model: context.model,
        }
      );

      // Execute user code with portable SDK available
      // Using AsyncFunction to allow await in the code
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction(
        'portable',
        'console',
        `"use strict";
        ${input.code}`
      );

      const result = await fn(portable, console);

      console.log(`[portable_execute] Execution completed successfully`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error(`[portable_execute] Error:`, error);

      return {
        content: [
          {
            type: 'text',
            text: `Error executing Portable SDK code: ${error.message}\n\nStack: ${error.stack || 'No stack trace'}`,
          },
        ],
      };
    }
  },
};
