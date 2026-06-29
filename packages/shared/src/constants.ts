import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

// Load .env from monorepo root FIRST
// IMPORTANT: In production mode, we load .env.prod directly into an object
// without polluting process.env to prevent child processes from inheriting secrets
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse --env-file argument from CLI (must happen before any env loading)
// Usage: bun server.ts --env-file .env.ngrok
function getEnvFileFromArgs(): string | undefined {
  const args = process.argv;
  const envFileIndex = args.indexOf('--env-file');
  if (envFileIndex !== -1 && args[envFileIndex + 1]) {
    return args[envFileIndex + 1];
  }
  return undefined;
}
const CLI_ENV_FILE = getEnvFileFromArgs();

// Parse .env file into object WITHOUT setting process.env
const envConfig: Record<string, string> = {};

// Detect if bun already loaded env file via --env-file flag
// If VGIT_PORT or ANTHROPIC_API_KEY exists in process.env, assume bun loaded the env file
const BUN_LOADED_ENV_FILE = !!(process.env.VGIT_PORT || process.env.ANTHROPIC_API_KEY);

if (BUN_LOADED_ENV_FILE) {
  // Bun already loaded env file via --env-file, use process.env directly
  // No need to load from file
} else {
  // Load env file: use --env-file arg if specified, otherwise default to .env
  const envFileName = CLI_ENV_FILE || '.env';
  const envPath = path.join(__dirname, `../../../${envFileName}`);

  try {
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    Object.assign(envConfig, parsed);
  } catch (error) {
    // Could not load .env file
  }
}

/**
 * Environment Variable Names (NOT VALUES)
 *
 * Type-safe enum of all environment variable NAMES used in the application.
 * These are the keys (e.g., 'GITHUB_TOKEN'), not the actual secret values.
 *
 * Usage:
 *   ✅ getEnv(EnvVarName.GITHUB_TOKEN)     // Returns the value from .env
 *   ✅ getEnv(EnvVarName.GITHUB_TOKEN)              // Also works (backwards compatible)
 *   ❌ EnvVarName.GITHUB_TOKEN             // This is just the string 'GITHUB_TOKEN'
 *
 * Benefits:
 *   - Autocomplete in IDE (no typos)
 *   - Type safety (catches missing env vars at compile time)
 *   - Centralized list of all environment variables
 */
export enum EnvVarName {
  // Core
  NODE_ENV = 'NODE_ENV',
  WORKSPACE_DIR = 'WORKSPACE_DIR',
  WORKSPACE_HOST_DIR = 'WORKSPACE_HOST_DIR',
  MEDIA_DIR = 'MEDIA_DIR',
  MEDIA_HOST_DIR = 'MEDIA_HOST_DIR',

  // Anthropic API
  ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL',

  // GitHub OAuth
  GITHUB_CLIENT_ID = 'GITHUB_CLIENT_ID',
  GITHUB_CLIENT_SECRET = 'GITHUB_CLIENT_SECRET',
  GITHUB_TOKEN = 'GITHUB_TOKEN',

  // GitHub App (for fine-grained permissions)
  GITHUB_APP_ID = 'GITHUB_APP_ID',
  GITHUB_APP_CLIENT_ID = 'GITHUB_APP_CLIENT_ID',
  GITHUB_APP_CLIENT_SECRET = 'GITHUB_APP_CLIENT_SECRET',
  GITHUB_APP_PRIVATE_KEY = 'GITHUB_APP_PRIVATE_KEY',
  GITHUB_APP_NAME = 'GITHUB_APP_NAME',
  GITHUB_APP_SERVICE_URL = 'GITHUB_APP_SERVICE_URL',

  // Google OAuth
  GOOGLE_CLIENT_ID = 'GOOGLE_CLIENT_ID',
  GOOGLE_CLIENT_SECRET = 'GOOGLE_CLIENT_SECRET',
  GOOGLE_DRIVE_TOKEN = 'GOOGLE_DRIVE_TOKEN',
  GOOGLE_REFRESH_TOKEN = 'GOOGLE_REFRESH_TOKEN',

