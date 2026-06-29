/**
 * Shared autopilot strip helpers — the single-source primitives the RN
 * client uses to keep the injected autopilot text out of the chat UI.
 *
 * Lives in the mobile package (NOT `packages/shared/src`, which would break the
 * api `tsc`) and doubles as the proof that `@vgit2/shared/utils/autopilotHelpers`
 * resolves under Jest now that it is in the shared `exports` map.
 */

import {
  AUTOPILOT_COMPLETION_INSTRUCTION,
  stripAutopilotCompletionInstruction,
  stripAutopilotStopWord,
} from '@vgit2/shared/utils/autopilotHelpers';

describe('stripAutopilotCompletionInstruction', () => {
  it('removes the appended instruction, returning the original user text verbatim', () => {
    const text = `add a comment to the README${AUTOPILOT_COMPLETION_INSTRUCTION}`;
    expect(stripAutopilotCompletionInstruction(text)).toBe('add a comment to the README');
  });

  it('removes BOTH leaked fragments the user reported', () => {
    const out = stripAutopilotCompletionInstruction(`hi${AUTOPILOT_COMPLETION_INSTRUCTION}`);
    expect(out).not.toContain('<promise>COMPLETE</promise>');
    expect(out).not.toContain('IMPORTANT: You MUST');
  });

  it('is a no-op when the instruction is absent (safe to call unconditionally)', () => {
    expect(stripAutopilotCompletionInstruction('just a normal message')).toBe(
      'just a normal message'
    );
    expect(stripAutopilotCompletionInstruction('')).toBe('');
  });

  it('preserves leading/trailing whitespace of the genuine user content', () => {
    const text = `  spaced out  ${AUTOPILOT_COMPLETION_INSTRUCTION}`;
    expect(stripAutopilotCompletionInstruction(text)).toBe('  spaced out  ');
  });
});

describe('stripAutopilotStopWord', () => {
  it('removes the stop word case-insensitively and trims', () => {
    expect(stripAutopilotStopWord('All done!\n<promise>COMPLETE</promise>')).toBe('All done!');
    expect(stripAutopilotStopWord('done <promise>complete</promise>')).toBe('done');
  });

  it('leaves text without the stop word untouched (aside from trim)', () => {
    expect(stripAutopilotStopWord('regular assistant reply')).toBe('regular assistant reply');
  });
});
