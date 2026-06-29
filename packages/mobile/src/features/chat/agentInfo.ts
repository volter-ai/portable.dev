/**
 * agentInfo — resolve an agent setup id / sub-agent type to its display name +
 * color. Verbatim port of the web `messageBlockHelpers.getAgentInfo` (the
 * source of the typing-indicator / agent-badge colors).
 */

import type { AgentSetup } from '@vgit2/shared/types';

/** Web default gray for an unknown / unset agent. */
export const DEFAULT_AGENT_COLOR = '#586069';

export interface AgentInfo {
  name: string;
  color: string;
}

export function getAgentInfo(agentType: string | undefined, agentSetups: AgentSetup[]): AgentInfo {
  if (!agentType) {
    return { name: 'Agent', color: DEFAULT_AGENT_COLOR };
  }

  // A main agent setup id (e.g. 'best-practice', 'freestyle').
  const mainSetup = agentSetups.find((setup) => setup.id === agentType);
  if (mainSetup) {
    return { name: mainSetup.name, color: mainSetup.colorTheme || DEFAULT_AGENT_COLOR };
  }

  // A sub-agent type inside any setup.
  for (const setup of agentSetups) {
    const subAgent = setup.subAgents.find((agent) => agent.type === agentType);
    if (subAgent) {
      return { name: subAgent.name, color: subAgent.colorTheme || DEFAULT_AGENT_COLOR };
    }
  }

  // Fallback: humanize the slug ("qa-specialist" → "Qa Specialist").
  const displayName = agentType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return { name: displayName, color: DEFAULT_AGENT_COLOR };
}