  // Slack OAuth
  SLACK_CLIENT_ID = 'SLACK_CLIENT_ID',
  SLACK_CLIENT_SECRET = 'SLACK_CLIENT_SECRET',
  SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET',
  SLACK_TOKEN = 'SLACK_TOKEN',

  // Linear OAuth
  LINEAR_CLIENT_ID = 'LINEAR_CLIENT_ID',
  LINEAR_CLIENT_SECRET = 'LINEAR_CLIENT_SECRET',

  // Notion OAuth
  NOTION_CLIENT_ID = 'NOTION_CLIENT_ID',
  NOTION_CLIENT_SECRET = 'NOTION_CLIENT_SECRET',

  // Discord
  DISCORD_URL = 'DISCORD_URL',

  // Clerk (authentication provider)
  CLERK_SECRET_KEY = 'CLERK_SECRET_KEY',
  CLERK_PUBLISHABLE_KEY = 'CLERK_PUBLISHABLE_KEY',

  // Authentication & Security
  SESSION_SECRET = 'SESSION_SECRET',
  JWT_SECRET = 'JWT_SECRET',
  SERVICE_TOKEN = 'SERVICE_TOKEN', // Permanent JWT for service-to-service communication
  USERNAME = 'USERNAME',
  GITHUB_USERNAME = 'GITHUB_USERNAME',
  PORTABLE_ENCRYPTION_KEY = 'PORTABLE_ENCRYPTION_KEY',
  SERVICE_ACCOUNT_ENCRYPTION_KEY = 'SERVICE_ACCOUNT_ENCRYPTION_KEY',
  SERVICE_ACCOUNT_RATE_LIMIT = 'SERVICE_ACCOUNT_RATE_LIMIT',
  SERVICE_ACCOUNT_GLOBAL_LIMIT = 'SERVICE_ACCOUNT_GLOBAL_LIMIT',

  // External Services
  OPENAI_API_KEY = 'OPENAI_API_KEY',
  REPLICATE_API_TOKEN = 'REPLICATE_API_TOKEN',

  // Database
  REDIS_URL = 'REDIS_URL',

  // Playwright
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',

  // Server Configuration
  VGIT_PORT = 'VGIT_PORT',
  DEV_BACKEND_PORT = 'DEV_BACKEND_PORT',
  APP_URL = 'APP_URL',
  APP_SUBDOMAIN = 'APP_SUBDOMAIN',
  APP_TLD = 'APP_TLD',
  GATEWAY_URL = 'GATEWAY_URL',

  TUNNEL_LOADING_DURATION_MS = 'TUNNEL_LOADING_DURATION_MS',

  // System Paths
  NVM_BIN = 'NVM_BIN',
  HOME = 'HOME',
  HOME_PORTABLE = 'HOME_PORTABLE',
  CHROME_PROFILE_PATH = 'CHROME_PROFILE_PATH',

  // Web Push
  VAPID_PUBLIC_KEY = 'VAPID_PUBLIC_KEY',
  VAPID_PRIVATE_KEY = 'VAPID_PRIVATE_KEY',
  VAPID_SUBJECT = 'VAPID_SUBJECT',

  // Misc
  DEBUG = 'DEBUG',
  LOG_LEVEL = 'LOG_LEVEL',

  // Feature Flags
  ENABLE_PLAYWRIGHT_MCP = 'ENABLE_PLAYWRIGHT_MCP',
  ENABLE_SUGGESTIONS = 'ENABLE_SUGGESTIONS',

  USE_SNAPSHOTS = 'USE_SNAPSHOTS',
}

