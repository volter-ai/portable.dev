/**
 * TestEmitter - IOutputEmitter implementation for testing
 *
 * Captures events for assertions without requiring Socket.IO.
 * This allows testing ChatExecutionService in complete isolation.
 *
 * Usage:
 *   const emitter = new TestEmitter();
 *   const context = { ...otherProps, emitter };
 *   await chatExecutionService.executeMessage(context, message);
 *
 *   // Verify events were emitted
 *   expect(emitter.getEventCount('claude:stream')).toBeGreaterThan(0);
 *   expect(emitter.getLastEvent('claude:status')).toEqual({ status: 'completed' });
 */

import type { IOutputEmitter } from '../../../src/services/emitters/IOutputEmitter.js';

interface CapturedEvent {
  event: string;
  data: unknown;
  timestamp: number;
}

interface CapturedUserEvent {
  userId: string;
  event: string;
  data: unknown;
  timestamp: number;
}

export class TestEmitter implements IOutputEmitter {
  private events: CapturedEvent[] = [];
  private userEvents: CapturedUserEvent[] = [];

  /**
   * Emit an event to all clients (captured for testing)
   */
  emit(event: string, data: unknown): void {
    this.events.push({
      event,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Emit to all sockets for a specific user (captured for testing)
   */
  emitToUser(userId: string, event: string, data: unknown): void {
    this.userEvents.push({
      userId,
      event,
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Join a user's sockets to a room (no-op for testing)
   */
  joinUserToRoom(userId: string, roomId: string): void {
    // No-op for testing - rooms don't exist in test environment
  }

  // Test assertion helpers

  /**
   * Get all events, optionally filtered by event name
   */
  getEvents(eventName?: string): CapturedEvent[] {
    if (eventName) {
      return this.events.filter(e => e.event === eventName);
    }
    return this.events;
  }

  /**
   * Get count of events with a specific name
   */
  getEventCount(eventName: string): number {
    return this.events.filter(e => e.event === eventName).length;
  }

  /**
   * Get the last event with a specific name
   */
  getLastEvent(eventName: string): CapturedEvent | undefined {
    const filtered = this.events.filter(e => e.event === eventName);
    return filtered[filtered.length - 1];
  }

  /**
   * Get the first event with a specific name
   */
  getFirstEvent(eventName: string): CapturedEvent | undefined {
    return this.events.find(e => e.event === eventName);
  }

  /**
   * Get all user events, optionally filtered by userId or event name
   */
  getUserEvents(userId?: string, eventName?: string): CapturedUserEvent[] {
    let filtered = this.userEvents;

    if (userId) {
      filtered = filtered.filter(e => e.userId === userId);
    }

    if (eventName) {
      filtered = filtered.filter(e => e.event === eventName);
    }

    return filtered;
  }

  /**
   * Check if a specific event was emitted
   */
  hasEvent(eventName: string): boolean {
    return this.events.some(e => e.event === eventName);
  }

  /**
   * Get all event names that were emitted
   */
  getEventNames(): string[] {
    return Array.from(new Set(this.events.map(e => e.event)));
  }

  /**
   * Reset all captured events (call in beforeEach)
   */
  reset(): void {
    this.events = [];
    this.userEvents = [];
  }

  /**
   * Get total number of events captured
   */
  getTotalEventCount(): number {
    return this.events.length;
  }

  /**
   * Wait for a specific event to be emitted (useful for async testing)
   * Returns the event data or undefined if timeout
   */
  async waitForEvent(eventName: string, timeoutMs: number = 5000): Promise<unknown | undefined> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const event = this.getLastEvent(eventName);
      if (event) {
        return event.data;
      }
      // Wait 50ms before checking again
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return undefined;
  }

  /**
   * Get all events in chronological order
   */
  getAllEventsChronological(): CapturedEvent[] {
    return [...this.events].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Debug helper - print all captured events
   */
  printEvents(): void {
    console.log('=== TestEmitter Captured Events ===');
    this.events.forEach((event, index) => {
      console.log(`${index + 1}. ${event.event}:`, event.data);
    });
    console.log('===================================');
  }
}
