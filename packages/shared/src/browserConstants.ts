/**
 * Browser-safe constants that can be used in both the client and backend
 *
 * This file contains only simple constants that don't require Node.js APIs
 * For backend-only constants (with fs, path, os, etc.), see constants.ts
 */

/**
 * Duration for tunnel loading animation (progress bar 0% → 70%)
 * Default: 500ms for fast UI feedback
 * Can be overridden via TUNNEL_LOADING_DURATION_MS environment variable
 */
export const TUNNEL_LOADING_DURATION_MS =
  typeof process !== 'undefined' && process.env?.TUNNEL_LOADING_DURATION_MS
    ? parseInt(process.env.TUNNEL_LOADING_DURATION_MS, 10)
    : 500;

/**
 * Home URL for Portable (redirect when auth fails)
 * Defaults to 'https://app.portable.dev' if not set
 */
export const HOME_PORTABLE =
  typeof process !== 'undefined' && process.env?.HOME_PORTABLE
    ? process.env.HOME_PORTABLE
    : undefined;

/**
 * Gateway URL (redirect for logout)
 * Defaults to 'https://app.portable.dev' if not set
 */
export const GATEWAY_URL =
  typeof process !== 'undefined' && process.env?.GATEWAY_URL
    ? process.env.GATEWAY_URL
    : 'https://app.portable.dev';

/**
 * The Portable WORKSPACE is itself a Claude project: a `CLAUDE.md` at the workspace
 * root describes the workspace taxonomy + what the app does, and a `tmp/` subfolder
 * (with its own `CLAUDE.md`) is the scratch space for one-off tasks.
 *
 * A "home-widget" chat that is NOT about a specific repo runs in `tmp/`. Such a chat
 * has NO associated Portable project: it is created with the reserved
 * `WORKSPACE_CHAT_OWNER` owner so the backend persists a NULL `repo_path`, which makes
 * the mobile chat list group it under the synthetic "Workspace" project
 * (`WORKSPACE_PROJECT_KEY` / `__workspace__`). `WORKSPACE_CHAT_OWNER` is deliberately an
 * invalid GitHub login (leading/trailing `_`), so it can never collide with a real owner.
 */
export const WORKSPACE_CHAT_OWNER = '__workspace__';

/** Reserved repo name paired with {@link WORKSPACE_CHAT_OWNER} for a scratch (`tmp`) chat. */
export const WORKSPACE_TMP_REPO = 'tmp';

/** The scratch directory name under the workspace root. */
export const WORKSPACE_TMP_DIR = 'tmp';

/**
 * True when an `owner`/`repo` pair targets the workspace scratch space rather than a
 * GitHub repository (the home-widget one-off-task path). Backend `handleChatCreate` uses
 * this to skip clone/validation and persist a repo-less chat; the mobile new-chat flow
 * sends the reserved pair for an auto-detected `simple-task`.
 */
export function isWorkspaceChatTarget(owner?: string | null): boolean {
  return owner === WORKSPACE_CHAT_OWNER;
}
