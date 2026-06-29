/**
 * AuthService - Re-export from modular architecture
 *
 * The AuthService has been refactored from a single 1855-line monolithic file
 * into a modular architecture with 7 specialized handlers:
 *
 * - GitHubOAuthHandler: GitHub OAuth authentication flow
 * - GoogleOAuthHandler: Google OAuth authentication flow
 * - SlackOAuthHandler: Slack OAuth authentication flow
 * - TokenPermissionHandler: Token and permissions management
 * - UserValidationHandler: User validation and allowlist management
 * - SessionHandler: Session lifecycle management
 * - ConnectionStatusHandler: Service dependency management
 *
 * All handlers are located in ./AuthService/ directory.
 * This file maintains backward compatibility by re-exporting the main class.
 */

export { AuthService } from './AuthService/index.js';
export type { GitHubPermissionStatus } from './AuthService/index.js';
