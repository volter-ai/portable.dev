/**
 * rev9 Feature 3 / D29a — golden-file test for the ClaudeProjects transcript reader.
 *
 * A curated JSONL fixture mirroring the REAL `~/.claude/projects/*.jsonl` shapes
 * (Claude CLI 2.1.x, verified on disk): user string + user tool_result(image),
 * assistant turn split across thinking/text/tool_use sharing one message.id, a Task
 * tool_use (the getMessagesAfterId anchor), ai-title / custom-title / last-prompt /
 * queue-operation / attachment / isMeta / slash-command meta lines. Asserts the exact
 * reverse-mapped BufferedMessage[] the mobile renderer expects.
 */
import { describe, expect, it } from 'bun:test';

import {
  parseTranscript,
  transcriptCwd,
  transcriptIsEmpty,
  transcriptTitle,
  transcriptToMessages,
} from '../../../src/db/ClaudeProjects/transcriptReader';

const CWD = '/Users/dev/claude-workspace/local_host/BrunoCCPires/clock-app';
const SESSION = '5cdde407-a290-43ec-bd0a-a25e90f61123';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** Build a realistic transcript (file order) covering every line shape. */
function buildFixture(): string {
  return [
    // queue-operation (portable/meta — filtered)
    line({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-06-25T19:30:26.398Z',
      sessionId: SESSION,
      content: 'Vc tem acesso ao Playwright?',
    }),
    // user — string content (a human turn)
    line({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'Vc tem acesso ao Playwright?' },
      uuid: 'u1',
      timestamp: '2026-06-25T19:30:26.445Z',
      cwd: CWD,
      sessionId: SESSION,
      version: '2.1.170',
      gitBranch: 'main',
    }),
    // attachment (SDK tool-availability delta — filtered)
    line({
      type: 'attachment',
      attachment: { type: 'deferred_tools_delta', addedNames: ['x'] },
      uuid: 'a1',
      timestamp: '2026-06-25T19:30:26.500Z',
      cwd: CWD,
      sessionId: SESSION,
    }),
    // assistant turn msg_A: text + tool_use (Read), parentUuid-chained, shared message.id
    line({
      type: 'assistant',
      message: {
        id: 'msg_A',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Let me check the screenshot.' }],
      },
      uuid: 'as1',
      parentUuid: 'u1',
      timestamp: '2026-06-25T19:30:30.000Z',
      sessionId: SESSION,
    }),
    line({
      type: 'assistant',
      message: {
        id: 'msg_A',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read1',
            name: 'Read',
            input: { file_path: '/tmp/shot.png' },
          },
        ],
      },
      uuid: 'as2',
      parentUuid: 'as1',
      timestamp: '2026-06-25T19:30:31.000Z',
      sessionId: SESSION,
    }),
    // user — tool_result (image) for toolu_read1
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read1',
            is_error: null,
            content: [{ type: 'image' }],
          },
        ],
      },
      toolUseResult: { type: 'image' },
      uuid: 'u2',
      parentUuid: 'as2',
      timestamp: '2026-06-25T19:30:32.000Z',
      cwd: CWD,
      sessionId: SESSION,
    }),
    // assistant turn msg_B: thinking (SKIPPED) + text
    line({
      type: 'assistant',
      message: {
        id: 'msg_B',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'internal reasoning' }],
      },
      uuid: 'as3',
      parentUuid: 'u2',
      timestamp: '2026-06-25T19:30:40.000Z',
      sessionId: SESSION,
    }),
    line({
      type: 'assistant',
      message: {
        id: 'msg_B',
        role: 'assistant',
        content: [{ type: 'text', text: 'Yes, Playwright is available.' }],
      },
      uuid: 'as4',
      parentUuid: 'as3',
      timestamp: '2026-06-25T19:30:41.000Z',
      sessionId: SESSION,
    }),
    // ai-title (title carrier — filtered from the stream)
    line({ type: 'ai-title', aiTitle: 'Check Playwright package access', sessionId: SESSION }),
    // last-prompt (resume pointer — filtered)
    line({ type: 'last-prompt', lastPrompt: 'thanks', leafUuid: 'as4', sessionId: SESSION }),
    // isMeta user (filtered)
    line({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'meta noise' },
      uuid: 'um',
      timestamp: '2026-06-25T19:30:42.000Z',
      sessionId: SESSION,
    }),
    // slash-command user (filtered)
    line({
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
      uuid: 'uc',
      timestamp: '2026-06-25T19:30:43.000Z',
      sessionId: SESSION,
    }),
    // assistant tool_use Task (the getMessagesAfterId Task-anchor must survive)
    line({
      type: 'assistant',
      message: {
        id: 'msg_C',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_task1', name: 'Task', input: { description: 'sub' } },
        ],
      },
      uuid: 'as5',
      parentUuid: 'as4',
      timestamp: '2026-06-25T19:30:50.000Z',
      sessionId: SESSION,
    }),
  ].join('\n');
}

