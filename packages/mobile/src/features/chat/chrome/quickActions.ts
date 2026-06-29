/**
 * Quick-action assembly — merges the backend package-script pills
 * (`GET /api/repos/:owner/:repo/quick-actions` — "Start app", "Run tests", …)
 * with the client-synthesized **"Restart {server}"** pills, one per
 * active tunnel for this chat's repo, sorted by priority and capped.
 *
 * The **"Game" quick action is deliberately NOT synthesized**
 * here (games are out of scope on mobile). Only the server shortcuts
 * (Start via the backend, Restart via the tunnels) are surfaced.
 */

import type { QuickAction, TunnelData } from '@vgit2/shared/types';

/** Max pills shown — web `useChatQuickActions` caps the merged list at 6. */
export const MAX_QUICK_ACTIONS = 6;

/** Priority of a synthesized "Restart {server}" pill (web parity — above "Start app" at 100). */
export const RESTART_ACTION_PRIORITY = 105;

/**
 * Build the "Restart {server}" prompt sent to Claude when the pill is tapped —
 * copied verbatim from the web `useChatQuickActions` so the agent behaves
 * identically on both clients (restart the server, then re-register the tunnel).
 */
export function restartTunnelPrompt(tunnel: TunnelData, repoFullName: string): string {
  return `Restart the '${tunnel.name}' server at port ${tunnel.port} for ${repoFullName}. After the server starts successfully and you see the port number, you MUST call the show_tunnel tool with port ${tunnel.port} and name "${tunnel.name}" to re-register the tunnel. The tunnel was previously running at ${tunnel.url}`;
}

/**
 * Merge the backend quick actions with a synthesized "Restart {name}" pill per
 * active tunnel, sort by priority (desc), and cap at {@link MAX_QUICK_ACTIONS}.
 *
 * @param backendActions package-script actions from the quick-actions endpoint.
 * @param tunnels        tunnels already scoped to this chat's repo (the chrome
 *                       ViewModel filters them by `createdByRepoPath`).
 * @param repoFullName   `owner/repo` for the prompt; `null` (local / unresolved)
 *                       skips the restart pills (the backend list still shows).
 */
export function buildChatQuickActions(
  backendActions: QuickAction[],
  tunnels: TunnelData[],
  repoFullName: string | null
): QuickAction[] {
  const restartActions: QuickAction[] = repoFullName
    ? tunnels.map((tunnel) => ({
        id: `restart-tunnel-${tunnel.port}`,
        label: 'Restart ',
        labelBold: tunnel.name,
        icon: 'rotate-right',
        type: 'message',
        prompt: restartTunnelPrompt(tunnel, repoFullName),
        priority: RESTART_ACTION_PRIORITY,
      }))
    : [];

  return [...backendActions, ...restartActions]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, MAX_QUICK_ACTIONS);
}
