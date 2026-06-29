/**
 * PortableSDK - Programmatic access to the local Portable instance
 *
 * This SDK is used by the portable_execute tool to give Claude
 * access to Portable's internal services like chats, projects, runtime, etc.
 *
 * Usage in portable_execute:
 *   const chats = await portable.chat.list();
 *   const projects = await portable.projects.getRecent();
 */

import path from 'node:path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import type { ChatExecutionService } from './ChatExecutionService.js';
import type { ChatService } from './ChatService.js';
import type { ConnectionsService } from './ConnectionsService.js';
import type { IOutputEmitter } from './emitters/IOutputEmitter.js';
import type { SecretsService } from './SecretsService.js';
import type { TunnelService } from './TunnelService.js';

// Rate limiter for cross-chat execution
const crossChatRateLimiter = new Map<string, number[]>();

function checkRateLimit(userId: string, windowMs: number = 60000, maxCalls: number = 5): void {
  const now = Date.now();
  const key = `cross-chat:${userId}`;

  // Get existing timestamps, filter out old ones
  const timestamps = (crossChatRateLimiter.get(key) || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= maxCalls) {
    throw new Error(
      `Cross-chat rate limit (${maxCalls}/${windowMs / 1000}s) exceeded. Please wait.`
    );
  }

  timestamps.push(now);
  crossChatRateLimiter.set(key, timestamps);
}

export interface PortableSDKServices {
  chatService: ChatService;
  tunnelService?: TunnelService;
  secretsService?: SecretsService;
  chatExecutionService?: ChatExecutionService;
  connectionsService?: ConnectionsService;
  emitter?: IOutputEmitter; // Optional: for real-time notifications when user is connected
}

export interface PortableSDKContext {
  userId: string;
  chatId: string;
  authToken: string;
  repoPath?: string;
  model?: string;
  permissions?: string;
  executionDepth?: number;
}

export interface LocalProject {
  name: string;
  path: string;
  owner: string | null;
  lastUpdated: number;
}

export class PortableSDK {
  constructor(
    private services: PortableSDKServices,
    private ctx: PortableSDKContext
  ) {}

