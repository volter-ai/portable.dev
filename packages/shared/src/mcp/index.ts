/**
 * MCP (Model Context Protocol) Module
 *
 * Centralized MCP management including:
 * - Factory: Utilities for creating custom MCP servers
 *
 * Note: McpRegistry has been moved to packages/api/src/config/
 * and is now fetched via API endpoints instead of being bundled.
 */

export * from './CustomMcpFactory.js';
