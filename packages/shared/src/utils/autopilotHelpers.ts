/**
 * Legacy auto-pilot display-hygiene helpers.
 *
 * The auto-pilot ("Ralph loop") feature was REMOVED — Claude Code's native `/loop`
 * replaces it. The backend no longer appends the completion instruction or emits the
 * stop word, but historical chat transcripts persisted while auto-pilot was active may
 * still contain that text. These pure string helpers strip that legacy residue so old
 * messages render cleanly. They are safe no-ops on text that doesn't contain it.
 */

/**
 * The completion instruction that the (now-removed) auto-pilot used to append to user
 * prompts. Retained only so {@link stripAutopilotCompletionInstruction} can remove it
 * from historical transcripts that still embed it.
 */
export const AUTOPILOT_COMPLETION_INSTRUCTION = `\n\nIMPORTANT: You MUST do exactly one of:\n1. Output <promise>COMPLETE</promise> on its own line if the task is 100% done\n2. Ask the user a specific question about what to do next\nDo not do both. NEVER use natural language like "I'm done", "All finished", or "Ready when you wake up" — only the exact token <promise>COMPLETE</promise> signals completion to auto-pilot.`;

/**
 * Strip the autopilot completion instruction from a user-visible message string.
 *
 * When autopilot is enabled the backend appends {@link AUTOPILOT_COMPLETION_INSTRUCTION}
 * to the user's prompt before sending it to Claude (and broadcasts that augmented content
 * on the live `user_message` echo). That instruction must never appear in the user's own
 * chat bubble — this removes it, returning the original user-typed text unchanged. A
 * no-op when the instruction isn't present (so it is safe to call unconditionally).
 */
export function stripAutopilotCompletionInstruction(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (!text.includes(AUTOPILOT_COMPLETION_INSTRUCTION)) return text;
  return text.split(AUTOPILOT_COMPLETION_INSTRUCTION).join('');
}

/**
 * Remove the autopilot stop word (`<promise>COMPLETE</promise>`, case-insensitive) from a
 * plain text string and trim — the typed counterpart of {@link pruneAutopilotStopWord} for
 * render-time stripping of assistant text (web `TextBlock` parity).
 */
export function stripAutopilotStopWord(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(/<promise>complete<\/promise>/gi, '').trim();
}

/**
 * Remove autopilot stop word from content
 *
 * The stop word <promise>COMPLETE</promise> is used internally to signal
 * autopilot should stop, but should not be shown to users in chat history
 * or real-time streaming.
 *
 * @param content - Content to prune (string, object with text/content fields, or array)
 * @returns Pruned content with stop word removed
 */
export function pruneAutopilotStopWord(content: any): any {
  if (!content) {
    return content;
  }

  // Handle string content directly
  if (typeof content === 'string') {
    return content.replace(/<promise>COMPLETE<\/promise>/g, '').trim();
  }

  // Handle object with text field
  if (typeof content === 'object' && typeof content.text === 'string') {
    return {
      ...content,
      text: content.text.replace(/<promise>COMPLETE<\/promise>/g, '').trim(),
    };
  }

  // Handle object with content field (string)
  if (typeof content === 'object' && typeof content.content === 'string') {
    return {
      ...content,
      content: content.content.replace(/<promise>COMPLETE<\/promise>/g, '').trim(),
    };
  }

  // Handle object with content field (array of blocks)
  if (typeof content === 'object' && Array.isArray(content.content)) {
    return {
      ...content,
      content: content.content.map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return {
            ...block,
            text: block.text.replace(/<promise>COMPLETE<\/promise>/g, '').trim(),
          };
        }
        return block;
      }),
    };
  }

  // Handle array of blocks directly
  if (Array.isArray(content)) {
    return content.map((block: any) => pruneAutopilotStopWord(block));
  }

  // Return as-is if no matching structure
  return content;
}
