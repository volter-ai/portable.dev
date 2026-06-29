import { IOutputEmitter } from './IOutputEmitter';

import type { ChatService } from '../ChatService';

/**
 * No-op implementation of IOutputEmitter.
 * Used for headless execution (routines, testing) where no real-time
 * client notification is needed.
 *
 * Note: Database persistence still happens - this only disables
 * real-time Socket.IO emission.
 */
export class NoOpEmitter implements IOutputEmitter {
  private debug: boolean;
  private chatService?: ChatService;
  private userId?: string;
  private authToken?: string;

  constructor(options?: {
    debug?: boolean;
    chatService?: ChatService;
    userId?: string;
    authToken?: string;
  }) {
    this.debug = options?.debug ?? false;
    this.chatService = options?.chatService;
    this.userId = options?.userId;
    this.authToken = options?.authToken;
  }

  async emit(event: string, data: unknown): Promise<void> {
    if (this.debug) {
      console.log(
        `[NoOpEmitter] ${event}:`,
        typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : data
      );
    }

    // Handle critical events that need database updates even without real-time clients
    if (event === 'claude:error' && this.chatService && this.userId && this.authToken) {
      const errorData = data as { chatId: string; error: string };
      if (errorData.chatId) {
        // Update chat status to error in database
        // Non-critical operation - don't throw if it fails (e.g., during test cleanup)
        this.chatService
          .updateChatStatus(errorData.chatId, this.userId, 'error', this.authToken)
          .catch((err: any) => {
            console.error(`[NoOpEmitter] Failed to update chat status to error:`, err);
          });

        // Buffer error message
        // Non-critical operation - don't throw if it fails (e.g., RLS errors during test cleanup)
        this.chatService
          .bufferMessage(
            this.userId,
            errorData.chatId,
            'error_message',
            { content: `⚠️ Error: ${errorData.error}`, timestamp: Date.now() },
            this.authToken
          )
          .catch((err: any) => {
            console.error(`[NoOpEmitter] Failed to buffer error message:`, err);
          });
      }
    }
  }

  emitToUser(_userId: string, event: string, data: unknown): void {
    if (this.debug) {
      console.log(
        `[NoOpEmitter] (to user) ${event}:`,
        typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : data
      );
    }
    // No-op
  }

  joinUserToRoom(_userId: string, _roomId: string): void {
    // No-op - no sockets to join
  }
}
