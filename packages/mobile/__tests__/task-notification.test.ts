import {
  isOnlyTaskNotification,
  stripTaskNotifications,
  stripTaskNotificationsForPreview,
} from '../src/features/chat/taskNotification';

const NOTE = [
  '<task-notification>',
  '<task-id>bvt6pifet</task-id>',
  '<tool-use-id>toolu_01S8gFaSgy97Nuh11ewUuaWq</tool-use-id>',
  '<output-file>/tmp/claude-1000/tasks/bvt6pifet.output</output-file>',
  '<status>killed</status>',
  '<summary>Background command "Start dev server" was stopped</summary>',
  '</task-notification>',
].join('\n');

// The Claude Code / Agent SDK injects a `<task-notification>` status blob into the
// message stream when a background command changes state — it must never reach a chat
// bubble. These cover the strip + the "is it ONLY a notification" predicate the message
// list uses to hide the bubble entirely.
describe('taskNotification helpers', () => {
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

// The chat-LIST previews arrive pre-truncated (the backend cuts them at 100 chars), so
// the closing `</task-notification>` tag may be gone and the strict regex can't match —
// that's how raw XML leaked into the Continue Chats cards (public issue #11). The preview
// variant additionally drops an UNCLOSED trailing blob; it is for one-line previews/titles
// only (a full message body legitimately quoting the marker must use the strict strip).
describe('stripTaskNotificationsForPreview (truncation-tolerant)', () => {
  const TRUNCATED = `${NOTE.slice(0, 100)}...`;

  it('strips a truncated (unclosed) notification that the strict strip must leave alone', () => {
    expect(stripTaskNotifications(TRUNCATED)).toBe(TRUNCATED); // documents the strict gap
    expect(stripTaskNotificationsForPreview(TRUNCATED)).toBe('');
  });

  it('keeps real text preceding a truncated notification', () => {
    expect(stripTaskNotificationsForPreview(`Deploy the app\n${NOTE.slice(0, 60)}`)).toBe(
      'Deploy the app'
    );
  });

  it('still strips complete blocks (strict parity)', () => {
    const mixed = `Deploy the app\n${NOTE}\nthanks`;
    const out = stripTaskNotificationsForPreview(mixed);
    expect(out).toContain('Deploy the app');
    expect(out).toContain('thanks');
    expect(out).not.toContain('task-notification');
  });

  it('strips a complete block followed by a truncated one', () => {
    expect(stripTaskNotificationsForPreview(`${NOTE}\n${NOTE.slice(0, 40)}`)).toBe('');
  });

  it('is a no-op for plain text / empty input', () => {
    expect(stripTaskNotificationsForPreview('hello world')).toBe('hello world');
    expect(stripTaskNotificationsForPreview('')).toBe('');
  });
});
