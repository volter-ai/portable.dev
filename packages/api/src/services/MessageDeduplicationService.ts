/**
 * MessageDeduplicationService
 *
 * Tracks recent message hashes to prevent duplicate message processing.
 * Extracts deduplication logic from SocketIOService for better separation of concerns.
 */
export class MessageDeduplicationService {
  // Track recent message hashes per user (userId -> array of recent hashes)
  // Keep last 5 hashes per user to detect duplicates within short time window
  private recentMessageHashes: Map<string, string[]> = new Map();

  /**
   * Check if a message is a duplicate
   * @param userId - User email (acts as user ID)
   * @param chatId - Chat ID
   * @param content - Message content
   * @returns true if duplicate, false otherwise
   */
  isDuplicate(userId: string, chatId: string, content: string): boolean {
    const recentMessages = this.recentMessageHashes.get(userId) || [];
    const messageHash = `${chatId}:${content}:${Date.now()}`;

    return recentMessages.includes(messageHash);
  }

  /**
   * Add a message hash to tracking
   * @param userId - User email (acts as user ID)
   * @param chatId - Chat ID
   * @param content - Message content
   */
  addHash(userId: string, chatId: string, content: string): void {
    const recentMessages = this.recentMessageHashes.get(userId) || [];
    const messageHash = `${chatId}:${content}:${Date.now()}`;

    // Add to front of array
    recentMessages.unshift(messageHash);

    // Keep only last 5 hashes
    if (recentMessages.length > 5) {
      recentMessages.pop();
    }

    this.recentMessageHashes.set(userId, recentMessages);
  }

  /**
   * Clean up old hashes (optional - could be called periodically)
   * Removes hashes older than 1 minute
   */
  cleanup(): void {
    const oneMinuteAgo = Date.now() - 60000;

    for (const [userId, hashes] of this.recentMessageHashes.entries()) {
      const validHashes = hashes.filter(hash => {
        // Extract timestamp from hash (format: "chatId:content:timestamp")
        const timestamp = parseInt(hash.split(':').pop() || '0');
        return timestamp > oneMinuteAgo;
      });

      if (validHashes.length === 0) {
        this.recentMessageHashes.delete(userId);
      } else {
        this.recentMessageHashes.set(userId, validHashes);
      }
    }
  }

  /**
   * Get statistics (for monitoring/debugging)
   */
  getStats(): { userCount: number; totalHashes: number } {
    let totalHashes = 0;
    for (const hashes of this.recentMessageHashes.values()) {
      totalHashes += hashes.length;
    }

    return {
      userCount: this.recentMessageHashes.size,
      totalHashes,
    };
  }
}
