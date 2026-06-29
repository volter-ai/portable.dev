import { randomUUID } from 'crypto';

import { interceptedQuestions } from '../../../mcp/AskUserMcpServer.js';

import type {
  HandlerDependencies,
  PendingBackgroundBash,
  PendingToolUse,
  SubAgentInfo,
} from '../types.js';
import type { WebSocket } from 'ws';

/**
 * StreamHandler - Processes streaming messages from Claude SDK
 * Responsibilities:
 * - Process each stream message (text, tool_use, tool_result)
 * - Track sub-agents and background processes
 * - Process media (images, videos, screenshots)
 * - Emit blocks to the client
 */
export class StreamHandler {
  private mediaProcessingService: any;
  private tunnelService?: any;
  private processTrackerService?: any;
  private socketIOService?: any;
  private askUserMcpServer?: any;

  // State for tracking stream processing
  private activeSubAgents: Map<string, SubAgentInfo>;
  private pendingBackgroundBash?: Map<string, PendingBackgroundBash>;
  private pendingToolUses?: Map<string, PendingToolUse>;
  private postCompressionFlags: Map<string, boolean>;

  constructor(
    dependencies: HandlerDependencies,
    activeSubAgents: Map<string, SubAgentInfo>,
    postCompressionFlags: Map<string, boolean>,
    pendingBackgroundBash?: Map<string, PendingBackgroundBash>,
    pendingToolUses?: Map<string, PendingToolUse>,
    askUserMcpServer?: any
  ) {
    this.mediaProcessingService = dependencies.mediaProcessingService;
    this.tunnelService = dependencies.tunnelService;
    this.processTrackerService = dependencies.processTrackerService;
    this.socketIOService = dependencies.socketIOService;
    this.activeSubAgents = activeSubAgents;
    this.postCompressionFlags = postCompressionFlags;
    this.pendingBackgroundBash = pendingBackgroundBash;
    this.pendingToolUses = pendingToolUses;
    this.askUserMcpServer = askUserMcpServer;
  }

  /**
   * Handle stdout from Claude SDK
   */
  handleStdout(line: string): void {
    console.log('[Claude stdout]:', line);
  }

  /**
   * Handle stderr from Claude SDK
   */
  handleStderr(line: string): void {
    console.error('[Claude stderr]:', line);
  }

  /**
   * Get display name for a sub-agent type
   */
  private getSubAgentDisplayName(subAgentType: string): string {
    switch (subAgentType) {
      case 'github-specialist':
        return 'GitHub Specialist';
      case 'coding-specialist':
        return 'Coding Specialist';
      case 'qa-specialist':
        return 'QA Specialist';
      case 'general-purpose':
        return 'General Purpose Agent';
      default:
        // Capitalize and replace hyphens with spaces
        return subAgentType
          .split('-')
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
    }
  }