/**
 * Get environment variable value by name
 *
 * Checks process.env first (for command-line overrides), then envConfig (from .env file).
 * This allows command-line overrides like: VGIT_PORT=9999 bun run dev
 *
 * IMPORTANT: Application code should ALWAYS use getEnv() or exported constants, NEVER process.env
 * This keeps environment access centralized and prevents subprocess pollution.
 *
 * @param key - Environment variable name (MUST use EnvVarName enum - enforced by TypeScript)
 * @returns Environment variable value or undefined if not set
 *
 * @example
 * const githubToken = getEnv(EnvVarName.GITHUB_TOKEN);
 */
export function getEnv(key: EnvVarName): string | undefined {
  return process.env[key] || envConfig[key];
}

/**
 * Expands tilde (~) in a path to the user's home directory
 */
export function expandTilde(filepath: string | undefined): string | undefined {
  if (!filepath) return undefined;
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

// Workspace directory for cloned repositories (inside container)
// Can be overridden via WORKSPACE_DIR environment variable
const workspaceDir =
  getEnv(EnvVarName.WORKSPACE_DIR) || path.join(os.homedir(), 'claude-workspace');
export const WORKSPACE_DIR = expandTilde(workspaceDir) || workspaceDir;

// Workspace directory on the host (for Docker Swarm mounts)
// Only needed when running in Docker Swarm with user containers
// Default to WORKSPACE_DIR if not set (for local dev)
export const WORKSPACE_HOST_DIR = getEnv(EnvVarName.WORKSPACE_HOST_DIR) || WORKSPACE_DIR;

// Media directory for screenshots/videos
// Can be overridden via MEDIA_DIR environment variable
// Default: workspace/data/media (where Claude has write permissions)
const defaultMediaDir = path.join(WORKSPACE_DIR, 'data', 'media');
const mediaDir = getEnv(EnvVarName.MEDIA_DIR) || defaultMediaDir;
export const MEDIA_DIR = expandTilde(mediaDir) || mediaDir;

// Media directory on the host (for Docker Swarm mounts)
// Only needed when running in Docker Swarm with user containers
// Default to MEDIA_DIR if not set (consistent with MEDIA_DIR in dev/prod)
export const MEDIA_HOST_DIR = getEnv(EnvVarName.MEDIA_HOST_DIR) || MEDIA_DIR;

// Allowlist of authorized users
export const ALLOWED_EMAILS = [
  'yueranyuan@gmail.com',
  'careid91@gmail.com',
  'creid91@gmail.com',
  'brennan@volter.ai',
  'edmund@volter.ai',
  'edmundmtang@gmail.com',
  'brunoccpires@gmail.com',
  'bruno@volter.ai',
  'martins@volter.ai',
  'busanix@gmail.com',
  'martinstm@yahoo.com',
  'luiz@volter.ai',
  'luizfelipesmoureau@gmail.com',
  'oliver@volter.ai',
  'artur@volter.ai',
  'maria@volter.ai',
  'yuji.jams@gmail.com',
  'ffabioladelgadormz@gmail.com',
  'oliver.l.carrillo@gmail.com',
  'aighost102@gmail.com',
  'kareenarr@gmail.com',
  'simongeorge.2003@gmail.com',
];

/**
 * Sanitizes a user ID (typically email) to be safe for use in file paths
 * Replaces special characters with underscores
 *
 * @param userId - User identifier (typically email address)
 * @returns Sanitized string safe for filesystem paths
 * @example sanitizeUserId('user@example.com') → 'user_example_com'
 */
export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9.-]/g, '_');
}

/**
 * Gets the workspace directory for cloned repositories.
 *
 * On a single-user PC the per-user `<sanitized-email>` layer is **collapsed** —
 * `WORKSPACE_DIR` now points straight at the operator's repos
 * root. This is what lets a developer set `WORKSPACE_DIR` to a directory where they
 * ALREADY have repos cloned and have portable operate on those, instead of a private
 * `local_<host>/<owner>/<repo>` subtree no human ever cloned into. There is exactly
 * one OS identity per PC, so the per-user split bought nothing. The `userId` arg is
 * kept for call-site compatibility (every caller threads it) but is intentionally
 * ignored.
 *
 * @param _userId - Ignored (kept for call-site compatibility; one identity per PC).
 * @returns Absolute path to the workspace root (`WORKSPACE_DIR`).
 */
