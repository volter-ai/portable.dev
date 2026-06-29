import { Server, Socket } from 'socket.io';

import { IOutputEmitter } from './IOutputEmitter';

/**
 * Socket.IO implementation of IOutputEmitter.
 * Broadcasts events to a Socket.IO room (chatId).
 */
export class SocketEmitter implements IOutputEmitter {
  constructor(
    private io: Server,
    private chatId: string,
    private userId: string,
    private getUserSockets: (userId: string) => Socket[],
    private broadcastRuntimeStateCallback?: (userId: string) => void
  ) {}

  emit(event: string, data: unknown): void {
    this.io.to(this.chatId).emit(event, data);
  }

  emitToUser(userId: string, event: string, data: unknown): void {
    const sockets = this.getUserSockets(userId);
    for (const socket of sockets) {
      socket.emit(event, data);
    }
  }

  joinUserToRoom(userId: string, roomId: string): void {
    const sockets = this.getUserSockets(userId);
    for (const socket of sockets) {
      socket.join(roomId);
    }
  }

  broadcastRuntimeStateToUser?(userId: string): void {
    // Use callback if provided (injected by SocketIOService)
    if (this.broadcastRuntimeStateCallback) {
      this.broadcastRuntimeStateCallback(userId);
    } else {
      console.log(
        `[SocketEmitter] broadcastRuntimeStateToUser called for ${userId} (no callback provided)`
      );
    }
  }

  /**
   * Check if a user has any active Socket.IO connections
   * Used for determining whether to send push notifications
   */
  isUserOnline(userId: string): boolean {
    const sockets = this.getUserSockets(userId);
    return sockets.length > 0;
  }
}
