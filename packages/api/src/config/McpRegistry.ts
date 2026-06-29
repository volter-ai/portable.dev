/**
 * MCP Registry - Centralized metadata for all MCP servers
 *
 * Single source of truth for MCP configuration, requirements, and display information.
 * Used by both backend (validation, initialization) and the client (UI display).
 */

import * as constants from '@vgit2/shared/constants';

/**
 * MCP Server Metadata
 *
 * Defines all information needed to configure, validate, and display an MCP server.
 */
export interface McpMetadata {
  /** Unique MCP identifier (used in code and database) */
  id: string;

  /** Display name for UI */
  name: string;

  /** Human-readable description */
  description: string;

  /** MCP type: external (npm package) or custom (internal implementation) */
  type: 'external' | 'custom';

  /** Version (for custom MCPs, 'package-version' for external) */
  version: string;

  /** Required environment variables */
  requiredEnv?: string[];

  /** Dependencies on other MCPs */
  dependencies?: string[];

  /** Enable by default when requirements are met */
  defaultEnabled: boolean;

  /** Color theme for UI (hex color) */
  colorTheme?: string;

  /** Approximate tool count (for display) */
  toolCount?: number;

  /** Website URL (for favicon fetching and links) */
  websiteUrl?: string;

  /** Icon identifier (emoji character, 'fa:icon-name', or URL) */
  icon?: string;

  /** Category for grouping in UI */
  category?: 'automation' | 'development' | 'productivity' | 'platform' | 'media';
}

/**
 * MCP Registry - All available MCP servers
 *
 * Add new MCPs here to make them available throughout the application.
 * The registry is used for:
 * - Validation during server startup
 * - UI display in profile settings
 * - Agent setup configuration
 * - Token requirement checking
 */
export const MCP_REGISTRY: Record<string, McpMetadata> = {
  // === External MCPs (npm packages) ===

  playwright: {
    id: 'playwright',
    name: 'Playwright',
    description: 'Browser automation for testing web applications and scraping content',
    type: 'external',
    version: 'package-version',
    // Note: Playwright needs a local Chromium.
    // Validation is handled specially in checkMcpRequirements()
    requiredEnv: [], // Validated conditionally - see checkMcpRequirements()
    defaultEnabled: true,
    colorTheme: '#45ba4b',
    toolCount: 20,
    websiteUrl: 'https://playwright.dev',
    category: 'automation',
  },

  // === Custom MCPs (internal implementations) ===

  // NOTE: google-drive-tools and slack-tools are managed via ConnectionsService,
  // so they are NOT in this registry. They use user connections instead of any
  // registry-level token requirement.

  standard: {
    id: 'standard',
    name: 'Standard Tools',
    description:
      'Standard utility tools for development: tunneling, secrets management, and chat-issue linking',
    type: 'custom',
    version: '1.0.0',
    defaultEnabled: true, // Always available, most features work without tokens
    colorTheme: '#64748b',
    toolCount: 7,
    icon: '🛠️',
    category: 'development',
  },

  'run-connection': {
    id: 'run-connection',
    name: 'Run Connection',
    description:
      'Execute TypeScript code with authenticated API clients for all connected services',
    type: 'custom',
    version: '1.0.0',
    defaultEnabled: false, // Only when user has connected services
    colorTheme: '#10b981',
    toolCount: 1, // Single flexible executor
    icon: '🧩',
    category: 'productivity',
  },
};

/**
 * Get MCP metadata by ID
 * @param id - MCP identifier
 * @returns MCP metadata or undefined if not found
 */
export function getMcpMetadata(id: string): McpMetadata | undefined {
  return MCP_REGISTRY[id];
}

/**
 * Get all available MCPs
 * @returns Array of all MCP metadata
 */
export function getAllMcps(): McpMetadata[] {
  return Object.values(MCP_REGISTRY);
}

/**
 * Get MCPs by category
 * @param category - MCP category
 * @returns Array of MCPs in the category
 */
export function getMcpsByCategory(category: McpMetadata['category']): McpMetadata[] {
  return getAllMcps().filter((mcp) => mcp.category === category);
}

/**
 * Get enabled MCPs (defaultEnabled = true)
 * @returns Array of MCPs that are enabled by default
 */
export function getDefaultEnabledMcps(): McpMetadata[] {
  return getAllMcps().filter((mcp) => mcp.defaultEnabled);
}

/**
 * Get MCPs that require configuration
 * @returns Array of MCPs that need tokens/env vars
 */
export function getMcpsRequiringConfiguration(): McpMetadata[] {
  return getAllMcps().filter((mcp) => mcp.requiredEnv && mcp.requiredEnv.length > 0);
}

/**
 * Get external MCPs (npm packages)
 * @returns Array of external MCPs
 */
export function getExternalMcps(): McpMetadata[] {
  return getAllMcps().filter((mcp) => mcp.type === 'external');
}

/**
 * Get custom MCPs (internal implementations)
 * @returns Array of custom MCPs
 */
export function getCustomMcps(): McpMetadata[] {
  return getAllMcps().filter((mcp) => mcp.type === 'custom');
}

/**
 * Check if MCP requirements are met
 *
 * No MCP is token-gated. Requirements are now purely local env: Playwright needs a
 * Chromium; others need their `requiredEnv`.
 *
 * @param id - MCP identifier
 * @returns Availability status and missing env requirements
 */
export function checkMcpRequirements(id: string): {
  available: boolean;
  missingEnv: string[];
} {
  const metadata = getMcpMetadata(id);

  if (!metadata) {
    return { available: false, missingEnv: [] };
  }

  const missingEnv: string[] = [];

  // SPECIAL CASE: Playwright needs a local Chromium
  if (id === 'playwright') {
    const hasChromium = !!constants.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

    if (hasChromium) {
      return { available: true, missingEnv: [] };
    } else {
      missingEnv.push('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH');
      return { available: false, missingEnv };
    }
  }

  // Check required environment variables (plain env vars - check process.env directly)
  if (metadata.requiredEnv) {
    for (const envVar of metadata.requiredEnv) {
      if (!process.env[envVar]) {
        missingEnv.push(envVar);
      }
    }
  }

  return {
    available: missingEnv.length === 0,
    missingEnv,
  };
}

/**
 * Get human-readable requirement description
 * @param id - MCP identifier
 * @returns Description of requirements (e.g., "Requires: SOME_API_KEY")
 */
export function getMcpRequirementsDescription(id: string): string | undefined {
  const metadata = getMcpMetadata(id);

  if (!metadata) {
    return undefined;
  }

  const requirements: string[] = [];

  if (metadata.requiredEnv && metadata.requiredEnv.length > 0) {
    requirements.push(...metadata.requiredEnv);
  }

  if (requirements.length === 0) {
    return 'No requirements';
  }

  return `Requires: ${requirements.join(', ')}`;
}