export function getUserWorkspaceDir(_userId?: string): string {
  return WORKSPACE_DIR;
}

/**
 * Absolute path to the workspace SCRATCH directory (`<workspace>/tmp`).
 *
 * This is where a home-widget chat that isn't about a specific repo is evaluated — a
 * one-off task / scratch code execution / computer-level task with no associated
 * repository. It has its own `CLAUDE.md` (see the api `ensureWorkspaceScaffold`) and is
 * deliberately NOT a Portable project (excluded from repo discovery, grouped under the
 * synthetic "Workspace" project). See `WORKSPACE_TMP_DIR` in `browserConstants.ts`.
 *
 * @param _userId - Ignored (one workspace per PC; kept for call-site symmetry).
 */
export function getWorkspaceTmpDir(_userId?: string): string {
  return path.join(WORKSPACE_DIR, 'tmp');
}

/**
 * Gets the user-specific media directory for screenshots/videos
 *
 * Each user gets an isolated media subdirectory based on their user ID.
 * Media must be in /data/media for HTTP serving.
 *
 * @param userId - User identifier (typically email address)
 * @returns Absolute path to user's media directory
 *
 * @example
 * getUserMediaDir('alice@example.com') → '/data/media/alice_example_com'
 */
export function getUserMediaDir(userId: string): string {
  const sanitized = sanitizeUserId(userId);
  return path.join(MEDIA_DIR, sanitized);
}

/**
 * Gets the user-specific upload directory for file attachments
 *
 * Each user gets an isolated uploads subdirectory within their workspace.
 * Files uploaded via chat are copied here for Claude to access.
 *
 * @param userId - User identifier (typically email address)
 * @returns Absolute path to user's uploads directory
 *
 * @example
 * getUserUploadDir('alice@example.com') → '/home/user/claude-workspace/alice_example_com/uploads'
 */
export function getUserUploadDir(userId: string): string {
  const userWorkspace = getUserWorkspaceDir(userId);
  return path.join(userWorkspace, 'uploads');
}

/**
 * Extract username from email for display purposes
 *
 * @param userId - User identifier (typically email address)
 * @returns Username portion (e.g., 'alice')
 * @example extractUsername('alice@example.com') → 'alice'
 */
export function extractUsername(userId: string): string {
  return userId
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase();
}

// ============================================================================
// ENVIRONMENT VARIABLES - Single source of truth
// ============================================================================
// All environment variables are centralized here to prevent cascading issues
// from missing or misconfigured .env files

// Required: Anthropic API
export const ANTHROPIC_API_KEY = getEnv(EnvVarName.ANTHROPIC_API_KEY);

// Optional: Custom Anthropic API base URL
// Local-first: AI calls go direct to https://api.anthropic.com (the Anthropic SDK
// default) using the user's own credential.
export const ANTHROPIC_BASE_URL = getEnv(EnvVarName.ANTHROPIC_BASE_URL);

// Required: GitHub OAuth
export const GITHUB_CLIENT_ID = getEnv(EnvVarName.GITHUB_CLIENT_ID);
export const GITHUB_CLIENT_SECRET = getEnv(EnvVarName.GITHUB_CLIENT_SECRET);

// Optional: GitHub App (for fine-grained permissions)
export const GITHUB_APP_ID = getEnv(EnvVarName.GITHUB_APP_ID);
export const GITHUB_APP_CLIENT_ID = getEnv(EnvVarName.GITHUB_APP_CLIENT_ID);
export const GITHUB_APP_CLIENT_SECRET = getEnv(EnvVarName.GITHUB_APP_CLIENT_SECRET);
export const GITHUB_APP_PRIVATE_KEY = getEnv(EnvVarName.GITHUB_APP_PRIVATE_KEY);
export const GITHUB_APP_NAME = getEnv(EnvVarName.GITHUB_APP_NAME);
export const GITHUB_APP_SERVICE_URL = getEnv(EnvVarName.GITHUB_APP_SERVICE_URL);

