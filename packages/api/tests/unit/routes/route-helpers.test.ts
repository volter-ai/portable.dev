/**
 * extractMessagePreview — the chat-list preview text builder (`GET /api/chats`).
 *
 * Guards public issue #11: a `<task-notification>` metadata blob (injected into the
 * message stream by the Claude Code / Agent SDK when a background command changes state)
 * must be stripped BEFORE the 100-char preview truncation. The mobile client strips
 * complete blocks at render time too, but truncation destroys the closing tag — so an
 * unstripped preview leaks raw XML into every chat card.
 */
import { describe, expect, it } from 'bun:test';

import { extractMessagePreview } from '../../../src/routes/utils/route-helpers';

const NOTE = [
  '<task-notification>',
  '<task-id>bvt6pifet</task-id>',
  '<tool-use-id>toolu_01S8gFaSgy97Nuh11ewUuaWq</tool-use-id>',
  '<output-file>/tmp/claude-1000/tasks/bvt6pifet.output</output-file>',
  '<status>killed</status>',
  '<summary>Background command "Start dev server" was stopped</summary>',
  '</task-notification>',
].join('\n');

describe('extractMessagePreview', () => {
  it('returns plain string content, truncated at 100 chars', () => {
    expect(extractMessagePreview({ content: 'hello' })).toBe('hello');
    expect(extractMessagePreview({ content: 'x'.repeat(150) })).toBe(`${'x'.repeat(100)}...`);
  });

  it('strips a task-notification blob BEFORE truncating (public issue #11)', () => {
    // The blob is ~250 chars — without the pre-truncation strip this would return the
    // first 100 chars of raw XML (no closing tag left for the client to match on).
    expect(extractMessagePreview({ content: NOTE })).toBe('');
    expect(extractMessagePreview({ content: `Deploy the app\n${NOTE}` })).toBe('Deploy the app');
  });

  it('strips a task-notification embedded in a text block', () => {
    expect(extractMessagePreview({ blocks: [{ type: 'text', text: `done\n${NOTE}` }] })).toBe(
      'done'
    );
  });

  it('PRESERVES a human message that merely mentions an unclosed marker', () => {
    // `content` is the full stored message, so a real SDK blob is always closed and
    // the strict strip removes only complete blocks. A human typing the literal marker
    // without a closing tag (e.g. discussing this very issue) must NOT be chopped —
    // that was the risk of using the truncation-tolerant preview variant here.
    const typed = 'Fix issue #11: the <task-notification> blob leaks into chat previews';
    expect(extractMessagePreview({ content: typed })).toBe(typed);
  });

  it('prefers customDisplay displayText, untouched', () => {
    expect(
      extractMessagePreview({
        customDisplay: { category: 'message', displayText: 'clean display' },
        content: NOTE,
      })
    ).toBe('clean display');
  });
});
