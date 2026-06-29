/**
 * ClaudeService - Re-export from modular architecture
 *
 * The ClaudeService has been refactored from a single 3379-line monolithic file
 * into a modular architecture with 7 specialized handlers:
 *
 * - ProcessHandler: Background bash process checking
 * - AgentHandler: Agent configuration and setup
 * - SessionHandler: Session lifecycle management
 * - PermissionHandler: Tool permission requests
 * - ActionHandler: Action extraction from messages
 * - StreamHandler: Stream message processing
 * - ExecutionHandler: Core session execution orchestration
 *
 * All handlers are located in ./ClaudeService/ directory.
 * This file maintains backward compatibility by re-exporting the main class.
 */

export { ClaudeService } from './ClaudeService/index.js';