// Optional: Google OAuth (for Google Drive access)
export const GOOGLE_CLIENT_ID = getEnv(EnvVarName.GOOGLE_CLIENT_ID);
export const GOOGLE_CLIENT_SECRET = getEnv(EnvVarName.GOOGLE_CLIENT_SECRET);
export const GOOGLE_DRIVE_TOKEN = getEnv(EnvVarName.GOOGLE_DRIVE_TOKEN); // Dev only: Manual token override
export const GOOGLE_REFRESH_TOKEN = getEnv(EnvVarName.GOOGLE_REFRESH_TOKEN); // Dev only: Refresh token for auto-renewal

// Optional: Slack OAuth (for Slack workspace access)
export const SLACK_CLIENT_ID = getEnv(EnvVarName.SLACK_CLIENT_ID);
export const SLACK_CLIENT_SECRET = getEnv(EnvVarName.SLACK_CLIENT_SECRET);
export const SLACK_SIGNING_SECRET = getEnv(EnvVarName.SLACK_SIGNING_SECRET); // For webhook verification (future)
export const SLACK_TOKEN = getEnv(EnvVarName.SLACK_TOKEN); // Static token from OAuth (copy from console logs)

// Optional: Linear OAuth (for Linear workspace access)
export const LINEAR_CLIENT_ID = getEnv(EnvVarName.LINEAR_CLIENT_ID);
export const LINEAR_CLIENT_SECRET = getEnv(EnvVarName.LINEAR_CLIENT_SECRET);

// Optional: Notion OAuth (for Notion workspace access)
export const NOTION_CLIENT_ID = getEnv(EnvVarName.NOTION_CLIENT_ID);
export const NOTION_CLIENT_SECRET = getEnv(EnvVarName.NOTION_CLIENT_SECRET);

// Optional: Discord URL (for community links)
export const DISCORD_URL = getEnv(EnvVarName.DISCORD_URL);

// Optional: Clerk (authentication provider)
export const CLERK_SECRET_KEY = getEnv(EnvVarName.CLERK_SECRET_KEY);
export const CLERK_PUBLISHABLE_KEY = getEnv(EnvVarName.CLERK_PUBLISHABLE_KEY);

// Debug logging for SLACK_TOKEN (only in DEBUG mode after DEBUG is defined)
// Note: This will be checked again after DEBUG constant is defined

// Required: Session secret
export const SESSION_SECRET = getEnv(EnvVarName.SESSION_SECRET);

// Optional: OpenAI for voice transcription
export const OPENAI_API_KEY = getEnv(EnvVarName.OPENAI_API_KEY);

// Optional: Replicate for AI models
export const REPLICATE_API_TOKEN = getEnv(EnvVarName.REPLICATE_API_TOKEN);

// Required: Web Push Notifications (VAPID keys)
export const VAPID_PUBLIC_KEY = getEnv(EnvVarName.VAPID_PUBLIC_KEY);
export const VAPID_PRIVATE_KEY = getEnv(EnvVarName.VAPID_PRIVATE_KEY);
export const VAPID_SUBJECT = getEnv(EnvVarName.VAPID_SUBJECT);

// Optional: Redis for persistent sessions (recommended for production)
export const REDIS_URL = getEnv(EnvVarName.REDIS_URL);