  // ============================================================================
  // CHAT OPERATIONS
  // ============================================================================
  chat = {
    /**
     * List all chats for the current user
     */
    list: async (options?: { limit?: number; status?: string }) => {
      const chats = await this.services.chatService.getChats(this.ctx.userId, this.ctx.authToken);

      let result = chats;

      // Filter by status if specified
      if (options?.status && options.status !== 'all') {
        result = result.filter((c) => c.status === options.status);
      }

      // Apply limit
      if (options?.limit) {
        result = result.slice(0, options.limit);
      }

      return result;
    },

    /**
     * Get a specific chat by ID
     */
    get: async (chatId: string) => {
      const chat = await this.services.chatService.getChat(
        chatId,
        this.ctx.userId,
        this.ctx.authToken
      );

      // Throw error if chat is in error state
      if (chat?.status === 'error') {
        throw new Error(`Chat ${chatId} is in error state. Check chat messages for details.`);
      }

      return chat;
    },

    /**
     * Create a new chat with an initial message (required)
     */
    create: async (params: {
      owner: string;
      repo: string;
      message: string;
      agent_setup_id: string;
      model?: string;
      title?: string;
      parent_chat_id?: string;
    }) => {
      const chatId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const userWorkspace = getUserWorkspaceDir(this.ctx.userId);
      const repoPath = path.join(userWorkspace, params.owner, params.repo);
      const title = params.title || `Chat in ${params.repo}`;

      // Create the chat
      await this.services.chatService.saveChat({
        userId: this.ctx.userId,
        chatId,
        type: 'claude_code',
        title,
        status: 'running',
        repoPath,
        agentSetupId: params.agent_setup_id,
        model: params.model || this.ctx.model || DEFAULT_MODEL_MODE,
        permissions: this.ctx.permissions || 'default',
        parentChatId: params.parent_chat_id,
        authToken: this.ctx.authToken,
      });

      // Buffer the initial message
      await this.services.chatService.bufferMessage(
        this.ctx.userId,
        chatId,
        'user_message',
        { content: params.message },
        this.ctx.authToken
      );

      // Start Claude execution if ChatExecutionService is available
      if (this.services.chatExecutionService) {
        // Use parent emitter if available (user is connected via Socket.IO),
        // otherwise create NoOpEmitter for headless execution
        let emitter: IOutputEmitter;
        if (this.services.emitter) {
          console.log(`[PortableSDK] Using parent emitter for chat ${chatId} (user connected)`);
          emitter = this.services.emitter;

          // Emit chat:created event BEFORE execution starts so the client knows about the chat
          // before any stream events arrive
          if (emitter.emitToUser && emitter.joinUserToRoom) {
            const chatData = await this.services.chatService.getChat(
              chatId,
              this.ctx.userId,
              this.ctx.authToken
            );
            console.log(
              `[PortableSDK] Emitting chat:created for ${chatId} to user ${this.ctx.userId}`
            );
            emitter.emitToUser(this.ctx.userId, 'chat:created', { chat: chatData });
            emitter.joinUserToRoom(this.ctx.userId, chatId);
          }
        } else {
          console.log(`[PortableSDK] Using NoOpEmitter for chat ${chatId} (headless execution)`);
          const NoOpEmitter = (await import('./emitters/NoOpEmitter.js')).NoOpEmitter;
          emitter = new NoOpEmitter({
            debug: true,
            chatService: this.services.chatService,
            userId: this.ctx.userId,
            authToken: this.ctx.authToken,
          });
        }

        // Build execution context
        const executionContext = {
          chatId,
          userId: this.ctx.userId,
          username: this.ctx.userId,
          authToken: this.ctx.authToken,
          emitter,
        };

        // Execute the message (don't await - run in background)
        this.services.chatExecutionService
          .executeMessage(
            executionContext,
            {
              content: params.message,
              uploadedFiles: [],
            },
            {
              model: params.model || this.ctx.model || DEFAULT_MODEL_MODE,
              permissions: 'default',
              agentSetupId: params.agent_setup_id,
            }
          )
          .catch((error: any) => {
            console.error(
              `[PortableSDK] Error executing initial message for chat ${chatId}:`,
              error
            );
          });

        console.log(`[PortableSDK] Chat ${chatId} created and execution started`);
      } else {
        console.warn(
          `[PortableSDK] ChatExecutionService not available - chat created but execution not started`
        );
      }

      return this.services.chatService.getChat(chatId, this.ctx.userId, this.ctx.authToken);
    },

    /**
     * Get messages from a chat
     * Returns messages in a user-friendly format with role and content extracted
     */
    getMessages: async (chatId: string, options?: { limit?: number; offset?: number }) => {
      // Check if chat is in error state first
      const chat = await this.services.chatService.getChat(
        chatId,
        this.ctx.userId,
        this.ctx.authToken
      );
      if (chat?.status === 'error') {
        throw new Error(`Chat ${chatId} is in error state. Check chat messages for details.`);
      }

      const messages = await this.services.chatService.getMessages(chatId, this.ctx.authToken);

      let result = messages;

      if (options?.offset) {
        result = result.slice(options.offset);
      }

      if (options?.limit) {
        result = result.slice(0, options.limit);
      }

      // Transform BufferedMessage format to user-friendly format
      // BufferedMessage: { id, type, data, timestamp }
      // User-friendly: { id, role, content, type, created_at, raw }
      return result.map((m) => {
        const role =
          m.type === 'user_message'
            ? 'user'
            : m.type === 'assistant_message'
              ? 'assistant'
              : m.type === 'error_message'
                ? 'error'
                : 'system';

        const content = m.data?.content || m.data?.text || '';

        return {
          id: m.id,
          role,
          content,
          type: m.type,
          created_at: m.timestamp,
          raw: m, // Include raw message for advanced use cases
        };
      });
    },

    /**
     * Send a message to a chat and trigger Claude execution
     * NOTE: This is a powerful operation - use with care
     */
    send: async (chatId: string, message: string) => {
      // Safety: Prevent infinite recursion
      const currentDepth = this.ctx.executionDepth || 0;
      if (currentDepth >= 3) {
        throw new Error(
          'Maximum cross-chat execution depth (3) exceeded. This prevents infinite recursion.'
        );
      }

      // Safety: Rate limiting
      checkRateLimit(this.ctx.userId);

      // Get chat to verify it exists and get its configuration
      const chat = await this.services.chatService.getChat(
        chatId,
        this.ctx.userId,
        this.ctx.authToken
      );
      if (!chat) {
        throw new Error(`Chat not found: ${chatId}`);
      }

      // Throw error if chat is in error state
      if (chat.status === 'error') {
        throw new Error(
          `Chat ${chatId} is in error state. Cannot send messages to a failed chat. Check chat messages for error details.`
        );
      }

      // Add user message to the chat via bufferMessage
      await this.services.chatService.bufferMessage(
        this.ctx.userId,
        chatId,
        'user_message',
        { content: message },
        this.ctx.authToken
      );

      // Start Claude execution if ChatExecutionService is available
      if (this.services.chatExecutionService) {
        // Use parent emitter if available (user is connected via Socket.IO),
        // otherwise create NoOpEmitter for headless execution
        let emitter: IOutputEmitter;
        if (this.services.emitter) {
          console.log(`[PortableSDK] Using parent emitter for chat ${chatId} (user connected)`);
          emitter = this.services.emitter;

          // Ensure user is joined to chat room (in case they weren't already)
          if (emitter.joinUserToRoom) {
            emitter.joinUserToRoom(this.ctx.userId, chatId);
          }
        } else {
          console.log(`[PortableSDK] Using NoOpEmitter for chat ${chatId} (headless execution)`);
          const NoOpEmitter = (await import('./emitters/NoOpEmitter.js')).NoOpEmitter;
          emitter = new NoOpEmitter({
            debug: true,
            chatService: this.services.chatService,
            userId: this.ctx.userId,
            authToken: this.ctx.authToken,
          });
        }

        // Build execution context
        const executionContext = {
          chatId,
          userId: this.ctx.userId,
          username: this.ctx.userId,
          authToken: this.ctx.authToken,
          emitter,
        };

        // Update chat status to running
        await this.services.chatService.updateChatStatus(
          chatId,
          this.ctx.userId,
          'running',
          this.ctx.authToken
        );

        // Execute the message (don't await - run in background)
        this.services.chatExecutionService
          .executeMessage(
            executionContext,
            {
              content: message,
              uploadedFiles: [],
            },
            {
              model: chat.model || DEFAULT_MODEL_MODE,
              permissions: chat.permissions || 'default',
              agentSetupId: chat.agent_setup_id || 'freestyle',
            }
          )
          .catch((error: any) => {
            console.error(`[PortableSDK] Error executing message for chat ${chatId}:`, error);
          });

        console.log(`[PortableSDK] Message sent to chat ${chatId} and execution started`);

        return {
          success: true,
          chatId,
          message: 'Message sent and execution started',
          executionDepth: currentDepth + 1,
        };
      } else {
        console.warn(
          `[PortableSDK] ChatExecutionService not available - message buffered but execution not started`
        );
        return {
          success: true,
          chatId,
          message: 'Message buffered but execution not started (ChatExecutionService unavailable)',
          executionDepth: currentDepth + 1,
        };
      }
    },

    /**
     * Archive a chat
     */
    archive: async (chatId: string) => {
      await this.services.chatService.archiveChat(
        chatId,
        this.ctx.userId,
        true, // archived = true
        this.ctx.authToken
      );
      return { success: true, chatId };
    },
  };

