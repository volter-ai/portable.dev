/**
 * Mock for @anthropic-ai/claude-agent-sdk
 *
 * This mock replaces ONLY the query() function - the external API call.
 * All other ClaudeService logic remains real, allowing us to test:
 * - TokenAdapter usage
 * - API routing mode determination
 * - Token extraction
 * - System prompt generation
 *
 * Philosophy: Mock external services, test real internal logic
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

interface QueryOptions {
  prompt: string | AsyncGenerator<string, void, unknown>;
  options: {
    cwd?: string;
    settingSources?: any[];
    skills?: string[] | 'all'; // rev9 D28 — the skills enablement option
    allowedTools?: string[];
    resume?: string;
    model?: string;
    customSystemPrompt?: string;
    permissionMode?: string; // Changed from 'permissions' to match real SDK
    outputCallback?: (output: any) => void;
    userMessageCallback?: (message: SDKUserMessage) => void;
    userId?: string;
  };
  client?: any;
}

interface MockBlock {
  type: string;
  text?: string;
  name?: string; // for tool_use blocks
  input?: any; // for tool_use blocks
  tool_use_id?: string; // for tool_result blocks
  content?: string; // for tool_result blocks
  is_error?: boolean; // for tool_result blocks
  id?: string;
}

/**
 * Mock query implementation
 * Returns an async generator that yields pre-configured blocks
 */
class MockQueryImplementation {
  private responseBlocks: Map<string, MockBlock[]> = new Map();
  private sequentialResponses: MockBlock[][] = [];
  private pendingBlocks: MockBlock[] = [];
  private callCount = 0;
  private lastOptions: QueryOptions | null = null;

  /**
   * Configure the response blocks for the next query call
   */
  setResponse(chatId: string, blocks: MockBlock[]): void {
    this.responseBlocks.set(chatId, blocks);
  }

  /**
   * Add a single response block to the current query response
   * Multiple calls to addResponse() will accumulate blocks
   * Call reset() to clear pending blocks
   */
  addResponse(block: MockBlock): void {
    this.pendingBlocks.push(block);
  }

  /**
   * Configure multiple responses that will be returned in sequence
   * First call returns responses[0], second call returns responses[1], etc.
   */
  setSequentialResponses(responses: MockBlock[][]): void {
    this.sequentialResponses = responses;
  }

  /**
   * Get the last query options (for assertions)
   */
  getLastOptions(): QueryOptions | null {
    return this.lastOptions;
  }

  /**
   * Get number of times query was called
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset mock state
   */
  reset(): void {
    this.responseBlocks.clear();
    this.sequentialResponses = [];
    this.pendingBlocks = [];
    this.callCount = 0;
    this.lastOptions = null;
  }