// Authentication & Security
export const JWT_SECRET = getEnv(EnvVarName.JWT_SECRET);
export const SERVICE_TOKEN = getEnv(EnvVarName.SERVICE_TOKEN); // Permanent JWT for service-to-service communication
export const USERNAME = getEnv(EnvVarName.USERNAME); // Local username (provided by the launcher/env in local mode)
export const GITHUB_USERNAME = getEnv(EnvVarName.GITHUB_USERNAME); // Alternative username env var
export const PORTABLE_ENCRYPTION_KEY = getEnv(EnvVarName.PORTABLE_ENCRYPTION_KEY);
export const SERVICE_ACCOUNT_ENCRYPTION_KEY = getEnv(EnvVarName.SERVICE_ACCOUNT_ENCRYPTION_KEY);
export const SERVICE_ACCOUNT_RATE_LIMIT = getEnv(EnvVarName.SERVICE_ACCOUNT_RATE_LIMIT);
export const SERVICE_ACCOUNT_GLOBAL_LIMIT = getEnv(EnvVarName.SERVICE_ACCOUNT_GLOBAL_LIMIT);

// Environment detection
// NODE_ENV: No default - consuming code should handle undefined case explicitly
export const NODE_ENV = getEnv(EnvVarName.NODE_ENV);

// ---------------------------------------------------------------------------
// Deployment mode — REMOVED (local-first pivot).
//
// The runtime is now ALWAYS local-first (the api runs on the user's own PC).
// The sandbox code path is gone, so `getDeploymentMode()` / `isSandboxMode()` /
// `IS_PRODUCTION_MODE` / the `DeploymentMode` type and the `DEPLOYMENT_MODE` /
// `USER_ID` signals were deleted. Do NOT reintroduce a deployment-mode switch.
// ---------------------------------------------------------------------------

// Feature Flags (backend-only)
export const ENABLE_PLAYWRIGHT_MCP = getEnv(EnvVarName.ENABLE_PLAYWRIGHT_MCP);
export const ENABLE_SUGGESTIONS = getEnv(EnvVarName.ENABLE_SUGGESTIONS);

// FEATURE_FLAGS has been moved to backend-only location:
// packages/api/src/config/featureFlags.ts
//
// Backend code should import directly from there to ensure .env is loaded first
// Client code should fetch flags from API endpoints (/api/feature-flags)

// ============================================================================
// LOG LEVEL SYSTEM - Granular logging control
// ============================================================================
/**
 * Log level type - controls verbosity of logging output
 * - error: Only errors (most restrictive)
 * - warn: Errors + warnings
 * - info: Errors + warnings + essential startup/runtime logs (DEFAULT)
 * - debug: + verbose details (OAuth dumps, scope checks, service init)
 * - trace: + every operation (JWT validation, etc.)
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Current log level - defaults to 'info' for compact essential logs
 *
 * Set LOG_LEVEL in environment to change verbosity:
 * - LOG_LEVEL=info (default): ~18 startup lines, ~5-8 runtime lines
 * - LOG_LEVEL=debug: Show all original verbose logs for troubleshooting
 * - LOG_LEVEL=trace: Show every operation including repeated events
 *
 * Usage examples:
 * - LOG_LEVEL=info bun run dev   (default, compact)
 * - LOG_LEVEL=debug bun run dev  (troubleshooting)
 * - LOG_LEVEL=trace bun run dev  (full verbosity)
 * - LOG_LEVEL=warn bun run dev   (production, errors/warnings only)
 */
export const LOG_LEVEL: LogLevel = (getEnv(EnvVarName.LOG_LEVEL) || 'info') as LogLevel;

/**
 * Log level priority map - lower numbers = higher priority
 */
const levelPriority: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/**
 * Check if a log statement should be output based on current LOG_LEVEL
 *
 * @param level - The log level to check
 * @returns true if this log level should be shown
 *
 * @example
 * if (shouldLog('debug')) {
 *   console.log('[Service] Verbose initialization details...');
 * }
 */
export function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] <= levelPriority[LOG_LEVEL];
}

/**
 * Backward compatibility: DEBUG flag
 * Maps to shouldLog('debug') for existing code
 * @deprecated Use shouldLog('debug') instead
 */
export const DEBUG = shouldLog('debug');

