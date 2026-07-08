/**
 * Client-side slash commands (portable.dev#18).
 *
 * Most `/` commands are SDK-scoped and come from the backend catalog
 * (`useChatCommands`), but a few are pure APP actions that must never reach
 * Claude. `/login` is the first: it opens the Claude Account sign-in flow
 * (Settings → Claude Account) instead of sending a message — the same
 * behaviour as Claude Code's own `/login`, surfaced on the phone.
 *
 * Both composers intercept at the SEND boundary via {@link isLoginCommand}
 * (typing `/login` and hitting send navigates instead of sending), and the
 * picker merges {@link CLIENT_SLASH_COMMANDS} into the catalog so `/login`
 * is discoverable; selecting it navigates immediately.
 */

import type { SlashCommandInfo } from '@vgit2/shared/types';

/** The Claude Account settings screen (`sectionRoute('claude-account')`). */
export const CLAUDE_ACCOUNT_ROUTE = '/settings/claude-account';

/** App-handled commands merged into the picker catalog (never sent to Claude). */
export const CLIENT_SLASH_COMMANDS: SlashCommandInfo[] = [
  {
    name: 'login',
    kind: 'builtin',
    scope: 'builtin',
    description: 'Sign in with Claude (opens Settings → Claude Account)',
  },
];

/** True when the composer content is exactly the `/login` command (no arguments). */
export function isLoginCommand(content: string): boolean {
  return /^\/login$/i.test(content.trim());
}