  // ============================================================================
  // PROJECT OPERATIONS
  // ============================================================================
  projects = {
    /**
     * List all projects (based on chat activity)
     */
    list: async (): Promise<LocalProject[]> => {
      const activityMap = await this.services.chatService.dbAdapter.getLastChatActivityByRepo(
        this.ctx.userId,
        this.ctx.authToken
      );
      return this.formatProjects(activityMap);
    },

    /**
     * Get a specific project by path
     */
    get: async (projectPath: string): Promise<LocalProject | null> => {
      const activityMap = await this.services.chatService.dbAdapter.getLastChatActivityByRepo(
        this.ctx.userId,
        this.ctx.authToken
      );
      const lastUpdated = activityMap.get(projectPath);
      if (!lastUpdated) return null;

      const parts = projectPath.split('/');
      return {
        name: parts[parts.length - 1],
        path: projectPath,
        owner: parts.length >= 2 ? parts[parts.length - 2] : null,
        lastUpdated: parseInt(lastUpdated),
      };
    },

    /**
     * Get recently accessed projects
     */
    getRecent: async (limit: number = 10): Promise<LocalProject[]> => {
      const activityMap = await this.services.chatService.dbAdapter.getLastChatActivityByRepo(
        this.ctx.userId,
        this.ctx.authToken
      );
      return this.formatProjects(activityMap)
        .sort((a, b) => b.lastUpdated - a.lastUpdated)
        .slice(0, limit);
    },
  };