/**
 * Helper function for debug-only logging
 * Only logs if DEBUG=true, otherwise silent
 *
 * @param args - Arguments to pass to console.log
 * @example debugLog('[Service]', 'Initializing...') // Only shows if DEBUG=true
 */
export function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log(...args);
  }
}

// Sandbox snapshots on logout (default: disabled)
// When disabled, sandboxes are immediately terminated instead of snapshotted
//
// SLACK_TOKEN loaded from environment
export const USE_SNAPSHOTS = getEnv(EnvVarName.USE_SNAPSHOTS);

// ============================================================================
// TIMING CONFIGURATION
// ============================================================================

/**
 * Duration for tunnel loading animation (progress bar 0% → 70%)
 * Default: 500ms for fast UI feedback
 * Can be overridden via TUNNEL_LOADING_DURATION_MS environment variable
 */
export const TUNNEL_LOADING_DURATION_MS = getEnv(EnvVarName.TUNNEL_LOADING_DURATION_MS)
  ? parseInt(getEnv(EnvVarName.TUNNEL_LOADING_DURATION_MS)!, 10)
  : 500;

// Playwright configuration
export const PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = getEnv(
  EnvVarName.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
);
export const PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = getEnv(EnvVarName.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD);

// Port configuration
export const VGIT_PORT = getEnv(EnvVarName.VGIT_PORT)
  ? parseInt(getEnv(EnvVarName.VGIT_PORT)!, 10)
  : 65535;

// Development-only backend port (when running Vite separately)
// In development: Backend uses DEV_BACKEND_PORT if set, else VGIT_PORT
// In production: DEV_BACKEND_PORT not set, backend uses VGIT_PORT directly
export const DEV_BACKEND_PORT = getEnv(EnvVarName.DEV_BACKEND_PORT)
  ? parseInt(getEnv(EnvVarName.DEV_BACKEND_PORT)!, 10)
  : undefined;

// Node/NVM paths (for MCP server discovery)
export const NVM_BIN = getEnv(EnvVarName.NVM_BIN);
export const HOME = getEnv(EnvVarName.HOME);

// Chrome profile path (for Playwright with persistent profile)
export const CHROME_PROFILE_PATH = getEnv(EnvVarName.CHROME_PROFILE_PATH);

// NOTE: GITHUB_TOKEN removed - GitHub tokens now managed server-side via ConnectionsService
// EnvVarName.GITHUB_TOKEN kept in enum for backward compatibility only

// Application domain configuration
export const APP_SUBDOMAIN = getEnv(EnvVarName.APP_SUBDOMAIN);
export const APP_TLD = getEnv(EnvVarName.APP_TLD);
export const APP_URL = getEnv(EnvVarName.APP_URL);

// Home URL for Portable (redirect when auth fails)
export const HOME_PORTABLE = getEnv(EnvVarName.HOME_PORTABLE);

// Gateway URL (redirect for logout)
export const GATEWAY_URL = getEnv(EnvVarName.GATEWAY_URL) || 'https://app.portable.dev';

// ============================================================================
// CLOUDFLARE STABLE TUNNELS - Local development only
// ============================================================================
// For local development, you can optionally use stable named Cloudflare tunnels
// instead of temporary Quick Tunnels. Stable tunnels provide persistent URLs
// that don't change across server restarts.
//
// Setup: Run scripts/setup-cloudflare-tunnel.sh to create a tunnel and get these values

/**
 * Get full application URL with optional path
 * @param path - Optional path to append (e.g., '/api/health')
 * @returns Full URL (e.g., 'https://app.portable.dev/api/health')
 */
export function getAppUrl(path: string = ''): string {
  if (APP_URL) {
    return `${APP_URL}${path}`;
  }
  // Fallback for local dev without APP_URL set
  const protocol = NODE_ENV === 'production' ? 'https' : 'http';
  return `${protocol}://localhost:${VGIT_PORT}${path}`;
}
