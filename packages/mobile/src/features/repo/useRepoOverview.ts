/**
 * useRepoOverview — data + actions for the repo Overview tab.
 *
 * MVVM ViewModel-as-hook over the authed TanStack Query layer + the socket:
 *   - details      → `GET /api/repos/:owner/:repo?skipGitOperations=true`
 *                    (homepage, owner avatar, `isLocal`; the cheap variant —
 *                    git counts come from `git-status` below)
 *   - git status   → `useGitStatus` (`GET .../git-status`)
 *   - quick actions→ `useQuickActions` (`GET .../quick-actions`)
 *   - clone        → `POST .../clone`, then invalidate every local-dependent query
 *   - startWork / runQuickAction → the `chat:create` (+ first message) hand-off
 *     via {@link startRepoChatFlow}
 *
 * ⚠️ `GET /api/repos/:owner/:repo` returns the repo fields at the TOP LEVEL (the
 * `useRepoSettings` gotcha — the `{ repo }`-wrapped shared type lies); declared
 * locally as {@link RepoOverviewDetails}. With `skipGitOperations=true` the
 * git-derived fields (currentBranch/hasRemote/aheadBehind/…) come back
 * null/false — do NOT read them here; the status bar reads `useGitStatus`.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';

import type { CloneRepoResponse, GitStatus, QuickAction } from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { useGitStatus, useQuickActions } from '../api/hooks';
import { queryKeys } from '../api/keys';
// Direct FILE imports (the sanctioned cross-feature pattern — never the chat barrel).
import { projectKeyForOwnerRepo } from '../chat/projectKey';
import { startRepoChatFlow } from '../chat/startRepoChat';
import { useOptionalSocket } from '../socket';
import { resolveNewChatSettings, useChatStore } from '../state';

/** Bare repo-details superset (`GET /api/repos/:o/:r?skipGitOperations=true`). */
export interface RepoOverviewDetails {
  name: string;
  full_name?: string;
  description?: string | null;
  homepage?: string | null;
  default_branch?: string;
  owner?: { login: string; avatar_url?: string };
  /** Backend-computed local-clone flag (present even with skipGitOperations). */
  isLocal?: boolean;
}

/** Overview repo details — shared by the page header (avatar) and the tab. */
export function useRepoDetails(owner: string, repo: string): UseQueryResult<RepoOverviewDetails> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repoOverview(owner, repo),
    queryFn: () =>
      api.get<RepoOverviewDetails>(`/api/repos/${owner}/${repo}?skipGitOperations=true`),
    enabled: !!owner && !!repo,
  });
}

export interface UseRepoOverviewOptions {
  /** Navigation seam (default: the imperative `router.push`). */
  navigate?: (path: string) => void;
  /** chatId factory forwarded to {@link startRepoChatFlow}. */
  makeChatId?: () => string;
}

export interface UseRepoOverview {
  details: RepoOverviewDetails | undefined;
  isLoadingDetails: boolean;
  isErrorDetails: boolean;
  /** True only once details confirm the repo is cloned locally. */
  isLocal: boolean;
  gitStatus: GitStatus | undefined;
  quickActions: QuickAction[];
  loadingQuickActions: boolean;
  /**
   * Whether the chat hand-off can be INITIATED — true once the socket PROVIDER is
   * mounted (mirrors the home composer's `!!socket` gate). NOT a live-connection
   * check: a not-yet-connected socket still attempts the emit, so the send button
   * is never a permanently-dead end while the transport is still coming up.
   */
  canStartWork: boolean;
  /** `POST /clone` then refresh every local-dependent query. */
  clone: () => void;
  isCloning: boolean;
  /** "Work on {repo}..." submit → repo chat seeded with the message. */
  startWork: (message: string) => Promise<void>;
  /** Quick-action pill press. */
  runQuickAction: (action: QuickAction) => Promise<void>;
}

