/**
 * Pure helpers for the Agent Setups settings section — framework-free
 * derivations.
 */

import type { AgentSetup } from '@vgit2/shared/types';

/** Fallback avatar/badge color — HARDCODED; do not themeify. */
export const FALLBACK_AVATAR_COLOR = '#586069';

/**
 * The orchestration badge is DERIVED, never read from the API:
 * sub-agents present AND `behavior.preferDelegation` → 'Delegation-Based',
 * else 'Direct Execution'.
 */
export function getOrchestrationLabel(
  setup: Pick<AgentSetup, 'subAgents' | 'behavior'>
): 'Delegation-Based' | 'Direct Execution' {
  if (setup.subAgents.length > 0 && setup.behavior?.preferDelegation) {
    return 'Delegation-Based';
  }
  return 'Direct Execution';
}

/**
 * Dicebear notionists avatar (setup avatars seed by `setup.id`, sub-agent
 * avatars by `subAgent.type` — NOT an `id`, which may not exist). RN `Image`
 * cannot decode SVG, so mobile asks Dicebear for the seed via the `/png`
 * endpoint (identical avatar, raster encoding).
 */
export function getAgentAvatarUrl(seed: string): string {
  return `https://api.dicebear.com/7.x/notionists/png?seed=${encodeURIComponent(seed)}`;
}
