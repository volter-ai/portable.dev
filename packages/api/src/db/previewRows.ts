/**
 * Preview-row selection for the chat list (`getChatsWithPreviews`).
 *
 * A `<task-notification>` background-task status blob is injected into the message
 * stream as a `user_message` — machine context for the agent, never user-visible. The
 * chat PAGE hides those rows at render time; the LIST previews are built server-side,
 * so the same rows must be skipped when picking `first/last_message_data` or the raw
 * XML becomes the card title/preview (public issue #11).
 */
import { isOnlyTaskNotification } from '@vgit2/shared/utils/taskNotificationHelpers';

import type { MessageRow } from './JsonDbAdapter/JsonChatStore.js';

/** True for a `user_message` row whose content is ENTIRELY task-notification(s). */
export function isTaskNotificationRow(row: MessageRow): boolean {
  if (row.type !== 'user_message') return false;
  const data = row.data as { content?: unknown; text?: unknown } | null | undefined;
  const content =
    typeof data?.content === 'string'
      ? data.content
      : typeof data?.text === 'string'
        ? data.text
        : '';
  return isOnlyTaskNotification(content);
}

/**
 * Pick the chat-card preview rows from an ordered message stream: the first REAL user
 * message and the last non-notification message. Notification rows still count toward
 * `message_count` — they are only skipped as preview candidates.
 */
export function pickPreviewRows(messages: MessageRow[]): {
  firstUserMessage?: MessageRow;
  lastMessage?: MessageRow;
} {
  const firstUserMessage = messages.find(
    (m) => m.type === 'user_message' && !isTaskNotificationRow(m)
  );
  let lastMessage: MessageRow | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isTaskNotificationRow(messages[i])) {
      lastMessage = messages[i];
      break;
    }
  }
  return { firstUserMessage, lastMessage };
}