describe('rev9 D29a — transcriptToMessages (golden file)', () => {
  const lines = parseTranscript(buildFixture());
  const rows = transcriptToMessages(lines);

  it('parses every well-formed record and ignores blanks/torn lines', () => {
    expect(lines.length).toBe(13);
    // A torn trailing line must not throw and must be dropped.
    expect(
      parseTranscript('{"type":"user","message":{"content":"ok"}}\n{"type":"ass')
    ).toHaveLength(1);
  });

  it('reverse-maps to exactly the renderable user/assistant rows (meta filtered)', () => {
    expect(rows).toHaveLength(6);
    // Monotonic synthesized ids, transcript order, stable.
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);

    expect(rows[0]).toMatchObject({
      id: 1,
      type: 'user_message',
      data: { content: 'Vc tem acesso ao Playwright?' },
    });
    expect(rows[1]).toMatchObject({
      id: 2,
      type: 'claude_code_block',
      data: { type: 'text', content: 'Let me check the screenshot.' },
    });
    expect(rows[2]).toMatchObject({
      id: 3,
      type: 'claude_code_block',
      data: {
        type: 'tool_use',
        toolName: 'Read',
        id: 'toolu_read1',
        toolInput: { file_path: '/tmp/shot.png' },
      },
    });
    expect(rows[3]).toMatchObject({
      id: 4,
      type: 'claude_code_block',
      data: { type: 'tool_result', id: 'toolu_read1', is_error: false },
    });
    // thinking (msg_B) is dropped; only the text block of msg_B survives.
    expect(rows[4]).toMatchObject({
      id: 5,
      type: 'claude_code_block',
      data: { type: 'text', content: 'Yes, Playwright is available.' },
    });
    // Task tool_use survives with toolName intact (getMessagesAfterId anchor).
    expect(rows[5]).toMatchObject({
      id: 6,
      type: 'claude_code_block',
      data: { type: 'tool_use', toolName: 'Task' },
    });
  });

  it('preserves the timestamp from each record (ms, ascending)', () => {
    const ts = rows.map((r) => r.timestamp);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
    expect(rows[0].timestamp).toBe(Date.parse('2026-06-25T19:30:26.445Z'));
  });

  it('synthesized ids stay STABLE when the transcript only APPENDS (cursor coherence)', () => {
    // Append a new assistant text turn; existing rows keep their ids.
    const appended =
      buildFixture() +
      '\n' +
      line({
        type: 'assistant',
        message: {
          id: 'msg_D',
          role: 'assistant',
          content: [{ type: 'text', text: 'Anything else?' }],
        },
        uuid: 'as6',
        timestamp: '2026-06-25T19:31:00.000Z',
        sessionId: SESSION,
      });
    const rows2 = transcriptToMessages(parseTranscript(appended));
    expect(rows2.slice(0, 6).map((r) => ({ id: r.id, type: r.type }))).toEqual(
      rows.map((r) => ({ id: r.id, type: r.type }))
    );
    expect(rows2[6]).toMatchObject({
      id: 7,
      type: 'claude_code_block',
      data: { type: 'text', content: 'Anything else?' },
    });
  });

  it('honors idBase for a shared monotonic id space', () => {
    const r = transcriptToMessages(lines, 101);
    expect(r[0].id).toBe(101);
    expect(r[r.length - 1].id).toBe(106);
  });
});

