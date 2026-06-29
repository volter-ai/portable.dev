/**
 * Interface for output emission during Claude execution.
 *
 * This abstraction allows the same execution logic to work with:
 * - SocketEmitter: Real-time broadcast to connected clients
 * - NoOpEmitter: Headless execution (routines, testing)
 * - Future: SSE, WebSocket, logging emitters, etc.
 *
 * Note: Database persistence is NOT part of this interface - it always happens.
 * The emitter only controls the real-time notification layer.
 */
export interface IOutputEmitter {
  /**
   * Emit an event to connected clients (or no-op if none).
   * @param event - Event name (e.g., "claude:stream", "claude:status")
   * @param data - Event payload
   */
  emit(event: string, data: unknown): void | Promise<void>;

  /**
   * Emit to all sockets for a specific user.
   * Used for user-wide broadcasts like "chat:created".
   * @param userId - User email/ID
   * @param event - Event name
   * @param data - Event payload
   */
  emitToUser?(userId: string, event: string, data: unknown): void;

  /**
   * Join a user's sockets to a room.
   * Used when a new chat is created and user needs to receive future messages.
   * @param userId - User email/ID
   * @param roomId - Room/chat ID to join
   */
  joinUserToRoom?(userId: string, roomId: string): void;

  /**
   * Broadcast runtime state (tunnels) to all user's sockets.
   * Used when runtime state changes (tunnel created, etc.).
   * @param userId - User email/ID
   */
  broadcastRuntimeStateToUser?(userId: string): void;
}
