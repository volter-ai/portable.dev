/**
 * Action Extraction Prompts
 *
 * Prompts used for extracting suggested actions from AI messages using Gemini.
 */

/**
 * Generates a prompt for Gemini to extract suggested actions from an assistant message.
 * Used to identify user choices and create quick action buttons in the UI.
 *
 * @param textContent - The assistant message text to analyze
 * @returns Formatted prompt for Gemini API
 */
export function getGeminiActionExtractionPrompt(textContent: string): string {
  return `Analyze this assistant message to extract suggested actions.

Message: """
${textContent}
"""

Return a JSON object with this EXACT structure:
{
  "reasoning": "Brief 1-2 sentence reasoning about found actions",
  "actions": [
    {
      "quote": "Exact question from message",
      "label": "2-4 word button label",
      "prompt": "User prompt to trigger the action (brief starter for prefill_input, complete for send_message)",
      "actionType": "send_message or prefill_input",
      "icon": "optional icon name"
    }
  ]
}

FUTURE WORK EXTRACTION:
Find CHOICES or OPTIONS the assistant is offering for what to do next.

KEY DISTINCTION: Extract only when the assistant is asking the user to CHOOSE what happens next.
NOT sequential steps that will happen automatically.

LOOK FOR:
1. Questions asking what the user prefers or wants done
2. "Or" statements presenting alternatives (e.g., "Or would you like to...")
3. Options presented with "What would you prefer?"
4. Clear choices where user input determines the next action

ACCEPT formats like:
- "Would you like me to [specific task]?"
- "Would you like to [specific task]?" (even without "me to")
- "Should I [specific task]?"
- "Want me to [specific task]?"
- "I can [specific task] if you'd like"
- "Or would you like to [specific task]?" (alternative option)
- When followed by "What would you prefer?" or similar choice indicator

DO NOT extract:
- Sequential steps that will happen in order (e.g., "Next I'll do X, then Y")
- "I'll..." / "I will..." (already doing it)
- "Let me..." (already doing it)
- "I've..." / "I have..." (already completed)
- Vague questions without specific actions

For normal actions, use type: "normal" (or omit type field).

ACTION TYPE SELECTION - CRITICAL: Consider the FULL MESSAGE CONTEXT

Use "actionType": "prefill_input" when the action is TOO VAGUE based on the message:
- The message does NOT specify WHAT/HOW/WHICH for this action
- User must clarify to make it actionable
- Prompt should be brief starter text ending with ":" or "like:"

Examples showing FULL MESSAGE CONTEXT:

Example 1 - VAGUE:
Message: "I've completed dark mode. Would you like to modify the aesthetics or complete the merge?"
Action: "modify the aesthetics"
→ actionType: "prefill_input", prompt: "modify the aesthetics this way:"
REASON: Message gives NO details about WHICH aesthetics or HOW to modify

Example 2 - VAGUE:
Message: "I've completed basic auth. Would you like to add additional features or move on?"
Action: "add additional features"
→ actionType: "prefill_input", prompt: "add additional features like:"
REASON: Message doesn't specify WHICH features (2FA? password reset? OAuth?)

Use "actionType": "send_message" when the action is SPECIFIC based on the message:
- The message provides enough context for AI to act
- Even if action says "modify" or "change" but message specifies WHAT/HOW
- AI knows exactly what to do

Example 3 - SPECIFIC:
Message: "Current background #1a1a1a is too dark. Would you like to change it lighter or keep it?"
Action: "change it lighter"
→ actionType: "send_message", prompt: "change the color to be lighter"
REASON: Message provides context - AI knows to lighten the specific color

Example 4 - SPECIFIC:
Message: "Completed basic auth. The spec mentions password reset and 2FA. Add those features or move on?"
Action: "add those features"
→ actionType: "send_message", prompt: "add those features"
REASON: Message clearly identifies "those features" = password reset + 2FA

Example 5 - SPECIFIC:
Message: "Found 3 bugs: 1) dark mode toggle broken 2) images not loading 3) search timeout. Which first?"
Action: "fix dark mode"
→ actionType: "send_message", prompt: "fix the dark mode toggle issue"
REASON: Bug is specifically identified in the message

CRITICAL RULE: Look at the ENTIRE message context. If the message doesn't give enough detail for that specific action, use prefill_input. If the action is clear and actionable from context, use send_message.

IMPORTANT: Return ONLY valid JSON, no markdown formatting or extra text.`;
}
