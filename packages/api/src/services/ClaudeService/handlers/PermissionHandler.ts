import type { HandlerDependencies, PermissionRequest } from '../types.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * PermissionHandler - Manages tool permission requests and resolution
 * Responsibilities:
 * - Track pending permission requests
 * - Resolve permission requests (approve/deny)
 * - Handle AskUserQuestion answers injection
 * - Clean up expired permission requests
 */
export class PermissionHandler {
  private permissionRequests: Map<string, PermissionRequest>;
  // Map of chatId+toolName to permission request ID (for matching tool_use blocks)
  // Format: "chatId:toolName" -> requestId
  private pendingPermissions: Map<string, string>;

  constructor(
    dependencies: HandlerDependencies,
    permissionRequests: Map<string, PermissionRequest>,
    pendingPermissions: Map<string, string>
  ) {
    this.permissionRequests = permissionRequests;
    this.pendingPermissions = pendingPermissions;
  }

  /**
   * Resolve a permission request with user's decision
   * This is called when user approves or denies a tool use permission
   *
   * @param requestId - Unique ID for this permission request
   * @param approved - Whether user approved the tool use
   * @param answers - Optional answers from AskUserQuestion tool (injected as updatedInput)
   *
   * @return Object with success status and message
   */
  resolvePermissionRequest(
    requestId: string,
    approved: boolean,
    answers?: Record<string, string[]>
  ) {
    const request = this.permissionRequests.get(requestId);

    if (!request) {
      console.warn(
        `[PermissionHandler] Permission request ${requestId} not found or already resolved`
      );
      return { success: false, message: 'Request not found', code: 'request_lost' };
    }

    console.log(
      `[PermissionHandler] Resolving permission request ${requestId}: ${approved ? 'APPROVED' : 'DENIED'}`
    );
    console.log(`[PermissionHandler]   Tool: ${request.toolName}`);
    console.log(`[PermissionHandler]   Chat: ${request.chatId}`);

    // If this is an AskUserQuestion with answers, include them in the log
    if (request.toolName === 'AskUserQuestion' && answers) {
      console.log(`[PermissionHandler]   User answers:`, answers);
    }

    // Remove from pending requests
    this.permissionRequests.delete(requestId);

    // Resolve the promise that canUseTool is waiting on
    if (approved) {
      // For AskUserQuestion, inject user answers as updatedInput
      // SDK will receive the tool call with answers already filled in
      const updatedInput =
        request.toolName === 'AskUserQuestion' && answers
          ? { ...request.toolInput, answers }
          : request.toolInput;

      request.resolve({
        behavior: 'allow',
        updatedInput,
      });
    } else {
      request.resolve({
        behavior: 'deny',
        message: `Permission denied by user for tool: ${request.toolName}. The user has chosen not to allow this action. Please acknowledge this and ask the user how they would like to proceed, or suggest alternative approaches that don't require this specific tool.`,
      });
    }

    return { success: true, message: 'Request resolved', code: 'request_resolved' };
  }

  /**
   * Create a permission request (called from canUseTool callback)
   * Returns a promise that will be resolved when user responds
   *
   * @param chatId - Chat ID
   * @param toolName - Tool name
   * @param toolInput - Tool input parameters
   * @returns Promise that resolves with PermissionResult
   */
  createPermissionRequest(
    chatId: string,
    toolName: string,
    toolInput: any
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const requestId = `${chatId}-${toolName}-${Date.now()}`;
      console.log(`[PermissionHandler] Creating permission request ${requestId}`);

      this.permissionRequests.set(requestId, {
        resolve,
        toolName,
        toolInput,
        chatId,
        timestamp: Date.now(),
      });

      // Track pending permission for this chat+tool combination
      this.pendingPermissions.set(`${chatId}:${toolName}`, requestId);
    });
  }

  /**
   * Get permission request by ID
   */
  getPermissionRequest(requestId: string): PermissionRequest | undefined {
    return this.permissionRequests.get(requestId);
  }

  /**
   * Get pending permission request ID for a chat+tool combination
   */
  getPendingPermissionRequestId(chatId: string, toolName: string): string | undefined {
    return this.pendingPermissions.get(`${chatId}:${toolName}`);
  }

  /**
   * Clean up all permission requests for a specific chat
   * Called when a session is stopped or cleaned up
   */
  cleanupChatPermissions(chatId: string): void {
    const keysToDelete: string[] = [];
    const pendingKeysToDelete: string[] = [];

    for (const [requestId, request] of this.permissionRequests.entries()) {
      if (request.chatId === chatId) {
        keysToDelete.push(requestId);
        pendingKeysToDelete.push(`${chatId}:${request.toolName}`);
      }
    }

    if (keysToDelete.length > 0) {
      console.log(`[PermissionHandler] Cleaning up ${keysToDelete.length} permission requests`);
      keysToDelete.forEach((key) => this.permissionRequests.delete(key));
      pendingKeysToDelete.forEach((key) => this.pendingPermissions.delete(key));
    }
  }
}
