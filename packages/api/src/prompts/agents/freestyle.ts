/**
 * Freestyle Agent Setup
 *
 * Direct execution agent that handles all tasks without delegation.
 * Unopinionated, all tools available, no sub-agents.
 */

import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { MCP_REGISTRY } from '../../config/McpRegistry.js';

import type { AgentSetup } from '@vgit2/shared/types/agentSetup';

/**
 * Freestyle Agent Setup
 * Direct execution agent that handles all tasks without delegation
 */
export const FREESTYLE_SETUP: AgentSetup = {
  id: 'freestyle',
  name: 'Freestyle',
  description: 'Unopinionated agent',

  systemPromptTemplate: `{universalCoreSections}

{codeSections}

{githubSections}

{runtimeTunnels}
`,

  subAgents: [], // No sub-agents for freestyle

  mcpServers: [
    // Array of enabled MCP IDs
    MCP_REGISTRY.playwright.id,
    MCP_REGISTRY.standard.id, // Includes portable_execute for chat/project SDK access
    MCP_REGISTRY['run-connection'].id,
  ],

  behavior: {
    useWorkflowManagement: false, // Optional task planning
    preferDelegation: false, // Never delegate
    parallelExecution: false, // N/A without delegation
    planBeforeExecuting: false, // Execute directly
  },

  defaultModel: DEFAULT_MODEL_MODE,

  colorTheme: '#7aa892', // Flatter green for direct execution
};
