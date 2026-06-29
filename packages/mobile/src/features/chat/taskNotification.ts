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
 * something the user should read — left untouched it leaks into a chat bubble as a raw
 * XML blob (the same class of leak as the autopilot completion instruction, see
 * {@link stripAutopilotCompletionInstruction}). These helpers strip it from any text we
 * render so the chat stays clean while the agent still receives the notification.
 */

/** Matches one `<task-notification>…</task-notification>` block (case-insensitive, multi-line). */
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>/gi;

/** Cheap presence probe so the common no-op path never runs the regex. */
function hasTaskNotification(text: string): boolean {
  return text.includes('<task-notification');
}

/** Remove every `<task-notification>…</task-notification>` block and trim the remainder. */
export function stripTaskNotifications(text: string): string {
  if (!text || !hasTaskNotification(text)) return text;
  return text.replace(TASK_NOTIFICATION_RE, '').trim();
}

/** True when `text` is ENTIRELY task-notification(s) — nothing user-visible remains. */
export function isOnlyTaskNotification(text: string): boolean {
  if (!text || !hasTaskNotification(text)) return false;
  return stripTaskNotifications(text).length === 0;
}
