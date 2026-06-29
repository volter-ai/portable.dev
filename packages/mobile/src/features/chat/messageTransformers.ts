/**
 * messageTransformers — `chat:join` history → renderable messages.
 *
 * The backend's join ack carries raw `BufferedMessage`s
 * (`{ id: number, type, data, timestamp }`), NOT chat messages — they must be
 * transformed before they ever reach the message list. This transform produces
 * `MobileChatMessage`s for `chatMessagesStore`:
 *
 *   - `user_message` / `assistant_message` / `claude_code_stream` / `tool_use` /
 *     `tool_result` / `claude_code_block` / `claude_code_error` map to messages;
 *   - status/control messages (`claude_code_start`, `chat_status_update`,
 *     `claude_code_complete`, `runtime_state_update`, `navigate`) are dropped;
 *   - consecutive assistant messages are CONSOLIDATED into one (merging their
 *     block lists, deduplicated), so a chat re-opens with the
 *     same message structure the live stream produced.
 *
 * The numeric buffered id is preserved (stringified) on the message: it is the
 * FlatList key and the auto-mark-as-read cursor (`chat:mark_read` acks numeric
 * ids). A consolidated assistant message keeps the LATEST merged id so viewing
 * it marks everything it contains as read.
 */

import type { BufferedMessage } from '@vgit2/shared/types';
import { stripAutopilotCompletionInstruction } from '@vgit2/shared/utils/autopilotHelpers';
import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import type { MobileChatMessage } from './chatMessagesStore';

/** Loosely-typed buffered payload (the wire `data` varies by message type). */
type BufferedData = Record<string, unknown> & {
  content?: unknown;
  blocks?: ClaudeStreamBlock[];
  customDisplay?: {
    category?: string;
    /** `category: 'message' | 'plainMessage'` — the clean user-visible text. */
    displayText?: string;
    /** Populated only when `category: 'quickAction'` (e.g. the auto-pilot
     *  auto-continue pill) — the pill label shown instead of the augmented prompt. */
    action?: { label?: string; labelBold?: string };
  };
};

/** Extract the text of a message's `text` blocks (web parity for `content`). */
function textFromBlocks(blocks: ClaudeStreamBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.content ?? b.text ?? '')
    .join('\n');
}

/**
 * Transform one BufferedMessage into a MobileChatMessage, or `null` for the
 * status/control types that are events rather than chat content.
 */
export function transformBufferedMessage(buffered: BufferedMessage): MobileChatMessage | null {
  const { type, timestamp } = buffered;
  const data = (buffered.data ?? {}) as BufferedData;
  const id = buffered.id !== undefined && buffered.id !== null ? String(buffered.id) : undefined;

  if (type === 'user_message') {
    // Autopilot leaks: the persisted `content` is the AUGMENTED prompt (the user text
    // plus the completion instruction), which must never be shown. Resolve the
    // user-visible text in this order:
    //   1. quick-action customDisplay (e.g. the auto-pilot auto-continue) → its label;
    //   2. plain/message customDisplay → its displayText (the clean user text);
    //   3. otherwise the raw content with the injected instruction stripped off.
    const cd = data.customDisplay;
    let content: string;
    if (cd?.category === 'quickAction' && typeof cd.action?.label === 'string') {
      content = `${cd.action.label}${cd.action.labelBold ?? ''}`;
    } else if (typeof cd?.displayText === 'string') {
      content = cd.displayText;
    } else {
      content = stripAutopilotCompletionInstruction((data.content as string) ?? '');
    }
    return { id, role: 'user', content, timestamp };
  }

  if (type === 'assistant_message') {
    return {
      id,
      role: 'assistant',
      content: (data.content as string) ?? '',
      blocks: data.blocks,
      timestamp,
    };
  }

  if (type === 'claude_code_stream') {
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    return {
      id,
      role: 'assistant',
      content: textFromBlocks(blocks),
      blocks,
      timestamp,
    };
  }

  if (type === 'tool_use') {
    const toolBlock: ClaudeStreamBlock = {
      type: 'tool_use',
      id: data.id as string | undefined,
      toolName: (data.toolName ?? data.name) as string | undefined,
      toolInput: data.toolInput ?? data.input,
    };
    return { id, role: 'assistant', content: '', blocks: [toolBlock], timestamp };
  }

  if (type === 'tool_result') {
    const resultBlock: ClaudeStreamBlock = {
      type: 'tool_result',
      id: data.id as string | undefined,
      content: data.content as string | undefined,
    };
    return { id, role: 'assistant', content: '', blocks: [resultBlock], timestamp };
  }

  // Individual persisted block (`claude_code_block`) — the data IS the block.
  if (type === 'claude_code_block') {
    const block = data as unknown as ClaudeStreamBlock;
    return {
      id,
      role: 'assistant',
      content: block.type === 'text' ? (block.content ?? block.text ?? '') : '',
      blocks: [block],
      timestamp,
    };
  }

  // Persisted error — the data is the errorBlock from formatErrorAsBlock.
  if (type === 'claude_code_error') {
    return {
      id,
      role: 'assistant',
      content: '',
      blocks: [data as unknown as ClaudeStreamBlock],
      timestamp,
    };
  }

  // Status / control messages render as nothing (handled as events on the web too).
  return null;
}

/** True when `block` already exists in `existing` (blockId, id+type, or text content). */
function isDuplicateBlock(existing: ClaudeStreamBlock[], block: ClaudeStreamBlock): boolean {
  return existing.some(
    (b) =>
      (!!block.blockId && b.blockId === block.blockId) ||
      (!!block.id && b.id === block.id && b.type === block.type) ||
      (!block.blockId &&
        !block.id &&
        block.type === 'text' &&
        !!block.content &&
        b.type === 'text' &&
        b.content === block.content)
  );
}

/**
 * Transform a `chat:join` history into the ordered message list, consolidating
 * consecutive assistant messages (web `transformBufferedMessages` parity).
 */
export function transformBufferedMessages(buffered: BufferedMessage[]): MobileChatMessage[] {
  const messages = buffered
    .map(transformBufferedMessage)
    .filter((m): m is MobileChatMessage => m !== null);

  const consolidated: MobileChatMessage[] = [];
  for (const message of messages) {
    const last = consolidated[consolidated.length - 1];
    if (message.role === 'assistant' && last?.role === 'assistant') {
      const mergedBlocks = [...(last.blocks ?? [])];
      for (const block of message.blocks ?? []) {
        if (!isDuplicateBlock(mergedBlocks, block)) mergedBlocks.push(block);
      }
      const mergedContent = [last.content, message.content].filter(Boolean).join('\n');
      consolidated[consolidated.length - 1] = {
        ...last,
        // Keep the LATEST id/timestamp so mark-read covers the whole merge.
        id: message.id ?? last.id,
        timestamp: message.timestamp ?? last.timestamp,
        content: mergedContent,
        blocks: mergedBlocks,
      };
    } else {
      consolidated.push(message);
    }
  }
  return consolidated;
}
