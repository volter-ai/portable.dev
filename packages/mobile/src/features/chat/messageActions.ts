/**
 * messageActions — the AI follow-up action-button dispatcher.
 *
 * After a Claude turn the backend emits an `actions` content block carrying
 * `MessageAction[]` (e.g. "Gather content", "Start fix"). Tapping one of those
 * native chips (`blocks/AgentToolBlocks.ActionsBlock`) routes through here.
 * NO DEFAULTS — an action with no recognised intent is logged
 * and ignored, never silently sent.
 *
 * Kept as a framework-free pure function (the codebase's seam pattern) so the
 * exact web-parity branch table is unit-testable without mounting the screen.
 */

import type { MessageAction } from '@vgit2/shared/types';

/** The special prompt the backend recognises as "archive this chat". */
export const ARCHIVE_CHAT_PROMPT = '__archive_chat__';

export interface MessageActionHandlers {
  /** Send the action's prompt as a chat message immediately. */
  send: (prompt: string) => void;
  /** Pre-fill the composer input with the action's prompt for the user to edit. */
  prefill: (text: string) => void;
}

/**
 * Dispatch a tapped `MessageAction` to the right handler (web parity):
 *  - the special archive action (`prompt === '__archive_chat__'` OR
 *    `type === 'archive'`) → `send(prompt)` so the backend's archive handler fires;
 *  - `actionType === 'prefill_input'` → `prefill(prompt)` (edit-before-send);
 *  - `actionType === 'send_message'` → `send(prompt)` (send immediately);
 *  - anything else (no `actionType`) → logged + ignored (NO DEFAULTS, web parity).
 */
export function dispatchMessageAction(
  action: MessageAction,
  handlers: MessageActionHandlers
): void {
  // Special archive action — it has no `actionType`, it is keyed by the magic
  // prompt / `type: 'archive'` (web `ChatInstance.tsx:409`).
  if (action.prompt === ARCHIVE_CHAT_PROMPT || action.type === 'archive') {
    handlers.send(action.prompt);
    return;
  }

  if (action.actionType === 'prefill_input') {
    handlers.prefill(action.prompt);
    return;
  }

  if (action.actionType === 'send_message') {
    handlers.send(action.prompt);
    return;
  }

  // No actionType — do nothing (web logs + returns; never a silent default send).
  console.error('[chat] MessageAction missing actionType — ignoring:', action);
}