  /**
   * Process a single message from the Claude Code stream
   * Extracts text, tool_use, tool_result, images, and videos
   * Also monitors Bash output for dev server port detection
   * Tracks sub-agents when Task tool is invoked
   */
  async processStreamMessage(
    message: any,
    repoPath: string,
    chatId: string,
    ws: WebSocket,
    userId: string,
    sessionId?: string
  ): Promise<any[]> {
    const blocks: any[] = [];

    // Check if this message is from a sub-agent (has parent_tool_use_id)
    const parentToolUseId = (message as any).parent_tool_use_id;
    let subAgentInfo: { type: string; name: string } | undefined;

    if (parentToolUseId) {
      subAgentInfo = this.activeSubAgents.get(parentToolUseId);
      if (subAgentInfo) {
        console.log(
          `[StreamHandler] Message from sub-agent: ${subAgentInfo.name} (parent_tool_use_id: ${parentToolUseId})`
        );
      }
    }

    if (message && typeof message === 'object' && 'message' in message) {
      const msg = (message as any).message;

      if (msg.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            const textBlock: any = {
              type: 'text',
              blockId: randomUUID(), // Unique identifier for deduplication and references
              content: block.text,
              // ALWAYS add parent_tool_use_id to every block
              parent_tool_use_id: parentToolUseId || null,
              // Add timestamp for each block to track when it was created
              timestamp: Date.now(),
            };
            // Add sub-agent metadata if this is from a sub-agent
            if (subAgentInfo) {
              textBlock.agentName = subAgentInfo.name;
              textBlock.agentType = subAgentInfo.type;
              textBlock.isSubAgent = true;
            }
            blocks.push(textBlock);
            console.log(`[StreamHandler] Text:`, block.text);
          } else if (block.type === 'tool_use') {
            const toolInput = block.input || {};
            const relativeInput = { ...toolInput };

            // Convert absolute paths to relative
            if (relativeInput.file_path && typeof relativeInput.file_path === 'string') {
              relativeInput.file_path = relativeInput.file_path.replace(repoPath + '/', '');
            }
            if (relativeInput.path && typeof relativeInput.path === 'string') {
              relativeInput.path = relativeInput.path.replace(repoPath + '/', '');
            }

            // Track background Bash tool_use (we'll get the shell ID later in tool_result)
            if (block.name === 'Bash' && toolInput.run_in_background === true) {
              const toolUseId = block.id;
              const command = toolInput.command || '';
              const description = toolInput.description || command.substring(0, 50);

              console.log(`[StreamHandler] Background Bash detected: ${description}`);

              // Store metadata temporarily (will be moved to ProcessTracker when we get shell ID)
              if (!this.pendingBackgroundBash) {
                this.pendingBackgroundBash = new Map();
              }
              this.pendingBackgroundBash.set(toolUseId, {
                command,
                description,
                userId,
                chatId,
                repoPath,
              });
            }

            // Track Task tool invocation (sub-agent)
            if (block.name === 'Task') {
              const subAgentType =
                toolInput.subagent_type || toolInput.agent_type || 'general-purpose';
              const toolUseId = block.id;

              console.log(
                `[StreamHandler] Sub-agent invoked: ${subAgentType} (tool_use_id: ${toolUseId})`
              );

              // Track active sub-agent
              this.activeSubAgents.set(toolUseId, {
                type: subAgentType,
                name: this.getSubAgentDisplayName(subAgentType),
                chatId: chatId,
              });

              // Emit sub-agent start event to the client
              ws.send(
                JSON.stringify({
                  type: 'subagent_start',
                  chat_id: chatId,
                  agent_type: subAgentType,
                  agent_name: this.getSubAgentDisplayName(subAgentType),
                  tool_use_id: toolUseId,
                })
              );
            }

            // Track KillShell - mark process as completed and store for later health check
            if (block.name === 'KillShell' && toolInput.shell_id && this.processTrackerService) {
              const shellId = toolInput.shell_id;
              console.log(`[StreamHandler] KillShell detected for: ${shellId}`);
              this.processTrackerService.updateProcessStatus(shellId, 'completed');

              // Emit runtime state update via WebSocket to remove process from the client
              ws.send(
                JSON.stringify({
                  type: 'runtime_state_update',
                  chat_id: chatId,
                  backgroundProcess: {
                    id: shellId,
                    command: '',
                    chatId,
                    status: 'completed',
                  },
                })
              );
            }

            // AskUserQuestion will flow through as a regular tool_use block
            // The client will detect it and render the question UI (just like secrets)
            // No special handling needed here

            // Track tool_use for later tool_result matching
            if (
              block.name === 'BashOutput' ||
              block.name === 'KillShell' ||
              block.name === 'mcp__playwright__browser_resize'
            ) {
              if (!this.pendingToolUses) {
                this.pendingToolUses = new Map();
              }
              this.pendingToolUses.set(block.id, {
                toolName: block.name,
                toolInput: relativeInput,
              });
            }

            // Note: We don't check pendingPermissions here anymore
            // The tool_use block is sent immediately, then canUseTool fires later
            // and retroactively updates the block on the client via tool_permission_required event
            console.log(`[StreamHandler] Tool:`, block.name);
            console.log(`[StreamHandler]   Tool input:`, JSON.stringify(relativeInput, null, 2));

            // INTERCEPT: Handle ask_user tool manually since SDK MCP doesn't pass parameters correctly
            if (block.name === 'mcp__user__ask_user') {
              if (
                !relativeInput?.questions ||
                !Array.isArray(relativeInput.questions) ||
                relativeInput.questions.length === 0
              ) {
                console.warn(`[StreamHandler] ⚠️  ask_user tool called but NO questions provided`);
                console.warn(
                  `[StreamHandler]   Tool input:`,
                  JSON.stringify(relativeInput, null, 2)
                );
                console.warn(`[StreamHandler]   Tool ID:`, block.id);
                console.warn(
                  `[StreamHandler]   This is a Claude behavior issue - tool called with empty/invalid input`
                );
                // Continue - let the tool handler deal with it (will return error)
              } else {
                console.log(
                  `[StreamHandler] 🎯 Intercepting ask_user tool call - SDK MCP workaround`
                );
                console.log(`[StreamHandler]   Tool use ID: ${block.id}`);
                const requestId = `ask-${Date.now()}-${Math.random().toString(36).substring(7)}`;

                // Store questions in shared Map so handler can retrieve them
                interceptedQuestions.set(block.id, {
                  questions: relativeInput.questions,
                  requestId,
                });
                console.log(
                  `[StreamHandler] ✓ Stored questions in interceptedQuestions Map with key: ${block.id}`
                );

                // Call onQuestionsReady directly with the tool input
                if (this.askUserMcpServer) {
                  console.log(
                    `[StreamHandler] Manually triggering onQuestionsReady with ${relativeInput.questions.length} questions`
                  );
                  // The callback was registered in startClaudeCodeSession
                  // We'll emit directly via the socketIOService since we have access to it
                  // Transform questions to expected format
                  const transformedQuestions = relativeInput.questions.map(
                    (q: any, index: number) => {
                      if (
                        q.header &&
                        typeof q.multiSelect === 'boolean' &&
                        Array.isArray(q.options) &&
                        q.options.length > 0 &&
                        typeof q.options[0] === 'object' &&
                        q.options[0].label
                      ) {
                        return q;
                      }
                      return {
                        question: q.question || `Question ${index + 1}`,
                        header: q.id || `Q${index + 1}`,
                        multiSelect: q.type === 'multiselect' || q.type === 'checkbox' || false,
                        options: Array.isArray(q.options)
                          ? q.options.map((opt: any) => {
                              if (typeof opt === 'string') {
                                return { label: opt, description: opt };
                              }
                              return {
                                label: opt.label || opt.value || opt,
                                description: opt.description || opt.label || opt.value || opt,
                              };
                            })
                          : [],
                      };
                    }
                  );

                  // Send to the client via Socket.IO only (not WebSocket to avoid duplicates)
                  if (this.socketIOService) {
                    // Debug: Check how many sockets are in this room
                    console.log(
                      `[StreamHandler] 📡 Broadcasting ask_user_question to room ${chatId}`,
                      {
                        requestId,
                        questionCount: transformedQuestions.length,
                      }
                    );

                    this.socketIOService.broadcastToRoom(chatId, 'ask_user_question', {
                      chat_id: chatId,
                      request_id: requestId,
                      tool_use_id: block.id, // Send block ID so the client knows which block to update
                      questions: transformedQuestions,
                    });
                  } else {
                    console.warn(`[StreamHandler] No socketIOService available to send questions`);
                  }

                  console.log(
                    `[StreamHandler] ✓ Sent ${transformedQuestions.length} questions to frontend via intercept`
                  );
                }
              }
            }

            // Push all tool_use blocks
            // IMPORTANT: AskUserQuestion should NOT have parent_tool_use_id to avoid grouping/collapsing
            // (parent_tool_use_id is added to all blocks, but AskUserQuestion needs inline rendering)
            const toolUseBlock: any = {
              type: 'tool_use',
              blockId: randomUUID(), // Unique identifier for deduplication and references
              toolName: block.name,
              toolInput: relativeInput,
              id: block.id,
              // Add parent_tool_use_id to all blocks EXCEPT AskUserQuestion
              parent_tool_use_id:
                block.name === 'AskUserQuestion' ? undefined : parentToolUseId || null,
              // Add timestamp for each block to track when it was created
              timestamp: Date.now(),
            };
            // Add sub-agent metadata if this is from a sub-agent
            if (subAgentInfo) {
              toolUseBlock.agentName = subAgentInfo.name;
              toolUseBlock.agentType = subAgentInfo.type;
              toolUseBlock.isSubAgent = true;
            }
            blocks.push(toolUseBlock);
          } else if (block.type === 'tool_result') {
            // Log tool_result for debugging
            console.log(`[StreamHandler] Tool result received:`, JSON.stringify(block, null, 2));

            // Cache BashOutput results
            if (this.processTrackerService && this.pendingToolUses && block.content) {
              const toolUseInfo = this.pendingToolUses.get(block.tool_use_id);
              if (toolUseInfo && toolUseInfo.toolName === 'BashOutput') {
                const bashId = toolUseInfo.toolInput?.bash_id;
                if (bashId) {
                  const content = Array.isArray(block.content) ? block.content : [block.content];
                  for (const item of content) {
                    if (typeof item === 'string') {
                      // Parse XML structure from BashOutput
                      const statusMatch = item.match(/<status>(.*?)<\/status>/);
                      const exitCodeMatch = item.match(/<exit_code>(\d+)<\/exit_code>/);
                      const stdoutMatch = item.match(/<stdout>([\s\S]*?)<\/stdout>/);
                      const stderrMatch = item.match(/<stderr>([\s\S]*?)<\/stderr>/);

                      if (statusMatch) {
                        this.processTrackerService.cacheOutput(
                          bashId,
                          statusMatch[1],
                          stdoutMatch ? stdoutMatch[1].trim() : '',
                          stderrMatch ? stderrMatch[1].trim() : '',
                          exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : undefined,
                          undefined // summary will come from Claude's response
                        );
                      }
                    }
                  }
                }
                // Clean up pending tool use
                this.pendingToolUses.delete(block.tool_use_id);
              }
            }

            // Extract shell ID from background Bash tool_result
            if (this.processTrackerService && this.pendingBackgroundBash && block.content) {
              const content = Array.isArray(block.content) ? block.content : [block.content];
              for (const item of content) {
                if (typeof item === 'string') {
                  // Check for background bash response: "Command running in background with ID: XXXXX"
                  const shellIdMatch = item.match(/background with ID: (\w+)/);
                  if (shellIdMatch) {
                    const shellId = shellIdMatch[1];
                    const toolUseId = block.tool_use_id;
                    console.log(
                      `[StreamHandler] Extracted shell ID ${shellId} from tool_result (tool_use_id: ${toolUseId})`
                    );

                    // Extract output file path from the same result text
                    const outputFileMatch = item.match(/Output is being written to: (.+)/);
                    const outputFilePath = outputFileMatch ? outputFileMatch[1].trim() : undefined;

                    // Get metadata from pending map
                    const metadata = this.pendingBackgroundBash.get(toolUseId);
                    if (metadata) {
                      // Add process to tracker with actual shell ID (includes chatId)
                      this.processTrackerService.addProcess(
                        shellId,
                        metadata.command,
                        metadata.description,
                        metadata.userId,
                        metadata.chatId,
                        metadata.repoPath,
                        outputFilePath
                      );

                      // Clean up pending map
                      this.pendingBackgroundBash.delete(toolUseId);

                      // Emit to the client with shell ID
                      ws.send(
                        JSON.stringify({
                          type: 'runtime_state_update',
                          chat_id: chatId,
                          backgroundProcess: {
                            id: shellId,
                            command: metadata.command,
                            description: metadata.description,
                            chatId,
                            status: 'running',
                          },
                        })
                      );
                    }
                  }
                }
              }
            }

            // Handle KillShell tool_result - check tunnel health after shell is killed
            if (this.pendingToolUses) {
              const toolUseInfo = this.pendingToolUses.get(block.tool_use_id);
              if (toolUseInfo && toolUseInfo.toolName === 'KillShell' && this.tunnelService) {
                console.log(
                  `[StreamHandler] KillShell completed, waiting 1s before checking tunnel health`
                );
                // Wait 1 second for process to fully terminate before checking
                setTimeout(() => {
                  // Fire and forget - check health and broadcast results
                  this.tunnelService!.checkTunnelHealth(userId)
                    .then(() => {
                      const tunnels = this.tunnelService!.getUserTunnels(userId);
                      console.log(
                        `[StreamHandler] Broadcasting updated tunnels after health check:`,
                        tunnels
                      );
                      ws.send(
                        JSON.stringify({
                          type: 'runtime_state_update',
                          chat_id: chatId,
                          tunnels: tunnels.map((t: any) => ({
                            port: t.port,
                            url: t.url,
                            createdAt: t.createdAt,
                            active: t.active,
                          })),
                        })
                      );
                    })
                    .catch((err: any) => {
                      console.error(`[StreamHandler] Tunnel health check failed:`, err);
                    });
                }, 1000);
                // Clean up pending tool use
                this.pendingToolUses.delete(block.tool_use_id);
              }
            }

            // Check if this tool_result mentions browser close in the text
            const isBrowserClose = this.mediaProcessingService.checkForBrowserClose(block);

            if (isBrowserClose) {
              console.log(`[StreamHandler] Browser closed detected, checking for video...`);
              const videoBlock =
                this.mediaProcessingService.processVideoAfterBrowserClose(repoPath);
              if (videoBlock) {
                blocks.push(videoBlock);
              }
            }

            // Send the tool_result block to the client (for consolidation with tool_use)
            const toolResultBlock: any = {
              type: 'tool_result',
              blockId: randomUUID(), // Unique identifier for deduplication and references
              id: block.tool_use_id, // Use tool_use_id as the id for matching
              content: block.content,
              is_error: block.is_error, // Pass through error flag from SDK
              // ALWAYS add parent_tool_use_id to every block
              parent_tool_use_id: parentToolUseId || null,
              // Add timestamp for each block to track when it was created
              timestamp: Date.now(),
            };
            // Add sub-agent metadata if this is from a sub-agent
            if (subAgentInfo) {
              toolResultBlock.agentName = subAgentInfo.name;
              toolResultBlock.agentType = subAgentInfo.type;
              toolResultBlock.isSubAgent = true;
            }
            blocks.push(toolResultBlock);

            // Check if tool_result contains image/video blocks
            if (Array.isArray(block.content)) {
              for (const resultBlock of block.content) {
                if (resultBlock.type === 'image') {
                  // Process MCP image (convert base64 → URL)
                  const processedImage = this.mediaProcessingService.processMcpImage(
                    resultBlock,
                    userId
                  );

                  if (processedImage) {
                    // Successfully processed: use URL-based block
                    // Add parent_tool_use_id to the processed image block
                    processedImage.parent_tool_use_id = parentToolUseId || null;
                    blocks.push(processedImage);
                    console.log(`[StreamHandler] MCP image processed and saved to file`);
                  } else {
                    // Already URL or processing failed: pass through
                    blocks.push({
                      type: 'image',
                      blockId: randomUUID(), // Unique identifier for deduplication and references
                      source: resultBlock.source,
                      parent_tool_use_id: parentToolUseId || null,
                      timestamp: Date.now(),
                    });
                    console.log(`[StreamHandler] Image received (not base64 or processing failed)`);
                  }
                } else if (resultBlock.type === 'video') {
                  blocks.push({
                    type: 'video',
                    blockId: randomUUID(), // Unique identifier for deduplication and references
                    source: resultBlock.source,
                    parent_tool_use_id: parentToolUseId || null,
                    timestamp: Date.now(),
                  });
                  console.log(`[StreamHandler] Video received`);
                } else if (resultBlock.type === 'text' && resultBlock.text) {
                  console.log(`[StreamHandler] Tool result text:`, resultBlock.text);

                  // Check if text contains screenshot file paths from Playwright MCP
                  const screenshotBlock = this.mediaProcessingService.processScreenshot(
                    resultBlock.text,
                    repoPath,
                    userId
                  );
                  if (screenshotBlock) {
                    // Add parent_tool_use_id to screenshot block
                    screenshotBlock.parent_tool_use_id = parentToolUseId || null;
                    blocks.push(screenshotBlock);
                  }

                  // Check if text is a `display_video` confirmation pointing at a local
                  // PC file — copy it into the served media dir + emit a playable video
                  // block (the app can't fetch a raw /tmp path). See processDisplayVideo.
                  const displayVideoBlock = this.mediaProcessingService.processDisplayVideo(
                    resultBlock.text,
                    repoPath,
                    userId
                  );
                  if (displayVideoBlock) {
                    displayVideoBlock.parent_tool_use_id = parentToolUseId || null;
                    blocks.push(displayVideoBlock);
                  }
                }
              }
            }
          }
        }
      }
    }

    return blocks;
  }
}
