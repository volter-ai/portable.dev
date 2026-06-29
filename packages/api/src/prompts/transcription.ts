/**
 * Voice Transcription Prompts
 *
 * Prompts used for post-processing audio transcriptions to fix misheard technical terms
 * using conversation context. Only fixes technical terms, preserves everything else.
 */

/**
 * Builds the transcription correction prompt
 *
 * @param rawTranscription - The raw speech-to-text output
 * @param chatContext - JSON string of recent conversation messages
 * @returns Formatted prompt for Claude Haiku
 */
export function buildTranscriptionCorrectionPrompt(
  rawTranscription: string,
  chatContext: string
): string {
  return `You are fixing misheard technical terms in speech-to-text transcriptions.

CONVERSATION CONTEXT (JSON):
${chatContext}

TRANSCRIPTION:
${rawTranscription}

EXAMPLES:
Input: "update the read this service"
Context mentions: Redis
Output: update the Redis service

Input: "check post grass connection"
Context mentions: Postgres
Output: check Postgres connection

Input: "what time is it"
Context mentions: Redis
Output: what time is it

Input: "run play right tests"
Context mentions: Playwright
Output: run Playwright tests

RULES:
1. Only fix words that sound like technical terms from the context
2. If no technical terms are misheard, return the transcription exactly as-is
3. Do not add quotes, explanations, or commentary
4. Output only the corrected text itself`;
}
