import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * MessageQueue - Async queue for feeding messages to Claude SDK
 *
 * Architecture:
 * - Supports continuous message injection without ending the session
 * - Iterator blocks on dequeue() when queue is empty (natural pause)
 * - Enqueuing a message wakes up the iterator
 * - Session stays alive indefinitely until explicitly closed/aborted
 * - abort() rejects blocked waiters so generator exits immediately
 */

export interface QueuedMessage<T> {
  data: T;
  timestamp: number;
}

export class MessageQueue<T> {
  private queue: QueuedMessage<T>[] = [];
  private waiters: Array<{
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    createdAt: number;
  }> = [];
  private closed = false;

  enqueue(message: T): void {
    if (this.closed) {
      console.warn('[MessageQueue] enqueue() on closed queue — ignoring');
      return;
    }

    const queued: QueuedMessage<T> = { data: message, timestamp: Date.now() };

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(queued.data);
    } else {
      this.queue.push(queued);
    }
  }

  async dequeue(): Promise<T> {
    if (this.closed && this.queue.length === 0) {
      throw new Error('Queue closed');
    }

    if (this.queue.length > 0) {
      return this.queue.shift()!.data;
    }

    // Block until a message arrives, queue is closed, or abort() rejects
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve, reject, createdAt: Date.now() });
    });
  }

  close(): void {
    this.closed = true;
    // Clear waiters (they remain unresolved — generator loop condition exits)
    this.waiters = [];
  }

  abort(): void {
    this.closed = true;

    const waitersToReject = this.waiters;
    this.waiters = [];

    const abortError = new Error('Queue aborted: subprocess died');
    for (const waiter of waitersToReject) {
      waiter.reject(abortError);
    }

    this.queue = [];
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  size(): number {
    return this.queue.length;
  }

  isClosed(): boolean {
    return this.closed;
  }

  waitersCount(): number {
    return this.waiters.length;
  }
}

/**
 * Create an async generator that yields messages from a queue.
 *
 * 1. Yields the initial message immediately
 * 2. Blocks at dequeue() when queue is empty (natural pause)
 * 3. Wakes up when new message is enqueued (or abort() rejects the waiter)
 * 4. Continues until queue is closed/aborted
 *
 * When the subprocess dies, the unified finally block in ExecutionHandler
 * calls inputQueue.abort() which rejects the blocked dequeue() promise,
 * causing the catch block to fire and the generator to exit cleanly.
 */
export async function* createMessageGenerator(
  initialMessage: SDKUserMessage,
  queue: MessageQueue<SDKUserMessage>
): AsyncIterableIterator<SDKUserMessage> {
  yield initialMessage;

  try {
    while (!queue.isClosed() || !queue.isEmpty()) {
      const message = await queue.dequeue();
      yield message;
    }
  } catch (error: any) {
    // Queue aborted (subprocess died) or closed — exit generator cleanly
    if (!error?.message?.includes('Queue aborted') && !error?.message?.includes('Queue closed')) {
      console.error('[MessageGenerator] Unexpected error:', error?.message);
    }
  }
}
