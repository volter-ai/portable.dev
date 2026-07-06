/**
 * Background-task status notifications injected into the message stream by the Claude
 * Code / Agent SDK runtime when a background command changes state (starts, finishes, or
 * is killed) — e.g.
 *
 *   <task-notification>
 *     <task-id>bvt6pifet</task-id>
 *     <tool-use-id>toolu_…</tool-use-id>
 *     <output-file>/tmp/…/tasks/bvt6pifet.output</output-file>
 *     <status>killed</status>
 *     <summary>Background command "Start dev server" was stopped</summary>
 *   </task-notification>
 *
 * This is MACHINE CONTEXT for the agent (so it knows a background process ended), NOT
 * something the user should read — left untouched it leaks into a chat bubble or a
 * chat-list preview as a raw XML blob (the same class of leak as the autopilot completion
 * instruction, see `stripAutopilotCompletionInstruction`). Single-sourced here so the
 * mobile renderer AND the api's chat-list preview builder strip the same marker.
 */

/** Matches one complete `<task-notification>…</task-notification>` block (case-insensitive, multi-line). */
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/gi;

const TASK_NOTIFICATION_OPEN = '<task-notification';

/** Cheap presence probe so the common no-op path never runs the regex. */
function hasTaskNotification(text: string): boolean {
  return text.includes(TASK_NOTIFICATION_OPEN);
}

/** Remove every complete `<task-notification>…</task-notification>` block and trim the remainder. */
export function stripTaskNotifications(text: string): string {
  if (!text || !hasTaskNotification(text)) return text;
  return text.replace(TASK_NOTIFICATION_RE, '').trim();
}

/**
 * Preview-context strip: like {@link stripTaskNotifications}, but ALSO drops an UNCLOSED
 * trailing `<task-notification…` blob. Use this ONLY on already-TRUNCATED text whose
 * closing tag may have been cut off — in practice just the mobile `ChatCardBody`, which
 * can receive a 100-char-truncated preview from an older PC api that didn't strip
 * server-side (public issue #11). Do NOT use it on full text: the unclosed-marker chop
 * would destroy a real human message that merely mentions the marker without closing it.
 * The api strips full stored/transcript content with the strict {@link stripTaskNotifications}
 * (an SDK-injected blob is always complete there, so strict is lossless).
 */
export function stripTaskNotificationsForPreview(text: string): string {
  if (!text || !hasTaskNotification(text)) return text;
  const remainder = text.replace(TASK_NOTIFICATION_RE, '');
  const openIdx = remainder.indexOf(TASK_NOTIFICATION_OPEN);
  return (openIdx === -1 ? remainder : remainder.slice(0, openIdx)).trim();
}

/** True when `text` is ENTIRELY task-notification(s) — nothing user-visible remains. */
export function isOnlyTaskNotification(text: string): boolean {
  if (!text || !hasTaskNotification(text)) return false;
  return stripTaskNotifications(text).length === 0;
}