export function useRepoOverview(
  owner: string,
  repo: string,
  options: UseRepoOverviewOptions = {}
): UseRepoOverview {
  const api = useApi();
  const queryClient = useQueryClient();
  const socket = useOptionalSocket();
  // Per-project sticky settings ("last mode selected there"): a chat created from
  // this repo inherits the project's last-used mode, falling back to the global
  // last-used → freestyle.
  const projectKey = projectKeyForOwnerRepo(owner, repo);
  const global = useChatStore((s) => s.newChatSettings);
  const projectEntry = useChatStore((s) => s.settingsByProject[projectKey]);
  const settings = useMemo(
    () =>
      resolveNewChatSettings(
        global,
        projectEntry ? { [projectKey]: projectEntry } : {},
        projectKey
      ),
    [global, projectEntry, projectKey]
  );
  const navigate = options.navigate ?? ((path: string) => router.push(path));
  const makeChatId = options.makeChatId;

  const detailsQuery = useRepoDetails(owner, repo);
  const isLocal = detailsQuery.data?.isLocal === true;

  // Local-only surfaces — don't even ask until the clone is confirmed.
  const gitStatusQuery = useGitStatus(owner, repo, { enabled: !!owner && !!repo && isLocal });
  const quickActionsQuery = useQuickActions(owner, repo, {
    enabled: !!owner && !!repo && isLocal,
  });

  const cloneMutation = useMutation({
    mutationFn: () => api.post<CloneRepoResponse>(`/api/repos/${owner}/${repo}/clone`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repoOverview(owner, repo) });
      // Prefix match — covers every loaded directory level of the tree.
      void queryClient.invalidateQueries({ queryKey: ['tree', owner, repo] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(owner, repo) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.quickActions(owner, repo) });
      // Flush the repos LIST too: cloning flips this repo's local status, so
      // the Repos tab "Cloned" badge + the home project dropdown must refetch — same
      // stale-cache class as the composer create path. Prefix/fuzzy match so every
      // filtered `['repos', {…}]` query + `['recent-projects', limit]` refreshes.
      void queryClient.invalidateQueries({ queryKey: ['repos'] });
      void queryClient.invalidateQueries({ queryKey: ['recent-projects'] });
    },
  });

  // One in-flight chat hand-off at a time (double-tap guard).
  const startingRef = useRef(false);

  const startChat = useCallback(
    async (message: string) => {
      if (startingRef.current) return;
      // Align with the home composer (`useChatComposer`): gate only on the socket
      // PROVIDER being available, NOT on a live connection. A not-yet-connected
      // socket still attempts the emit; a failed ack rejects (restoring the input
      // below) instead of leaving a permanently-disabled, dead send button.
      if (!socket) return;
      startingRef.current = true;
      try {
        await startRepoChatFlow({
          owner,
          repo,
          settings,
          message,
          emitCreateChat: socket.emitters.createChat,
          emitSendMessage: socket.emitters.sendMessage,
          navigate: (chatId) => navigate(`/chat/${chatId}`),
          makeChatId,
        });
        // A failure PROPAGATES (no swallow) so `startWork` rejects and the
        // "Work on…" input restores the cleared text; `runQuickAction` swallows
        // its own (a pill has no input text to restore).
      } finally {
        startingRef.current = false;
      }
    },
    [socket, settings, owner, repo, navigate, makeChatId]
  );

  const startWork = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      await startChat(trimmed);
    },
    [startChat]
  );

  const runQuickAction = useCallback(
    async (action: QuickAction) => {
      if (action.type === 'message') {
        // Swallow a failed hand-off — a pill has no input text to restore.
        await startChat(action.prompt).catch(() => {});
        return;
      }
      // Runtime-backed pills (tunnel/process/browser) land on the runtime hub —
      // the deep per-resource hand-off is a documented v1 gap.
      if (action.type === 'runtime') navigate('/runtime');
    },
    [startChat, navigate]
  );

  return {
    details: detailsQuery.data,
    isLoadingDetails: detailsQuery.isLoading,
    isErrorDetails: detailsQuery.isError,
    isLocal,
    gitStatus: gitStatusQuery.data,
    quickActions: quickActionsQuery.data?.quickActions ?? [],
    loadingQuickActions: isLocal && quickActionsQuery.isLoading,
    canStartWork: !!socket,
    clone: () => cloneMutation.mutate(),
    isCloning: cloneMutation.isPending,
    startWork,
    runQuickAction,
  };
}
