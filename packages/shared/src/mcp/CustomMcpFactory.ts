/**
 * Custom MCP Factory - Unified pattern for creating custom MCP servers
 *
 * Eliminates code duplication across GitHub, Google Drive, Slack, and AI Media MCPs.
 * Provides:
 * - JSON Schema → Zod conversion
 * - Unified MCP server creation pattern
 * - Consistent tool registration
 */

import { z } from 'zod';

/**
 * Generic tool definition (matches tool packages)
 *
 * All custom tool packages (github, google-drive, slack) follow this structure.
 */
export interface UnifiedToolDefinition {
  /** Tool name (must be unique within MCP) */
  name: string;

  /** Tool description for Claude */
  description?: string;

  /** JSON Schema for input parameters */
  inputSchema?: {
    properties?: Record<string, any>;
    required?: string[];
  };

  /** Tool execution function */
  execute: (input: any, context: any) => Promise<{ content: any[] }>;
}

/**
 * Convert JSON Schema property to Zod schema
 *
 * Handles common JSON Schema types and converts them to Zod equivalents.
 * All fields are optional by default (Claude Agent SDK handles validation).
 *
 * @param prop - JSON Schema property definition
 * @returns Zod schema for the property
 */
function jsonSchemaPropertyToZod(prop: any): z.ZodTypeAny {
  // Handle type arrays (e.g., ["string", "null"])
  if (Array.isArray(prop.type)) {
    // Use the first non-null type
    const primaryType = prop.type.find((t: string) => t !== 'null') || 'string';
    return jsonSchemaPropertyToZod({ ...prop, type: primaryType });
  }

  switch (prop.type) {
    case 'string':
      if (prop.enum) {
        // Enum values
        return z.enum(prop.enum as [string, ...string[]]).optional();
      }
      return z.string().optional();

    case 'number':
      return z.number().optional();

    case 'integer':
      return z.number().int().optional();

    case 'boolean':
      return z.boolean().optional();

    case 'array':
      if (prop.items) {
        const itemSchema = jsonSchemaPropertyToZod(prop.items);
        return z.array(itemSchema).optional();
      }
      return z.array(z.any()).optional();

    case 'object':
      if (prop.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, value] of Object.entries(prop.properties)) {
          shape[key] = jsonSchemaPropertyToZod(value);
        }
        return z.object(shape).optional();
      }
      return z.record(z.any(), z.any()).optional();

    default:
      // Fallback for unknown types
      return z.any().optional();
  }
}

/**
 * Convert JSON Schema to Zod schema object
 *
 * Converts a full JSON Schema (with properties) to a Zod object shape.
 * This is used to provide type safety for Claude Agent SDK tool calls.
 *
 * @param inputSchema - JSON Schema with properties
 * @returns Zod schema object (key-value pairs)
 */
export function convertJsonSchemaToZod(inputSchema?: {
  properties?: Record<string, any>;
}): Record<string, z.ZodTypeAny> {
  const zodSchema: Record<string, z.ZodTypeAny> = {};

  if (inputSchema?.properties) {
    for (const [key, prop] of Object.entries(inputSchema.properties)) {
      zodSchema[key] = jsonSchemaPropertyToZod(prop);
    }
  }

  return zodSchema;
}

/**
 * Parameters for creating a custom MCP server
 */
export interface CreateCustomMcpServerParams {
  /** MCP server name (must be unique) */
  name: string;

  /** MCP server version */
  version: string;

  /** Array of tool definitions */
  tools: UnifiedToolDefinition[];

  /** Tool execution function (common for all tools) */
  executeToolFn: (toolName: string, input: any, context: any) => Promise<any>;

  /** Execution context (passed to all tools) */
  context: any;
}

/**
 * Create custom MCP server from tool definitions
 *
 * This function:
 * 1. Converts tool definitions to MCP format
 * 2. Handles JSON Schema → Zod conversion
 * 3. Wires up tool execution
 * 4. Returns a ready-to-use MCP server
 *
 * Used by: GitHub Tools, Google Drive, Slack, AI Media MCPs
 *
 * @param params - MCP server parameters
 * @returns MCP server factory function
 */
export function createCustomMcpServer(params: CreateCustomMcpServerParams) {
  const { name, version, tools, executeToolFn, context } = params;

  // This will be imported dynamically in McpService to avoid circular dependencies
  // The actual MCP server creation happens in McpService using:
  // - tool() from @anthropic-ai/claude-agent-sdk
  // - createSdkMcpServer() from @anthropic-ai/claude-agent-sdk

  return {
    name,
    version,
    tools,
    executeToolFn,
    context,
    // Metadata for debugging/logging
    _meta: {
      type: 'custom',
      toolCount: tools.length,
    },
  };
}

/**
 * Helper: Get tool names from tool definitions
 * @param tools - Array of tool definitions
 * @returns Array of tool names
 */
export function getToolNames(tools: UnifiedToolDefinition[]): string[] {
  return tools.map((t) => t.name);
}

/**
 * Helper: Find tool by name
 * @param tools - Array of tool definitions
 * @param name - Tool name to find
 * @returns Tool definition or undefined
 */
export function findToolByName(
  tools: UnifiedToolDefinition[],
  name: string
): UnifiedToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Helper: Validate tool definitions
 *
 * Ensures:
 * - All tools have unique names
 * - All tools have descriptions
 * - All tools have execute functions
 *
 * @param tools - Array of tool definitions
 * @returns Validation result
 */
export function validateToolDefinitions(tools: UnifiedToolDefinition[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const names = new Set<string>();

  for (const tool of tools) {
    // Check for unique names
    if (names.has(tool.name)) {
      errors.push(`Duplicate tool name: ${tool.name}`);
    }
    names.add(tool.name);

    // Check for description
    if (!tool.description) {
      errors.push(`Tool missing description: ${tool.name}`);
    }

    // Check for execute function
    if (typeof tool.execute !== 'function') {
      errors.push(`Tool missing execute function: ${tool.name}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
