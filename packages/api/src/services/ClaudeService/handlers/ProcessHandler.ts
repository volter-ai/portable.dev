import type { ClaudeSession } from '../../../types/index.js';
import type { HandlerDependencies, CheckBashOutputResult } from '../types.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * ProcessHandler - Manages background bash process checking
 * Responsibilities:
 * - Check bash output for background processes
 * - Inject BashOutput tool requests into sessions
 * - Poll and return cached process output
 */
export class ProcessHandler {
  private processTrackerService?: any;
  private claudeCodeSessions: Map<string, ClaudeSession>;

  constructor(dependencies: HandlerDependencies, claudeCodeSessions: Map<string, ClaudeSession>) {
    this.processTrackerService = dependencies.processTrackerService;
    this.claudeCodeSessions = claudeCodeSessions;
  }

  /**
   * Check bash output for a background process
   * Injects a BashOutput tool request into the session and polls for results
   *
   * @param bashId - Bash process ID to check
   * @returns Process status, output, and optional summary
   */
  async checkBashOutput(bashId: string): Promise<{
    status: string;
    exitCode?: number;
    stdout: string;
    stderr: string;
    summary?: string;
  }> {
    console.log(`[ProcessHandler] Checking bash output for process: ${bashId}`);

    // Find which chat owns this bash process
    if (!this.processTrackerService) {
      throw new Error('ProcessTrackerService not available');
    }

    const chatId = this.processTrackerService.getChatIdForBashId(bashId);
    if (!chatId) {
      console.error(`[ProcessHandler] No chat found for bash ID ${bashId}`);
      return {
        status: 'not_found',
        stdout: '',
        stderr: 'Process not found - may have been cleaned up',
      };
    }

    console.log(`[ProcessHandler] Bash ${bashId} belongs to chat ${chatId}`);

    const session = this.claudeCodeSessions.get(chatId);
    if (!session || !session.inputQueue) {
      console.error(`[ProcessHandler] Session ${chatId} not found or has no inputQueue`);
      return {
        status: 'session_ended',
        stdout: '',
        stderr: 'Session has ended - cannot check process output',
      };
    }

    try {
      // Get the process to find userId
      const allProcesses = this.processTrackerService.getAllProcesses();
      const process = allProcesses.find((p: any) => p.id === bashId);
      const userId = process?.userId;

      // Set refreshing state
      this.processTrackerService.setRefreshing(bashId, true);

      // Broadcast updated state to user
      if (userId) {
        // TODO: Get SocketIOService reference to broadcast
        // For now, the state will be broadcast when BashOutput completes
      }

      // Inject BashOutput request into the session
      console.log(`[ProcessHandler] Injecting BashOutput request into session ${chatId}`);

      const bashOutputMessage: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: `Use the BashOutput tool to check bash_id "${bashId}". Tell me if something is wrong.`,
        },
        session_id: session.session_id || chatId,
        parent_tool_use_id: null,
      };

      // Enqueue the message - iterator will wake up and process it
      session.inputQueue.enqueue(bashOutputMessage);

      // Mark session as actively processing
      session.isProcessing = true;

      console.log(`[ProcessHandler] Waiting for BashOutput result... (isProcessing=true)`);

      // Wait for cache to be updated (with timeout)
      const maxWaitTime = 10000; // 10 seconds
      const startTime = Date.now();
      const initialCacheTime = this.processTrackerService.getCachedOutput(bashId)?.lastUpdated || 0;

      while (Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, 200)); // Poll every 200ms

        const cached = this.processTrackerService.getCachedOutput(bashId);
        if (cached && cached.lastUpdated > initialCacheTime) {
          console.log(`[ProcessHandler] Cache updated, returning fresh data`);
          return cached;
        }
      }

      // Timeout - return what we have
      console.log(`[ProcessHandler] Timeout waiting for BashOutput, returning cached data`);
      const cached = this.processTrackerService.getCachedOutput(bashId);
      if (cached) {
        return cached;
      }

      return {
        status: 'timeout',
        stdout: '',
        stderr: 'Timeout waiting for output',
      };
    } catch (error: any) {
      console.error(`[ProcessHandler] Error checking bash output:`, error);
      return {
        status: 'error',
        stdout: '',
        stderr: error.message || 'Failed to check output',
      };
    }
  }
}
