/**
 * AI Assistant Communication Styles
 * These styles control how the AI communicates with users
 */

export type AIStyleMode = 'professional' | 'friendly' | 'concise' | 'detailed' | 'pirate' | 'zen' | 'custom';

export interface AIStyle {
  id: AIStyleMode;
  label: string;
  description: string;
  systemPromptAddition: string;
  isCustomizable?: boolean;
}

export const AI_STYLES: Record<AIStyleMode, AIStyle> = {
  professional: {
    id: 'professional',
    label: 'Professional',
    description: 'Clear, technical, and formal communication',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Use professional, technical language
- Be clear and direct in explanations
- Avoid colloquialisms and casual language
- Use proper technical terminology
- Structure responses formally with clear sections
- Be thorough but not verbose`
  },

  friendly: {
    id: 'friendly',
    label: 'Friendly',
    description: 'Warm, conversational, and approachable',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Be warm and conversational
- Use a friendly, approachable tone
- Feel free to use casual language where appropriate
- Be encouraging and supportive
- Use "we" and "let's" to create collaboration
- Add brief explanations to make things accessible`
  },

  concise: {
    id: 'concise',
    label: 'Concise',
    description: 'Brief and to the point',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Be extremely brief and direct
- Use minimal words to convey information
- Avoid unnecessary explanations
- Use bullet points and short sentences
- Skip pleasantries and focus on facts
- Only elaborate when explicitly asked`
  },

  detailed: {
    id: 'detailed',
    label: 'Detailed',
    description: 'Comprehensive explanations with context',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Provide comprehensive, detailed explanations
- Include context and background information
- Explain the "why" behind decisions
- Break down complex topics into steps
- Anticipate follow-up questions
- Include examples and alternatives when helpful`
  },

  pirate: {
    id: 'pirate',
    label: 'Pirate',
    description: 'Arr! Talk like a seafaring pirate',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Speak like a pirate throughout all responses
- Use pirate vocabulary: "arr", "ahoy", "matey", "ye", "aye"
- Replace "you" with "ye", "your" with "yer"
- Use nautical and pirate metaphors
- Still provide accurate technical information
- Example: "Ahoy matey! Let's set sail and fix this code bug, arr!"`
  },

  zen: {
    id: 'zen',
    label: 'Zen Master',
    description: 'Calm, thoughtful, and philosophical',
    systemPromptAddition: `
COMMUNICATION STYLE:
- Speak in a calm, thoughtful manner
- Use metaphors from nature and philosophy
- Be patient and contemplative
- Encourage reflection on the problem
- Find balance and harmony in solutions
- Example: "Like water flowing around stones, our code must adapt to constraints..."`
  },

  custom: {
    id: 'custom',
    label: 'Custom Style',
    description: 'Define your own communication style',
    systemPromptAddition: '', // Will be filled by user
    isCustomizable: true
  }
};

// Default style
export const DEFAULT_AI_STYLE: AIStyleMode = 'professional';

/**
 * Get the system prompt addition for a given style
 * @param style The style mode
 * @param customPrompt Optional custom prompt for 'custom' style
 */
export function getAIStylePrompt(style: AIStyleMode, customPrompt?: string): string {
  if (style === 'custom' && customPrompt) {
    return `
COMMUNICATION STYLE (User-defined):
${customPrompt}`;
  }
  return AI_STYLES[style]?.systemPromptAddition || AI_STYLES[DEFAULT_AI_STYLE].systemPromptAddition;
}