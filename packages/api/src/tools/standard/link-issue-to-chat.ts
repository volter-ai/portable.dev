import { ToolExecutionContext, ToolResult } from '../types.js';

// ============================================================================
// LINK ISSUE TO CHAT TOOL
// ============================================================================

export const linkIssueToChatTool = {
  name: 'link_issue_to_chat',
  description:
    'Link a GitHub issue to the current chat. This creates a persistent connection between the chat and the issue, displaying the issue information in the chat UI. Pass null as issue_number to unlink the current issue.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: {
        type: 'string',
        description: 'Repository owner (or null to unlink)',
      },
      repo: {
        type: 'string',
        description: 'Repository name (or null to unlink)',
      },
      issue_number: {
        type: ['number', 'null'],
        description: 'Issue number to link, or null to unlink the current issue',
      },
    },
    required: [],
  },
  execute: async (input: any, context: ToolExecutionContext): Promise<ToolResult> => {
    // If issue_number is null, unlink the issue
    if (input.issue_number === null || input.issue_number === undefined) {
      // Send event to unlink issue
      // Note: emitEvent just sends the data object through WebSocket, so we need to include type field
      context.emitEvent('chat:linkIssue', {
        type: 'chat:linkIssue',
        chat_id: context.chatId,
        linkedIssue: null,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                action: 'unlinked',
                message: 'Issue unlinked from this chat',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Validate required fields for linking
    if (!input.owner || !input.repo || !input.issue_number) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: 'owner, repo, and issue_number are required when linking an issue',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Send event to link issue to chat
    // Note: The client will validate issue existence when displaying
    context.emitEvent('chat:linkIssue', {
      type: 'chat:linkIssue',
      chat_id: context.chatId,
      linkedIssue: {
        owner: input.owner,
        repo: input.repo,
        number: input.issue_number,
      },
    });

    // Return success
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              action: 'linked',
              message: `Issue #${input.issue_number} linked to this chat`,
              repository: `${input.owner}/${input.repo}`,
              issue_url: `https://github.com/${input.owner}/${input.repo}/issues/${input.issue_number}`,
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
