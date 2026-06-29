/**
 * Transport-agnostic message dedup & consolidation.
 *
 * Pure functions (no React, no DOM) used by the React Native (`packages/mobile`)
 * client to apply consistent deduplication and tool-block consolidation to
 * streamed/buffered messages.
 */

import type { ChatMessage, ClaudeCodeBlock } from '../types/index.js';

/**
 * Consolidates `tool_use` and `tool_result` blocks across messages.
 * Handles cases where tool blocks get split across different messages
 * (e.g., when a user types during tool execution): the matching
 * `tool_result` is attached to its `tool_use` block, and assistant messages
 * left holding only orphaned `tool_result` blocks are dropped.
 *
 * @param messages - Array of chat messages to consolidate
 * @returns Array of consolidated messages with tool results attached to tool_use blocks
 */
export function consolidateToolMessages(messages: ChatMessage[]): ChatMessage[] {
  // Build a map of tool_result blocks by ID across all messages
  const toolResults = new Map<string, { content: unknown; is_error?: boolean }>();

  // First pass: Find all tool_result blocks across all messages
  messages.forEach((msg) => {
    if (msg.role === 'assistant' && msg.blocks) {
      msg.blocks.forEach((block) => {
        if (block.type === 'tool_result' && block.id) {
          toolResults.set(block.id, {
            content: block.content,
            is_error: block.is_error,
          });
        }
      });
    }
  });

  // Second pass: Attach results to matching tool_use blocks
  const consolidated = messages.map((msg) => {
    if (msg.role === 'assistant' && msg.blocks) {
      const updatedBlocks = msg.blocks.map((block) => {
        if (block.type === 'tool_use' && block.id && toolResults.has(block.id)) {
          // Attach the result to this tool_use block
          const result = toolResults.get(block.id);
          return {
            ...block,
            result,
          } as ClaudeCodeBlock;
        }
        return block;
      });
      return { ...msg, blocks: updatedBlocks };
    }
    return msg;
  });

  // Third pass: Remove messages that only contain orphaned tool_result blocks
  return consolidated.filter((msg) => {
    if (msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0) {
      // Keep message if it has at least one non-tool_result block
      // (text, tool_use, etc.) — empty messages are kept as a safety check.
      const hasNonResultBlocks = msg.blocks.some((b) => b.type !== 'tool_result');
      return hasNonResultBlocks;
    }
    // Keep all non-assistant messages and empty messages
    return true;
  });
}

/**
 * Detects whether `newMsg` is a *sequential* duplicate of `lastMsg` — i.e. an
 * identical message that immediately follows it. Only consecutive identical
 * messages are filtered (never all duplicates), so legitimately repeated
 * content later in the conversation is preserved.
 */
export function isSequentialDuplicate(lastMsg: ChatMessage, newMsg: ChatMessage): boolean {
  // Must be same role
  if (lastMsg.role !== newMsg.role) return false;

  // For user messages: check timestamp + content
  if (newMsg.role === 'user') {
    if (typeof lastMsg.content === 'string' && typeof newMsg.content === 'string') {
      return lastMsg.timestamp === newMsg.timestamp && lastMsg.content === newMsg.content;
    }
  }

  // For assistant messages: check blocks (more complex)
  if (newMsg.role === 'assistant') {
    const lastBlocks = lastMsg.blocks || [];
    const newBlocks = newMsg.blocks || [];

    // If block counts differ, not duplicate
    if (lastBlocks.length !== newBlocks.length) return false;

    // If no blocks, compare content
    if (lastBlocks.length === 0) {
      return lastMsg.content === newMsg.content;
    }

    // Check if all blocks match by ID and type
    return newBlocks.every((block, i) => {
      const lastBlock = lastBlocks[i];
      return lastBlock.id === block.id && lastBlock.type === block.type;
    });
  }

  return false;
}
