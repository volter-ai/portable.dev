/**
 * MCP Tool Test Helper
 *
 * Reusable infrastructure for testing services that are ONLY accessible through MCP tools.
 *
 * Problem: Services like RunConnectionService can't be tested via HTTP routes - they're
 * only invoked when Claude AI uses an MCP tool. Testing them requires:
 * 1. Full chat execution infrastructure
 * 2. Mocking Claude SDK to return tool_use blocks
 * 3. Complex message structure parsing
 *
 * This helper abstracts away the complexity and provides a clean API for MCP tool tests.
 *
 * Usage Example:
 * ```typescript
 * const helper = new McpToolTestHelper({
 *   testUserId,
 *   authToken,
 *   dbAdapter,
 *   connectionsService, // Optional - for connection-based tools
 * });
 *
 * await helper.setup();
 *
 * const result = await helper.executeMcpTool({
 *   userMessage: 'Post to Slack',
 *   toolName: 'mcp__run-connection__run_connection_execute_code',
 *   toolInput: {
 *     connections: ['company_slack'],
 *     code: `return await company_slack.chat.postMessage({...})`,
 *   },
 *   mockToolResult: { success: true, result: { ok: true } },
 * });
 *
 * expect(result.toolWasInvoked).toBe(true);
 * expect(result.toolResult.success).toBe(true);
 * ```
 */

import { mockQueryImplementation } from '../mocks/mockClaudeAgentSDK';
import { TestEmitter } from './TestEmitter';
import { TestContextBuilder } from './testContext';
import { ChatService } from '../../../src/services/ChatService';
import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { ClaudeService } from '../../../src/services/ClaudeService';
import { ConnectionsService } from '../../../src/services/ConnectionsService';
import { MessageDeduplicationService } from '../../../src/services/MessageDeduplicationService';
import { GitLocalService } from '../../../src/services/GitLocalService';
import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import { MockProcessTrackerService } from '../mocks/MockProcessTrackerService';
import { MockTunnelService } from '../mocks/MockTunnelService';
import { createTestClaudeService } from './testClaudeService';
import type { ContentBlock } from '@vgit2/shared/types';

export interface McpToolTestConfig {
  testUserId: string;
  authToken: string;
  dbAdapter: DbAdapter;
  connectionsService?: ConnectionsService; // Required for connection-based tools
  chatId?: string; // Optional custom chat ID
}

export interface ExecuteMcpToolParams {
  userMessage: string; // What the user asks
  toolName: string; // MCP tool name (e.g., 'mcp__run-connection__run_connection_execute_code')
  toolInput: any; // Tool parameters
  mockToolResult?: any; // Optional - mock the tool result if you don't want real execution
  claudeResponse?: string; // Optional - Claude's text response before tool use
}

export interface McpToolTestResult {
  toolWasInvoked: boolean;
  toolInput: any;
  toolResult: any;
  allMessages: any[];
  userMessage: any;
  assistantMessage: any;
  toolResultMessage: any;
}

/**
 * Helper class for testing MCP tools
 */
export class McpToolTestHelper {
  private chatService!: ChatService;
  private claudeService!: ClaudeService;
  private executionService!: ChatExecutionService;
  private emitter!: TestEmitter;
  private chatId: string;

  constructor(private config: McpToolTestConfig) {
    this.chatId = config.chatId || `chat-mcp-tool-test-${Date.now()}`;
  }

  /**
   * Initialize test infrastructure
   * Call this in beforeEach()
   */
  async setup(): Promise<void> {
    const { testUserId, authToken, dbAdapter, connectionsService } = this.config;

    // Initialize ChatService
    this.chatService = new ChatService(dbAdapter);

    // Create test chat
    await this.chatService.saveChat({
      userId: testUserId,
      chatId: this.chatId,
      type: 'claude_code',
      title: 'MCP Tool Test',
      status: undefined,
      repoPath: null,
      agentSetupId: 'freestyle',
      model: 'sonnet',
      permissions: 'default',
      parentChatId: undefined,
      authToken,
    });

    // Initialize ClaudeService with all dependencies including ConnectionsService
    const claudeConfig = await createTestClaudeService({
      userId: testUserId,
      chatService: this.chatService,
      connectionsService, // Pass ConnectionsService for run-connection MCP
    });
    this.claudeService = claudeConfig.claudeService;

    // Initialize ChatExecutionService
    const mockProcessTracker = new MockProcessTrackerService();
    const mockTunnelService = new MockTunnelService();
    const messageDeduplicationService = new MessageDeduplicationService();
    const gitLocalService = new GitLocalService();

    this.executionService = new ChatExecutionService(
      this.chatService,
      this.claudeService,
      gitLocalService,
      messageDeduplicationService,
      mockTunnelService,
      mockProcessTracker,
      dbAdapter,
      undefined, // pushNotificationService
      undefined, // sopService
      undefined, // claudeCodeSessions
      undefined // reposCacheService
    );

    // Initialize TestEmitter
    this.emitter = new TestEmitter();
  }

