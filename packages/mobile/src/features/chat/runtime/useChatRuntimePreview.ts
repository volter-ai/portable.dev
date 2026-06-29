/**
 * useChatRuntimePreview — selects the dev-server tunnel to surface inside a chat
 * (the "running project preview").
 *
 * The chat shows the user's running project (the dev-server tunnel) over the chat
 * once it starts, via a floating bubble. This is the
 * selection layer: from the socket-fed `runtimeStore` tunnels, pick the ONE tunnel
 * that belongs to THIS chat — scoped strictly by `createdByChatId` then
 * `createdByRepoPath` so a chat never previews another project's dev server.
 */

import type { TunnelData } from '@vgit2/shared/types';
import { useMemo } from 'react';

import type { NativeSocket } from '../../socket';
import { useRuntime } from '../../runtime/useRuntime';

/** A tunnel is "live" unless the backend explicitly flagged it inactive. */
export function isTunnelLive(tunnel: TunnelData): boolean {
  return tunnel.active !== false;
}

/**
 * Pick the dev-server tunnel for THIS chat. Prefer tunnels created by this chat,
 * else by this repo path; never fall back to an unrelated global tunnel (the
 * acceptance criterion: matched by `createdByChatId` / `createdByRepoPath`).
 * Among matches: the `main` dev server wins, then a live one, then the newest.
 */
export function selectChatTunnel(
  tunnels: TunnelData[],
  chatId: string,
  repoPath?: string
): TunnelData | null {
  if (!tunnels.length) return null;
  const byChat = chatId ? tunnels.filter((t) => t.createdByChatId === chatId) : [];
  const byRepo = repoPath ? tunnels.filter((t) => t.createdByRepoPath === repoPath) : [];
  const pool = byChat.length ? byChat : byRepo;
  if (!pool.length) return null;
  return [...pool].sort(compareTunnelPriority)[0];
}

/** main first → live first → most recently created first. */
function compareTunnelPriority(a: TunnelData, b: TunnelData): number {
  if (!!a.main !== !!b.main) return a.main ? -1 : 1;
  const aLive = isTunnelLive(a);
  const bLive = isTunnelLive(b);
  if (aLive !== bLive) return aLive ? -1 : 1;
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

/** ViewModel: the live tunnel for `chatId`/`repoPath`, or `null` when idle. */
export function useChatRuntimePreview(
  socket: NativeSocket | null,
  chatId: string,
  repoPath?: string
): TunnelData | null {
  const { tunnels } = useRuntime(socket);
  return useMemo(() => selectChatTunnel(tunnels, chatId, repoPath), [tunnels, chatId, repoPath]);
}
