import * as fsSync from 'fs';
import * as path from 'path';

import { getAgentSetup } from '../../../config/agentRegistry.js';

import type { HandlerDependencies } from '../types.js';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/**
 * AgentHandler - Manages agent configuration and setup
 * Responsibilities:
 * - Build agent definitions from setup configurations
 * - Get display names for sub-agents
 * - Handle context file injection
 */
export class AgentHandler {
  constructor(dependencies: HandlerDependencies) {
    // No dependencies needed for this handler currently
  }

  /**
   * Get display name for a sub-agent type
   *
   * @param subAgentType - Sub-agent type identifier
   * @returns Human-readable display name
   */
  getSubAgentDisplayName(subAgentType: string): string {
    switch (subAgentType) {
      case 'github-specialist':
        return 'GitHub Specialist';
      case 'coding-specialist':
        return 'Coding Specialist';
      case 'qa-specialist':
        return 'QA Specialist';
      case 'general-purpose':
        return 'General Purpose Agent';
      default:
        // Capitalize and replace hyphens with spaces
        return subAgentType
          .split('-')
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
    }
  }

  /**
   * Build agent definitions from agent setup configuration
   * Injects context files (e.g., CLAUDE.md) into agent prompts
   *
   * @param agentSetupId - Agent setup ID to use
   * @param repoPath - Repository path for context file lookup
   * @returns Record of agent type to agent definition
   */
  buildAgentsFromSetup(agentSetupId: string, repoPath: string): Record<string, AgentDefinition> {
    const agentSetup = getAgentSetup(agentSetupId);
    const agents: Record<string, AgentDefinition> = {};

    // Build agents object from subagents defined in the setup
    for (const subAgent of agentSetup.subAgents) {
      let finalPrompt = subAgent.prompt;

      // Include context files (defaults to CLAUDE.md if not specified)
      const contextFiles = subAgent.contextFiles || ['CLAUDE.md'];
      for (const file of contextFiles) {
        try {
          const filePath = path.join(repoPath, file);
          if (fsSync.existsSync(filePath)) {
            const content = fsSync.readFileSync(filePath, 'utf-8');
            finalPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROJECT CONTEXT FILE (${file}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
END OF ${file}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
          } else {
            // File doesn't exist - inform the agent
            finalPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  NOTE: Context file "${file}" not found in repository
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
          }
        } catch (error) {
          console.warn(`[AgentHandler] Failed to read context file ${file}:`, error);
          finalPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  NOTE: Context file "${file}" could not be read (${error instanceof Error ? error.message : 'unknown error'})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        }
      }

      agents[subAgent.type] = {
        description: subAgent.description,
        prompt: finalPrompt,
        tools: subAgent.tools,
        model: subAgent.model as 'inherit' | undefined,
      };
    }

    return agents;
  }
}