  /**
   * Mock query function
   * Returns an async generator that yields Claude SDK messages
   *
   * Claude SDK message format:
   * {
   *   message: {
   *     content: [
   *       { type: 'text', text: 'Hello' },
   *       { type: 'tool_use', name: 'bash', input: {...} }
   *     ]
   *   }
   * }
   */
  async *query(options: QueryOptions): AsyncGenerator<any, void, unknown> {
    this.callCount++;
    this.lastOptions = options;

    // Extract chat ID from options (it's in the userId field for our tests)
    const userId = options.options.userId || 'default';

    // Get pre-configured blocks - check in order: pendingBlocks, sequential, map-based
    let blocks: MockBlock[];
    if (this.pendingBlocks.length > 0) {
      // Use accumulated blocks from addResponse() calls
      blocks = [...this.pendingBlocks];
      // Don't clear here - allow multiple queries with same response
    } else if (this.sequentialResponses.length > 0) {
      // Use sequential responses (0-indexed, so callCount - 1)
      const responseIndex = this.callCount - 1;
      blocks =
        this.sequentialResponses[responseIndex] ||
        this.sequentialResponses[this.sequentialResponses.length - 1];
    } else {
      // Fall back to map-based responses
      blocks = this.responseBlocks.get(userId) || [{ type: 'text', text: 'Default mock response' }];
    }

    // Check if we need to execute real tools
    // If there's a tool_use block but NO tool_result, execute the real tool
    const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');
    const toolResultBlocks = blocks.filter((b) => b.type === 'tool_result');

    if (toolUseBlocks.length > 0 && toolResultBlocks.length === 0) {
      // Execute each tool_use block through real tools
      for (const toolUseBlock of toolUseBlocks) {
        const toolName = toolUseBlock.name;
        const toolInput = toolUseBlock.input;
        const toolId = toolUseBlock.id;

        try {
          // Handle standard tools (write, read, edit, bash, etc.)
          if (toolName === 'write') {
            const { promises: fs } = await import('fs');
            const path = await import('path');
            const cwd = options.options.cwd || process.cwd();
            const filePath = path.isAbsolute(toolInput.file_path)
              ? toolInput.file_path
              : path.join(cwd, toolInput.file_path);

            // Create directory if it doesn't exist
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, toolInput.content, 'utf-8');

            blocks.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content: 'File written successfully',
              is_error: false,
            });
          } else if (toolName === 'read') {
            const { promises: fs } = await import('fs');
            const path = await import('path');
            const cwd = options.options.cwd || process.cwd();
            const filePath = path.isAbsolute(toolInput.file_path)
              ? toolInput.file_path
              : path.join(cwd, toolInput.file_path);

            const content = await fs.readFile(filePath, 'utf-8');
            blocks.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content,
              is_error: false,
            });
          } else if (toolName === 'edit') {
            const { promises: fs } = await import('fs');
            const path = await import('path');
            const cwd = options.options.cwd || process.cwd();
            const filePath = path.isAbsolute(toolInput.file_path)
              ? toolInput.file_path
              : path.join(cwd, toolInput.file_path);

            const content = await fs.readFile(filePath, 'utf-8');
            const newContent = content.replace(toolInput.old_string, toolInput.new_string);
            await fs.writeFile(filePath, newContent, 'utf-8');

            blocks.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content: 'File edited successfully',
              is_error: false,
            });
          } else if (toolName === 'bash') {
            const { execSync } = await import('child_process');
            const cwd = options.options.cwd || process.cwd();

            const output = execSync(toolInput.command, {
              cwd,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            blocks.push({
              type: 'tool_result',
              tool_use_id: toolId,
              content: output || '',
              is_error: false,
            });
          } else if (options.options.mcpServers) {
            // Handle MCP tools
            const parts = toolName.split('__');
            if (parts.length >= 3 && parts[0] === 'mcp') {
              const serverName = parts[1];
              const actualToolName = parts.slice(2).join('__');

              const mcpServer = options.options.mcpServers[serverName];

              // MCP server structure: { type, name, instance }
              // Tools are in instance._registeredTools (plain object with tool names as keys)
              const registeredTools = mcpServer?.instance?._registeredTools;

              if (mcpServer && registeredTools) {
                // First try the exact tool name extracted from the MCP call
                let tool = registeredTools[actualToolName];

                // If not found, try removing the server name prefix (e.g., "run_connection_execute_code" -> "execute_code")
                if (!tool && actualToolName.includes('_')) {
                  const serverPrefix = serverName.replace(/-/g, '_') + '_';
                  if (actualToolName.startsWith(serverPrefix)) {
                    const simplifiedName = actualToolName.substring(serverPrefix.length);
                    tool = registeredTools[simplifiedName];
                  }
                }

                if (tool && tool.handler) {
                  const result = await tool.handler(toolInput);

                  // Add the real tool_result to blocks
                  blocks.push({
                    type: 'tool_result',
                    tool_use_id: toolId,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                    is_error: false,
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error('[MockQuery] Error executing real tool:', error);
          // Add error result
          blocks.push({
            type: 'tool_result',
            tool_use_id: toolId,
            content: JSON.stringify({ error: String(error) }),
            is_error: true,
          });
        }
      }
    }

    // Yield a system init message first (session initialization)
    yield {
      type: 'system',
      subtype: 'init',
      session_id: `mock-session-${userId}`,
      model: options.options.model || 'claude-sonnet-4.5',
    };

    // Small delay to simulate async behavior
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Yield blocks wrapped in Claude SDK message format
    yield {
      message: {
        content: blocks,
      },
    };

    // Small delay to simulate async behavior
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Yield result message (task completion)
    yield {
      type: 'result',
    };
  }
}

// Global instance
export const mockQueryImplementation = new MockQueryImplementation();

/**
 * Mocked query function
 * This replaces the real query() from @anthropic-ai/claude-agent-sdk
 */
export async function* query(options: QueryOptions): AsyncGenerator<any, void, unknown> {
  yield* mockQueryImplementation.query(options);
}

// Re-export other SDK types that ClaudeService might need
// These are just type exports, no implementation
export type { SDKUserMessage, QueryOptions };

// Mock PermissionMode and PermissionResult types
export type PermissionMode = 'ask' | 'allow' | 'reject';
export type PermissionResult = 'allow' | 'reject';
