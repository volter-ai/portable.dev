/**
 * Pure mapping from the chat-messages-store snapshot to the set of activity
 * indicators that should be ACTIVE right now. Framework-free +
 * fully unit-testable.
 *
 * A chat shows an indicator while its run is `running` or `compressing` (the two
 * "Claude is working" statuses — mirroring `useChatStream.isWorking`). The
 * caption is a humanized label for the chat's most-recent `tool_use` block; the
 * title + repo come from an injected resolver (the wiring lives in
 * `ActivityIndicatorSync`).
 */

import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { ChatStatus } from '@vgit2/shared/types';

import type { MobileChatMessage } from '../chat/chatMessagesStore';

import type { ActivityInfo } from './types';

/** The statuses for which the indicator is shown. */
export const ACTIVE_STATUSES: readonly ChatStatus[] = ['running', 'compressing'];

/** Friendly captions for the common tools. */
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running a command',
  BashOutput: 'Running a command',
  Read: 'Reading files',
  Write: 'Writing files',
  Edit: 'Editing files',
  MultiEdit: 'Editing files',
  NotebookEdit: 'Editing files',
  Grep: 'Searching the code',
  Glob: 'Searching the code',
  Task: 'Delegating to a sub-agent',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching a page',
  TodoWrite: 'Planning',
  ExitPlanMode: 'Finishing the plan',
};

export function humanizeToolLabel(toolName?: string): string {
  if (!toolName) return 'Working…';
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  if (toolName.startsWith('mcp__playwright')) return 'Using the browser';
  if (toolName.startsWith('mcp__')) return 'Using a tool';
  return toolName;
}

/** The `toolName` of the most-recent `tool_use` block, searching backwards. */
export function lastToolName(messages: MobileChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.blocks) continue;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block: ClaudeStreamBlock = message.blocks[j];
      if (block.type === 'tool_use') return block.toolName;
    }
  }
  return undefined;
}

/** Resolved per-chat display metadata (title + `owner/repo`). */
export interface ActivityMeta {
  title: string;
  repoName: string;
}

export type ResolveActivityMeta = (chatId: string) => ActivityMeta;

export interface ActivitySnapshot {
  statuses: Record<string, ChatStatus>;
  messages: Record<string, MobileChatMessage[]>;
}

export function deriveActivityIndicators(
  snapshot: ActivitySnapshot,
  resolveMeta: ResolveActivityMeta
): ActivityInfo[] {
  const indicators: ActivityInfo[] = [];
  for (const [chatId, status] of Object.entries(snapshot.statuses)) {
    if (!ACTIVE_STATUSES.includes(status)) continue;
    const messages = snapshot.messages[chatId] ?? [];
    const meta = resolveMeta(chatId);
    indicators.push({
      chatId,
      title: meta.title,
      repoName: meta.repoName,
      lastToolLabel: humanizeToolLabel(lastToolName(messages)),
    });
  }
  return indicators;
}