  private formatProjects(activityMap: Map<string, string>): LocalProject[] {
    return Array.from(activityMap.entries()).map(([repoPath, lastUpdated]) => {
      const parts = repoPath.split('/');
      return {
        name: parts[parts.length - 1],
        path: repoPath,
        owner: parts.length >= 2 ? parts[parts.length - 2] : null,
        lastUpdated: parseInt(lastUpdated),
      };
    });
  }

  // ============================================================================
  // RUNTIME OPERATIONS
  // ============================================================================
  runtime = {
    /**
     * Get full runtime state (tunnels)
     */
    getState: async () => {
      const tunnels = this.services.tunnelService
        ? this.services.tunnelService.getUserTunnels(this.ctx.userId)
        : [];
      return { tunnels };
    },

    /**
     * List active tunnels
     */
    getTunnels: async () => {
      if (!this.services.tunnelService) return [];
      return this.services.tunnelService.getUserTunnels(this.ctx.userId);
    },
  };

  // ============================================================================
  // USER OPERATIONS
  // ============================================================================
  user = {
    /**
     * Get current user info
     */
    getInfo: async () => {
      return {
        userId: this.ctx.userId,
        chatId: this.ctx.chatId,
        repoPath: this.ctx.repoPath,
        model: this.ctx.model,
      };
    },

    /**
     * List user secrets (values are masked)
     */
    getSecrets: async () => {
      if (!this.services.secretsService) {
        return [];
      }
      const secrets = await this.services.secretsService.getSecrets(this.ctx.userId);
      // Mask secret values for security
      return secrets.map((s) => ({
        key: s.key,
        source: s.source,
        value: '***masked***',
        hasValue: !!s.value,
      }));
    },

    /**
     * Set a user secret
     */
    setSecret: async (key: string, value: string) => {
      if (!this.services.secretsService) {
        throw new Error('SecretsService not available');
      }
      await this.services.secretsService.saveSecretToVault(this.ctx.userId, key, value, 'manual');
      return { success: true, key };
    },

    /**
     * List user connections (Slack, GitHub, etc.)
     */
    getConnections: async () => {
      if (!this.services.connectionsService) return [];
      return this.services.connectionsService.getUserConnections({
        userId: this.ctx.userId,
        authToken: this.ctx.authToken,
      });
    },
  };

