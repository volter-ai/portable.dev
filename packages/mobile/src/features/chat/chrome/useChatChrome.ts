/**
 * useChatChrome — the ViewModel for the per-chat context info that
 * frames the transcript: the git status banner, the AI summary panel, the
 * quick-actions bar, the container-setup status, and the runtime/tunnel
 * indicator. It composes the REST server state (git status + quick actions, via
 * TanStack Query) with the socket-driven `chatChromeStore` (summary + container
 * status) and the socket-fed `runtimeStore` (tunnels + processes).
 *
 * `repoPath` (`~/claude-workspace/{email}/{owner}/{repo}`) yields the owner/repo
 * the REST hooks need; absent / unresolvable → those queries stay disabled and
 * the banner/quick-actions simply don't render (graceful degradation, web parity
 * with a not-yet-cloned repo).
 */

import type { GitStatus, ProcessData, QuickAction, TunnelData } from '@vgit2/shared/types';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';

import { useGitStatus, useQuickActions } from '../../api/hooks';
import { useRuntimeStore } from '../../state/runtimeStore';
import { useChatChromeStore, type ContainerStatus } from './chatChromeStore';
import { buildChatQuickActions } from './quickActions';

export interface ChatChromeOwnerRepo {
  owner: string;
  repo: string;
}

export interface UseChatChromeResult {
  /** owner/repo resolved from `repoPath` (null for local / unresolvable paths). */
  repoInfo: ChatChromeOwnerRepo | null;
  gitStatus: GitStatus | undefined;
  gitStatusLoading: boolean;
  quickActions: QuickAction[];
  quickActionsLoading: boolean;
  /** AI summary (socket-driven), if any. */
  summary: string | undefined;
  /** Container setup status (socket-driven), if active. */
  containerStatus: ContainerStatus | undefined;
  /** Tunnels created by this chat's repo (socket-fed runtime state). */
  tunnels: TunnelData[];
  /** Running processes for this chat (socket-fed runtime state). */
  processes: ProcessData[];
}

export function useChatChrome(params: { chatId: string; repoPath?: string }): UseChatChromeResult {
  const { chatId, repoPath } = params;

  const repoFullName = getRepoFromPath(repoPath);
  const [pathOwner, pathRepo] = repoFullName ? repoFullName.split('/') : [undefined, undefined];
  const isLocal = pathOwner === 'local';
  const owner = isLocal ? '' : (pathOwner ?? '');
  const repo = isLocal ? '' : (pathRepo ?? '');
  const repoInfo: ChatChromeOwnerRepo | null = owner && repo ? { owner, repo } : null;

  const gitStatusQuery = useGitStatus(owner, repo);
  const quickActionsQuery = useQuickActions(owner, repo);

  const summary = useChatChromeStore((s) => s.summaries[chatId]);
  const containerStatus = useChatChromeStore((s) => s.containerStatus[chatId]);

  const allTunnels = useRuntimeStore((s) => s.tunnels);
  const allProcesses = useRuntimeStore((s) => s.processes);

  // Tunnels are scoped by the repo path that created them (web `currentChatTunnels`);
  // processes by the originating chat id.
  const tunnels = repoPath ? allTunnels.filter((t) => t.createdByRepoPath === repoPath) : [];
  const processes = allProcesses.filter((p) => p.chatId === chatId && p.status === 'running');

  // Merge the backend package-script pills with a synthesized "Restart {server}"
  // pill per active tunnel (minus games).
  // `repoFullName` (incl. a `local/*` project) is passed straight through — the
  // restart prompt needs it and `tunnels` is already repo-scoped; a null
  // (unresolved) path yields no tunnels and no restart pills.
  const quickActions = buildChatQuickActions(
    quickActionsQuery.data?.quickActions ?? [],
    tunnels,
    repoFullName
  );

  return {
    repoInfo,
    gitStatus: gitStatusQuery.data,
    gitStatusLoading: gitStatusQuery.isLoading && !!repoInfo,
    quickActions,
    quickActionsLoading: quickActionsQuery.isLoading && !!repoInfo,
    summary,
    containerStatus,
    tunnels,
    processes,
  };
}
