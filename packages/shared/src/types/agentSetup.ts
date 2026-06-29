/**
 * Agent Setup Types
 * Defines the structure for different agent orchestration styles
 */

/**
 * Definition for a sub-agent that can be delegated to
 * Follows the Claude Agent SDK's AgentDefinition interface
 */
import type { ModelMode } from '../models';

export interface SubAgentDefinition {
  /** Unique identifier for the sub-agent (e.g., 'github-specialist') */
  type: string;

  /** Display name for the sub-agent */
  name: string;

  /** Description of when to use this sub-agent */
  description: string;

  /** Full system prompt for the sub-agent */
  prompt: string;

  /** List of tool names this sub-agent can use */
  tools: string[];

  /** Model to use (inherit = use parent's model) */
  model: 'inherit' | ModelMode;

  /** Optional color theme for UI display */
  colorTheme?: string;

  /** Files to include in the sub-agent's context (relative to repo root) */
  contextFiles?: string[];
}

/**
 * Complete configuration for an agent setup
 * Defines orchestration style, available sub-agents, and behavior
 */
export interface AgentSetup {
  /** Unique identifier (e.g., 'best-practice', 'freestyle') */
  id: string;

  /** Display name for the UI */
  name: string;

  /** Description of the orchestration style */
  description: string;

  /** Base system prompt template for this setup */
  systemPromptTemplate: string;

  /** Full sub-agent definitions (embedded, not referenced) */
  subAgents: SubAgentDefinition[];

  /**
   * MCP server configuration
   * Array of enabled MCP registry IDs
   * Use IDs from MCP_REGISTRY (e.g., 'playwright', 'google-drive-tools')
   */
  mcpServers: string[];

  /** Behavioral configuration */
  behavior: {
    /** Use TodoWrite for task planning */
    useWorkflowManagement: boolean;

    /** Prefer delegating to sub-agents over direct execution */
    preferDelegation: boolean;

    /** Run multiple sub-agents in parallel when possible */
    parallelExecution: boolean;

    /** Always plan complex tasks before executing */
    planBeforeExecuting: boolean;
  };

  /** Default model for this setup */
  defaultModel?: ModelMode;

  /** Default permission mode */
  defaultPermissions?: string;

  /** Color theme for UI display (hex color) */
  colorTheme?: string;

  /** Whether this agent requires SOP (Standard Operating Procedure) worksheet */
  requiresSOP?: boolean;
}
