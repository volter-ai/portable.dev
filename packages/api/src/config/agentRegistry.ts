/**
 * Agent Setup Registry
 *
 * Centralized registry for all agent setups.
 * Aggregates agent definitions from prompts/agents/ and provides helper functions.
 */

import { BEST_PRACTICE_SETUP } from '../prompts/agents/bestPractice.js';
import { FREESTYLE_SETUP } from '../prompts/agents/freestyle.js';
import { ORCHESTRATOR_SETUP } from '../prompts/agents/orchestrator.js';

import type { AgentSetup } from '@vgit2/shared/types/agentSetup';

/**
 * Registry of all available agent setups
 */
export const AGENT_SETUPS: AgentSetup[] = [
  BEST_PRACTICE_SETUP,
  FREESTYLE_SETUP,
  ORCHESTRATOR_SETUP,
];

/**
 * Get an agent setup by ID
 */
export function getAgentSetup(id: string): AgentSetup {
  const setup = AGENT_SETUPS.find((s) => s.id === id);
  if (!setup) {
    console.warn(`Agent setup '${id}' not found, falling back to freestyle`);
    return FREESTYLE_SETUP;
  }
  return setup;
}

/**
 * Get the default agent setup
 */
export function getDefaultAgentSetup(): AgentSetup {
  return FREESTYLE_SETUP;
}

/**
 * Get all available agent setups
 */
export function getAvailableAgentSetups(): AgentSetup[] {
  return AGENT_SETUPS;
}
