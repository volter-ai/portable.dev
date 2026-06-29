/**
 * Prompts Index
 *
 * Central exports for all AI prompts in the application.
 * Provides a single import point for all prompt builders.
 */

// System prompts
export {
  buildSystemPromptFromSetup,
  buildRuntimeTunnelSection,
  getUniversalCoreSections,
  getGitHubSections,
  getCodeSections,
  getToolSpecificSections,
} from './systemPrompts.js';

// Analysis prompts
export { getGeminiActionExtractionPrompt } from './actionExtraction.js';
export { buildAnalysisPrompt } from './intentAnalysis.js';
export { buildSuggestionsPrompt } from './suggestions.js';
export { buildChatSearchPrompt } from './chatSearch.js';
export { buildTranscriptionCorrectionPrompt } from './transcription.js';

// Agent setups (re-exported from config/agentRegistry.ts for convenience)
export { BEST_PRACTICE_SETUP } from './agents/bestPractice.js';
export { FREESTYLE_SETUP } from './agents/freestyle.js';
export { ORCHESTRATOR_SETUP } from './agents/orchestrator.js';