  // ============================================================================
  // GITHUB OPERATIONS
  // ============================================================================
  /**
   * GitHub operations namespace
   *
   * IMPORTANT: GitHub operations should be performed using the `gh` CLI via bash,
   * not through this SDK. This is by design to leverage GitHub's official CLI.
   *
   * Examples:
   * - Create issue: Execute `gh issue create --title "..." --body "..."` via bash
   * - List repos: Execute `gh repo list` via bash
   * - Create PR: Execute `gh pr create --title "..." --body "..."` via bash
   *
   * This namespace exists to provide helpful error messages when users
   * try to access GitHub operations programmatically.
   */
  github = {
    /**
     * Create a GitHub issue
     * @throws Error with instructions to use gh CLI instead
     */
    createIssue: async (params: {
      owner: string;
      repo: string;
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
    }) => {
      throw new Error(
        `GitHub operations should be performed using the 'gh' CLI via bash, not through portable.github.\n\n` +
          `Example:\n` +
          `  const { exec } = require('child_process');\n` +
          `  const result = exec('gh issue create --title "${params.title}" --body "${params.body || ''}" --repo ${params.owner}/${params.repo}');\n\n` +
          `Or use the bash tool directly in your chat.`
      );
    },

    /**
     * List GitHub repositories
     * @throws Error with instructions to use gh CLI instead
     */
    listRepos: async () => {
      throw new Error(
        `GitHub operations should be performed using the 'gh' CLI via bash, not through portable.github.\n\n` +
          `Example:\n` +
          `  const { exec } = require('child_process');\n` +
          `  const result = exec('gh repo list');\n\n` +
          `Or use the bash tool directly in your chat.`
      );
    },

    /**
     * Create a pull request
     * @throws Error with instructions to use gh CLI instead
     */
    createPR: async (params: {
      owner: string;
      repo: string;
      title: string;
      body?: string;
      head: string;
      base: string;
    }) => {
      throw new Error(
        `GitHub operations should be performed using the 'gh' CLI via bash, not through portable.github.\n\n` +
          `Example:\n` +
          `  const { exec } = require('child_process');\n` +
          `  const result = exec('gh pr create --title "${params.title}" --body "${params.body || ''}" --head ${params.head} --base ${params.base} --repo ${params.owner}/${params.repo}');\n\n` +
          `Or use the bash tool directly in your chat.`
      );
    },

    /**
     * Get information about this namespace
     */
    info: () => {
      return {
        message:
          'GitHub operations should be performed using the gh CLI via bash. ' +
          'Available commands: gh issue create, gh pr create, gh repo list, etc. ' +
          'Execute via bash tool in your chat.',
        availableMethods: ['createIssue', 'listRepos', 'createPR'],
        recommendation: 'Use bash tool with gh CLI commands instead of portable.github.*',
      };
    },
  };

  // ============================================================================
  // CONTEXT OPERATIONS
  // ============================================================================
  context = {
    /**
     * Get the current chat with enriched repository information
     * RECOMMENDED: Use this when creating worker chats to reuse the same repo
     * Returns the chat object with additional `owner` and `repo` properties
     */
    getCurrentChat: async () => {
      if (!this.ctx.chatId) return null;
      const chat = await this.chat.get(this.ctx.chatId);

      // Enrich with owner and repo information from repo_path
      if (chat && chat.repo_path) {
        const parts = chat.repo_path.split('/');
        // repo_path format: "owner/repo" or "full/path/to/owner/repo"
        // Extract last two parts for owner/repo
        const owner = parts.length >= 2 ? parts[parts.length - 2] : null;
        const repo = parts.length >= 1 ? parts[parts.length - 1] : null;

        return {
          ...chat,
          owner,
          repo,
        };
      }

      return chat;
    },

    /**
     * Get the current repo/project path
     * Returns full path like "/workspace/local/my-app"
     */
    getCurrentRepo: async () => {
      return this.ctx.repoPath || null;
    },

    /**
     * Get the current repository info (owner and repo)
     * RECOMMENDED: Use this when creating worker chats to reuse the same repo
     * Returns { owner, repo } extracted from current repo path
     * Example: "local/my-app" → { owner: "local", repo: "my-app" }
     */
    getCurrentRepoInfo: async () => {
      if (!this.ctx.repoPath) return null;

      const parts = this.ctx.repoPath.split('/');
      // Extract last two parts for owner/repo
      const owner = parts.length >= 2 ? parts[parts.length - 2] : null;
      const repo = parts.length >= 1 ? parts[parts.length - 1] : null;

      if (!owner || !repo) return null;

      return { owner, repo };
    },

    /**
     * Get the current model setting
     */
    getModel: async () => {
      return this.ctx.model || DEFAULT_MODEL_MODE;
    },
  };
}
