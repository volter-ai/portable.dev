import * as fs from 'fs';
import * as path from 'path';

import type { ToolExecutionContext, ToolResult } from '../types.js';

// ============================================================================
// REQUEST USER SECRETS TOOL
// ============================================================================
// This tool requests secrets from the user via a secure file editor.
// Use this when you need API keys, tokens, passwords, or other sensitive values
// that should NOT appear in chat history.
//
// What this tool does:
// 1. Creates the file at file_path if it doesn't exist (with commented template)
// 2. Navigates the user to view the file in the file editor
// 3. User manually edits the file to add their secret values
// ============================================================================

/**
 * Secret Request Item
 */
export interface SecretRequest {
  key: string;
  description: string;
  required?: boolean;
}

/**
 * Request User Secrets Tool
 *
 * Requests secrets from the user via file editor navigation. The file will be created if it doesn't
 * exist (with a commented template), then the user is navigated to edit the file manually in the
 * file viewer where they can securely input their secret values (typically in a .env file).
 */
export const requestUserSecretsTool = {
  name: 'request_user_secrets',
  description:
    "Request secrets from the user via file editor. Use this when you need API keys, tokens, passwords, or other sensitive values that should NOT appear in chat history. WORKFLOW: (1) First use Read tool to check if the file exists and what secrets are already present. (2) Only call this tool for secrets that are actually missing. (3) This tool creates the file if it doesn't exist, or appends missing secrets to existing files. (4) User is navigated to file editor to manually add their secret values.",
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description:
          "The absolute path to the file where secrets should be written (e.g., /path/to/repo/.env). File will be created automatically if it doesn't exist. IMPORTANT: Always check if the file exists first (using Read tool) to see which secrets are already present - only request secrets that are actually missing.",
      },
      secrets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'The environment variable name (e.g., OPENAI_API_KEY)',
            },
            description: {
              type: 'string',
              description: 'User-friendly description of what this secret is for',
            },
            required: {
              type: 'boolean',
              description: 'Whether this secret is required (default: true)',
            },
          },
          required: ['key', 'description'],
        },
        description: 'Array of secrets to request from the user',
      },
    },
    required: ['file_path', 'secrets'],
  },
  execute: async (input: any, context: ToolExecutionContext): Promise<ToolResult> => {
    const { file_path, secrets } = input;

    // SECURITY: Validate file path is within repository
    if (context.repoPath) {
      const normalizedFilePath = path.resolve(file_path);
      const normalizedRepoPath = path.resolve(context.repoPath);

      if (!normalizedFilePath.startsWith(normalizedRepoPath)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: file_path must be within the repository directory. Got: ${file_path}, expected path within: ${context.repoPath}`,
            },
          ],
        };
      }
    }

    // Create file if it doesn't exist
    try {
      const fileExists = fs.existsSync(file_path);

      if (!fileExists) {
        // Ensure parent directory exists
        const dir = path.dirname(file_path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Create file with commented template showing required secrets
        const template = secrets
          .map(
            (secret: { key: string; description: string; required?: boolean }) =>
              `# ${secret.description}${secret.required === false ? ' (optional)' : ''}\n${secret.key}=\n`
          )
          .join('\n');

        fs.writeFileSync(file_path, template, 'utf-8');
        console.log(`[request_user_secrets] Created file with template: ${file_path}`);
      } else {
        // File exists - check which secrets are missing
        const existingContent = fs.readFileSync(file_path, 'utf-8');
        const missingSecrets = secrets.filter(
          (secret: { key: string }) => !existingContent.includes(`${secret.key}=`)
        );

        if (missingSecrets.length > 0) {
          // Append template for missing secrets
          const missingTemplate =
            '\n# Missing environment variables\n' +
            missingSecrets
              .map(
                (secret: { key: string; description: string; required?: boolean }) =>
                  `# ${secret.description}${secret.required === false ? ' (optional)' : ''}\n${secret.key}=\n`
              )
              .join('\n');

          fs.appendFileSync(file_path, missingTemplate, 'utf-8');
          console.log(
            `[request_user_secrets] Appended ${missingSecrets.length} missing secrets to: ${file_path}`
          );
        } else {
          console.log(`[request_user_secrets] All secrets already present in: ${file_path}`);
        }
      }
    } catch (error: any) {
      console.error(`[request_user_secrets] Failed to create file:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: Failed to create file at ${file_path}: ${error.message}`,
          },
        ],
      };
    }

    // Send secrets request to the client (navigates user to file editor)
    if (context.ws) {
      context.ws.send(
        JSON.stringify({
          type: 'request_user_secrets',
          chat_id: context.chatId,
          file_path,
          secrets,
        })
      );
    }

    // Generate response based on what happened
    const fileExists = fs.existsSync(file_path);
    const existingContent = fileExists ? fs.readFileSync(file_path, 'utf-8') : '';
    const missingSecrets = secrets.filter(
      (secret: { key: string }) => !existingContent.includes(`${secret.key}=`)
    );

    let responseText: string;
    if (!fileExists) {
      responseText = `Created ${file_path} with template for ${secrets.length} secrets. User will be navigated to the file editor to add their secret values.`;
    } else if (missingSecrets.length > 0) {
      responseText = `Found existing file at ${file_path}. Appended template for ${missingSecrets.length} missing secrets. User will be navigated to the file editor to add the missing values.`;
    } else {
      responseText = `File at ${file_path} already contains all ${secrets.length} requested secrets. User will be navigated to the file editor to verify/update values if needed.`;
    }

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