  /**
   * Execute an MCP tool test scenario
   *
   * This method:
   * 1. Mocks Claude SDK to return a tool_use block
   * 2. Executes the user message through ChatExecutionService
   * 3. Waits for async persistence
   * 4. Extracts and returns tool invocation details
   */
  async executeMcpTool(params: ExecuteMcpToolParams): Promise<McpToolTestResult> {
    const {
      userMessage,
      toolName,
      toolInput,
      mockToolResult,
      claudeResponse = "I'll execute that for you.",
    } = params;

    // Generate unique tool ID
    const toolId = `tool_${toolName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;

    // Mock Claude SDK response with tool_use block
    const blocks: any[] = [
      { type: 'text', text: claudeResponse },
      {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: toolInput,
      },
    ];

    // If mockToolResult provided, add tool_result to simulate tool execution
    if (mockToolResult) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: JSON.stringify(mockToolResult),
        is_error: false,
      });
      blocks.push({ type: 'text', text: 'Done!' });
    }

    mockQueryImplementation.setSequentialResponses([blocks]);

    // Build execution context
    const context = new TestContextBuilder()
      .withUserId(this.config.testUserId)
      .withUsername('testuser')
      .withChatId(this.chatId)
      .withEmitter(this.emitter)
      .withAuthToken(this.config.authToken)
      .build();

    // Execute message
    await this.executionService.executeMessage(
      context,
      { content: userMessage },
      {
        permissions: 'default',
        model: 'claude-sonnet-4.5',
        agentSetupId: 'freestyle',
        isCodeProject: false,
      }
    );

    // Wait for async persistence (tool execution + message saving)
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Retrieve persisted messages
    const messages = await this.chatService.getMessages(this.chatId, this.config.authToken);

    // Debug logging (disabled by default)
    const DEBUG = false;
    if (DEBUG) {
      console.log('\n=== [McpToolTestHelper] Retrieved messages:', messages.length, '===');
      messages.forEach((m: any, i: number) => {
        console.log(`\n--- Message ${i} (type: ${m.type}) ---`);
        if (m.data?.blocks) {
          console.log(`  Blocks (${m.data.blocks.length}):`);
          m.data.blocks.forEach((b: any, bi: number) => {
            console.log(`    [${bi}] ${b.type}:`, JSON.stringify(b, null, 2).substring(0, 500));
          });
        }
      });
      console.log('=== End messages ===\n');
    }

    // Parse messages to extract tool details
    // BufferedMessage format: { id, type, data, timestamp }
    // where type='assistant' | 'user' and data.blocks contains content blocks
    // Note: In the mock, tool_result is in the SAME assistant message as tool_use (not a separate user message)
    const userMsg = messages.find(
      (m: any) => m.type === 'user' && !m.data?.blocks?.some((c: any) => c.type === 'tool_result')
    );
    const assistantMsg = messages.find(
      (m: any) => m.type === 'assistant' && m.data?.blocks?.some((c: any) => c.type === 'tool_use')
    );

    // Extract tool use block
    const toolUseBlock = assistantMsg?.data?.blocks?.find((c: any) => c.type === 'tool_use');
    const toolWasInvoked = !!toolUseBlock;

    // Extract tool result block (in mock, it's in the same assistant message as tool_use)
    const toolResultBlock = assistantMsg?.data?.blocks?.find((c: any) => c.type === 'tool_result');
    let toolResult = null;

    if (toolResultBlock) {
      // Handle MCP tool result format:
      // content is a JSON string: '{"content":[{"type":"text","text":"actual result"}]}'
      // We need to:
      // 1. Parse the outer JSON to get the content array
      // 2. Extract the text from content[0].text
      // 3. Parse that text to get the actual result

      let contentString: string | null = null;

      if (typeof toolResultBlock.content === 'string') {
        contentString = toolResultBlock.content;
      } else if (Array.isArray(toolResultBlock.content)) {
        if (toolResultBlock.content.length > 0) {
          const firstItem = toolResultBlock.content[0];
          if (typeof firstItem === 'string') {
            contentString = firstItem;
          } else if (firstItem?.text) {
            contentString = firstItem.text;
          }
        }
      }

      if (contentString) {
        try {
          // First parse: get the wrapper object with content array
          const wrapper = JSON.parse(contentString);
          if (wrapper.content && Array.isArray(wrapper.content) && wrapper.content[0]?.text) {
            // Second parse: get the actual result from the text field
            const resultText = wrapper.content[0].text;
            try {
              toolResult = JSON.parse(resultText);
            } catch (e) {
              toolResult = { raw: resultText };
            }
          } else {
            toolResult = wrapper;
          }
        } catch (e) {
          toolResult = { raw: contentString };
        }
      }
    }

    return {
      toolWasInvoked,
      toolInput: toolUseBlock?.toolInput, // ClaudeService transforms 'input' to 'toolInput' when persisting
      toolResult,
      allMessages: messages,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      toolResultMessage: assistantMsg, // In mock, tool_result is in same message as tool_use
    };
  }

  /**
   * Get the chat ID for this test session
   */
  getChatId(): string {
    return this.chatId;
  }

  /**
   * Get the emitter for event assertions
   */
  getEmitter(): TestEmitter {
    return this.emitter;
  }

  /**
   * Get the chat service
   */
  getChatService(): ChatService {
    return this.chatService;
  }
}
