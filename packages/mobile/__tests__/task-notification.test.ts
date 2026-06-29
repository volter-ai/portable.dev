import {
  isOnlyTaskNotification,
  stripTaskNotifications,
} from '../src/features/chat/taskNotification';

// The Claude Code / Agent SDK injects a `<task-notification>` status blob into the
// message stream when a background command changes state — it must never reach a chat
// bubble. These cover the strip + the "is it ONLY a notification" predicate the message
// list uses to hide the bubble entirely.
describe('taskNotification helpers', () => {
  const NOTE = [
    '<task-notification>',
    '<task-id>bvt6pifet</task-id>',
    '<tool-use-id>toolu_01S8gFaSgy97Nuh11ewUuaWq</tool-use-id>',
    '<output-file>/tmp/claude-1000/tasks/bvt6pifet.output</output-file>',
    '<status>killed</status>',
    '<summary>Background command "Start dev server" was stopped</summary>',
    '</task-notification>',
  ].join('\n');

  it('strips a notification-only string to empty (and flags it as notification-only)', () => {
    expect(stripTaskNotifications(NOTE)).toBe('');
    expect(isOnlyTaskNotification(NOTE)).toBe(true);
  });

  it('keeps the surrounding real content and removes the blob', () => {
    const mixed = `Deploy the app\n${NOTE}\nthanks`;
    const out = stripTaskNotifications(mixed);
    expect(out).toContain('Deploy the app');
    expect(out).toContain('thanks');
    expect(out).not.toContain('task-notification');
    expect(out).not.toContain('killed');
    expect(isOnlyTaskNotification(mixed)).toBe(false);
  });

  it('strips multiple consecutive notifications', () => {
    expect(stripTaskNotifications(`${NOTE}\n\n${NOTE}`)).toBe('');
    expect(isOnlyTaskNotification(`${NOTE}${NOTE}`)).toBe(true);
  });

  it('is a no-op for plain text / empty input', () => {
    expect(stripTaskNotifications('hello world')).toBe('hello world');
    expect(isOnlyTaskNotification('hello world')).toBe(false);
    expect(stripTaskNotifications('')).toBe('');
    expect(isOnlyTaskNotification('')).toBe(false);
  });
});