describe('rev9 D29b — title / cwd / empty helpers', () => {
  it('title precedence: custom-title > ai-title > first user message', () => {
    const ai = parseTranscript(buildFixture());
    expect(transcriptTitle(ai)).toBe('Check Playwright package access');

    const withCustom = parseTranscript(
      buildFixture() +
        '\n' +
        line({ type: 'custom-title', customTitle: 'My pinned title', sessionId: SESSION })
    );
    expect(transcriptTitle(withCustom)).toBe('My pinned title');

    const noTitle = parseTranscript(
      [
        line({
          type: 'user',
          message: { role: 'user', content: 'just a question here' },
          timestamp: '2026-06-25T19:30:00Z',
          sessionId: SESSION,
        }),
      ].join('\n')
    );
    expect(transcriptTitle(noTitle)).toBe('just a question here');
  });

  it('title skips a task-notification-only first user message (public issue #11)', () => {
    const note = [
      '<task-notification>',
      '<task-id>bvt6pifet</task-id>',
      '<status>killed</status>',
      '<summary>Background command "Start dev server" was stopped</summary>',
      '</task-notification>',
    ].join('\n');
    const lines = parseTranscript(
      [
        line({
          type: 'user',
          message: { role: 'user', content: note },
          timestamp: '2026-06-25T19:30:00Z',
          sessionId: SESSION,
        }),
        line({
          type: 'user',
          message: { role: 'user', content: 'fix the login bug' },
          timestamp: '2026-06-25T19:31:00Z',
          sessionId: SESSION,
        }),
      ].join('\n')
    );
    // The injected notification is machine context — the title falls to the human turn.
    expect(transcriptTitle(lines)).toBe('fix the login bug');

    // A human message with an EMBEDDED notification titles as the human part only.
    const embedded = parseTranscript(
      [
        line({
          type: 'user',
          message: { role: 'user', content: `deploy this\n${note}` },
          timestamp: '2026-06-25T19:32:00Z',
          sessionId: SESSION,
        }),
      ].join('\n')
    );
    expect(transcriptTitle(embedded)).toBe('deploy this');

    // A human title that merely MENTIONS an unclosed marker is preserved (transcript
    // content is a full JSONL line, so a real blob is always complete → strict strip).
    const mention = parseTranscript(
      [
        line({
          type: 'user',
          message: { role: 'user', content: 'why does <task-notification> leak?' },
          timestamp: '2026-06-25T19:33:00Z',
          sessionId: SESSION,
        }),
      ].join('\n')
    );
    expect(transcriptTitle(mention)).toBe('why does <task-notification> leak?');
  });

  it('reads cwd from a conversational line (not the lossy dir slug)', () => {
    expect(transcriptCwd(parseTranscript(buildFixture()))).toBe(CWD);
    expect(transcriptCwd(parseTranscript(line({ type: 'ai-title', aiTitle: 'x' })))).toBeNull();
  });

  it('flags an empty / meta-only / clear-only transcript', () => {
    expect(transcriptIsEmpty(parseTranscript(''))).toBe(true);
    expect(
      transcriptIsEmpty(
        parseTranscript(
          [
            line({ type: 'ai-title', aiTitle: 'x', sessionId: SESSION }),
            line({
              type: 'user',
              message: { role: 'user', content: '<command-name>/clear</command-name>' },
              timestamp: '2026-06-25T19:30:00Z',
              sessionId: SESSION,
            }),
          ].join('\n')
        )
      )
    ).toBe(true);
    expect(transcriptIsEmpty(parseTranscript(buildFixture()))).toBe(false);
  });
});

describe('rev9 D29a — review-driven regressions', () => {
  it('gives a tool_result a blockId DISTINCT from its tool_use (mobile dedup) but keeps id for pairing', () => {
    const t = [
      line({
        type: 'assistant',
        message: {
          id: 'mA',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
        },
        uuid: 'a1',
        timestamp: '2026-06-25T10:00:00Z',
        sessionId: SESSION,
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'done' },
          ],
        },
        uuid: 'u1',
        timestamp: '2026-06-25T10:00:01Z',
        sessionId: SESSION,
      }),
    ].join('\n');
    const rows = transcriptToMessages(parseTranscript(t));
    const use = rows[0].data as any;
    const result = rows[1].data as any;
    expect(use.blockId).toBe('toolu_1');
    expect(result.blockId).toBe('toolu_1:result'); // distinct → mobile join-dedup won't drop it
    expect(result.id).toBe('toolu_1'); // same id → consolidation still PAIRS result with use
    expect(result.content).toBe('done');
  });

  it('does NOT drop a queued human message in a MIXED [tool_result, text] user array', () => {
    const t = [
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_x', is_error: false, content: 'output' },
            { type: 'text', text: 'bom plano, cria a issue' },
          ],
        },
        uuid: 'u1',
        timestamp: '2026-06-25T10:00:00Z',
        sessionId: SESSION,
      }),
    ].join('\n');
    const rows = transcriptToMessages(parseTranscript(t));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: 'claude_code_block',
      data: { type: 'tool_result', id: 'toolu_x' },
    });
    expect(rows[1]).toMatchObject({
      type: 'user_message',
      data: { content: 'bom plano, cria a issue' },
    });
  });

  it('drops a valid-JSON null/primitive line and never throws (whole-list-poisoning guard)', () => {
    expect(parseTranscript('null\n42\n"str"\n[1,2]')).toHaveLength(0);
    const mixed = [
      'null',
      line({
        type: 'user',
        message: { role: 'user', content: 'real' },
        timestamp: '2026-06-25T10:00:00Z',
        sessionId: SESSION,
      }),
    ].join('\n');
    const lines = parseTranscript(mixed);
    expect(lines).toHaveLength(1);
    expect(() => transcriptToMessages(lines)).not.toThrow();
    expect(transcriptToMessages(lines)).toHaveLength(1);
  });
});
