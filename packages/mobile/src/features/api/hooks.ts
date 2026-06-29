/**
 * Typed endpoint hooks for the sandbox backend.
 *
 * Each hook wraps `useQuery`/`useMutation` over the shared {@link RelayApiClient}
 * (`useApi()`), targeting a real `/api/*` route and returning the corresponding
 * `@vgit2/shared` response type — so the 90+ endpoints stay consistently typed,
 * cached, and online-aware (offline → paused/queued, auto-sent on reconnect).
 *
 * Read hooks are queries; write/upload hooks are mutations (which pause offline
 * and replay automatically when connectivity returns).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';

import type {
  CreateChatResponse,
  GetAgentSetupsResponse,
  GetChatCommandsResponse,
  GetChatSettingsResponse,
  GetChatsResponse,
  GetConnectionsResponse,
  GetMcpsAvailableResponse,
  GetQuickActionsResponse,
  GetRecentProjectsResponse,
  GetReposResponse,
  GetUserOrganizationsResponse,
  GetUserResponse,
  GitStatus,
  GetUserSecretsResponse,
  GetUserSettingsResponse,
  SaveUserSettingsResponse,
  UserSettings,
  CreateProjectResponse,
  CreateLocalFolderResponse,
  VoicePhrasesResponse,
} from '@vgit2/shared/types';

import { useApi } from './ApiProvider';
import { queryKeys } from './keys';
import type { RelayApiClient } from './relayClient';

/** Notification settings (no shared type yet — mirrors the backend `/push/settings` shape). */
export interface PushNotificationSettings {
  enabled: boolean;
  taskComplete: boolean;
  notifyWhen: 'always' | 'offline';
}

/** Response of `POST /api/upload` (no shared type — mirrors `UploadService`). */
export interface UploadFileResponse {
  fileName: string;
  originalName: string;
  path: string;
  absolutePath: string;
  mimeType: string;
  size: number;
}

/** Per-hook query option overrides (key + queryFn are owned by the hook). */
type QueryOptions<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

/** Encode a flat record of query params into a `?a=1&b=2` string (empty → ''). */
function toQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return '';
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// Account-level resources
// ---------------------------------------------------------------------------

export function useUser(options?: QueryOptions<GetUserResponse>): UseQueryResult<GetUserResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.user(),
    queryFn: () => api.get<GetUserResponse>('/api/user'),
    ...options,
  });
}

/**
 * Recent local projects (`GET /api/projects/recent?limit=N`) — feeds the home input
 * project-selection dropdown. Fetch lazily (the web fetches on dropdown open), so
 * pass `enabled: isOpen`; a new sandbox with no projects yields an empty list.
 */
export function useRecentProjects(
  limit = 10,
  options?: QueryOptions<GetRecentProjectsResponse>
): UseQueryResult<GetRecentProjectsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recentProjects(limit),
    queryFn: () => api.get<GetRecentProjectsResponse>(`/api/projects/recent?limit=${limit}`),
    retry: false,
    ...options,
  });
}

export function useConnections(
  options?: QueryOptions<GetConnectionsResponse>
): UseQueryResult<GetConnectionsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.connections(),
    queryFn: () => api.get<GetConnectionsResponse>('/api/connections'),
    ...options,
  });
}

export function useSecrets(
  options?: QueryOptions<GetUserSecretsResponse>
): UseQueryResult<GetUserSecretsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.secrets(),
    queryFn: () => api.get<GetUserSecretsResponse>('/api/user/secrets'),
    ...options,
  });
}

/** The unified shape of a created project (local-only OR with a GitHub remote). */
export interface CreatedProject {
  owner: string;
  repoName: string;
  repoPath?: string;
}

/**
 * Create a new Portable project, then flush the repo caches (prefix match, the
 * `['storage-list']` precedent) so the home grid + Repos tab pick it up immediately.
 *
 * `github` is OPT-IN: when false (default) it creates a LOCAL-only git-ready project
 * (`POST /api/projects/create-local` — folder + git init + initial commit, no remote,
 * pushable to GitHub whenever you want); when true it also creates a private GitHub repo
 * + pushes (`POST /api/projects/create`, with the framework scaffold).
 */
export function useCreateProject(): UseMutationResult<
  CreatedProject,
  Error,
  { folderName: string; framework?: string; github?: boolean }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ folderName, framework, github }) => {
      if (github) {
        const res = await api.post<CreateProjectResponse>('/api/projects/create', {
          folderName,
          framework,
        });
        return { owner: res.owner, repoName: res.repoName, repoPath: res.repoPath as string };
      }
      // Local-only (git-ready, no remote/push).
      const res = await api.post<CreateLocalFolderResponse>('/api/projects/create-local', {
        folderName,
      });
      return {
        owner: res.owner as string,
        repoName: res.repoName as string,
        repoPath: res.repoPath as string,
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['repos'] });
      void qc.invalidateQueries({ queryKey: ['recent-projects'] });
    },
  });
}

/**
 * Response of `POST /api/runtime/refresh-live-view` (no shared type). Consumed by
 * the runtime feature's `useEnsureFreshLiveView` — the QueryClient-free
 * re-sign path that also serves screens mounted without an `ApiProvider`.
 */
export interface RefreshLiveViewResponse {
  success: boolean;
  liveViewUrl?: string;
  lastLiveViewRefresh?: number;
  error?: string;
}

/** Response of `GET /api/task-output?path=` (background-process output file). */
export interface TaskOutputResponse {
  content: string;
}

/**
 * Background-process output file (`GET /api/task-output?path=`). `enabled` gated
 * on a non-empty path; `refetchInterval` lets the caller poll while the process
 * runs (web 2s polling parity).
 */
export function useTaskOutput(
  path: string | undefined,
  options?: QueryOptions<TaskOutputResponse>
): UseQueryResult<TaskOutputResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.taskOutput(path ?? ''),
    queryFn: () =>
      api.get<TaskOutputResponse>(`/api/task-output?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
    retry: false,
    ...options,
  });
}

export function useUserSettings(
  options?: QueryOptions<GetUserSettingsResponse>
): UseQueryResult<GetUserSettingsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.userSettings(),
    queryFn: () => api.get<GetUserSettingsResponse>('/api/user-settings'),
    ...options,
  });
}

/**
 * Persist the full user settings (`POST /api/user-settings`, body `{ settings }`).
 *
 * The backend REPLACES `theme_config.userSettings` wholesale with the body, so the
 * caller must send the COMPLETE merged `UserSettings` (read-modify-write). On mutate
 * we optimistically write the settings into the `useUserSettings` cache so toggles
 * move instantly and stay put through the refetch; `onSuccess` invalidates to
 * reconcile with the server.
 */
export function useSaveUserSettings(): UseMutationResult<
  SaveUserSettingsResponse,
  Error,
  UserSettings
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: UserSettings) =>
      api.post<SaveUserSettingsResponse>('/api/user-settings', { settings }),
    onMutate: (settings) => {
      // The POST REPLACES userSettings wholesale, so the optimistic cache's
      // `settings` becomes exactly the posted object (the caller is contractually
      // the FULL merged UserSettings — see the read-modify-write in
      // useCommitsViewModel). `hasCompletedOnboarding` is derived the same way the
      // backend GET does (`settings?.onboardingCompleted`), so it never diverges from
      // the refetch. The functional form preserves any other response-envelope field.
      qc.setQueryData<GetUserSettingsResponse>(queryKeys.userSettings(), (prev) => ({
        ...prev,
        success: true,
        settings,
        hasCompletedOnboarding: settings.onboardingCompleted,
      }));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.userSettings() });
    },
  });
}

export function useAgentSetups(
  options?: QueryOptions<GetAgentSetupsResponse>
): UseQueryResult<GetAgentSetupsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.agentSetups(),
    queryFn: () => api.get<GetAgentSetupsResponse>('/api/agent-setups'),
    ...options,
  });
}

/**
 * Slash commands + skills available to a chat — powers the composer's `/` picker.
 * `retry:false` (a brand-new chat may 404 / have nothing yet → degrade to empty,
 * never spin); only `enabled` once there's a chatId.
 */
export function useChatCommands(
  chatId: string | undefined,
  options?: QueryOptions<GetChatCommandsResponse>
): UseQueryResult<GetChatCommandsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.chatCommands(chatId ?? ''),
    queryFn: () => api.get<GetChatCommandsResponse>(`/api/chats/${chatId}/commands`),
    enabled: !!chatId,
    retry: false,
    ...options,
  });
}

/**
 * Slash commands + skills available in a repo view (the repo Overview "Work on…"
 * input `/` picker), before a chat exists. Same response shape as
 * {@link useChatCommands}; `enabled` once owner+repo are known, `retry:false`.
 */
export function useRepoCommands(
  owner: string | undefined,
  repo: string | undefined,
  options?: QueryOptions<GetChatCommandsResponse>
): UseQueryResult<GetChatCommandsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repoCommands(owner ?? '', repo ?? ''),
    queryFn: () => api.get<GetChatCommandsResponse>(`/api/repos/${owner}/${repo}/commands`),
    enabled: !!owner && !!repo,
    retry: false,
    ...options,
  });
}

export function useMcps(
  options?: QueryOptions<GetMcpsAvailableResponse>
): UseQueryResult<GetMcpsAvailableResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.mcps(),
    queryFn: () => api.get<GetMcpsAvailableResponse>('/api/mcps/available'),
    ...options,
  });
}

export function usePushSettings(
  options?: QueryOptions<PushNotificationSettings>
): UseQueryResult<PushNotificationSettings> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.pushSettings(),
    queryFn: () => api.get<PushNotificationSettings>('/api/push/settings'),
    ...options,
  });
}

/**
 * Custom voice-dictation phrases (the on-device recognizer's contextualStrings biasing
 * vocabulary, stored on the PC). Cached long (rarely changes); adding a phrase via
 * {@link useAddVoicePhrase} invalidates this so it re-fetches.
 */
export function useVoicePhrases(
  options?: QueryOptions<VoicePhrasesResponse>
): UseQueryResult<VoicePhrasesResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.voicePhrases(),
    queryFn: () => api.get<VoicePhrasesResponse>('/api/voice/phrases'),
    staleTime: 5 * 60_000,
    ...options,
  });
}

/** Add a custom voice phrase (`POST /api/voice/phrases`) and bust the phrases cache. */
export function useAddVoicePhrase(): UseMutationResult<VoicePhrasesResponse, Error, string> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phrase: string) =>
      api.post<VoicePhrasesResponse>('/api/voice/phrases', { phrase }),
    onSuccess: (data) => {
      // Bust the cache by additions: seed the new list + invalidate so any reader refetches.
      qc.setQueryData(queryKeys.voicePhrases(), data);
      void qc.invalidateQueries({ queryKey: queryKeys.voicePhrases() });
    },
  });
}

/** Remove a custom voice phrase (`DELETE /api/voice/phrases`) and bust the phrases cache. */
export function useRemoveVoicePhrase(): UseMutationResult<VoicePhrasesResponse, Error, string> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (phrase: string) => api.del<VoicePhrasesResponse>('/api/voice/phrases', { phrase }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.voicePhrases(), data);
      void qc.invalidateQueries({ queryKey: queryKeys.voicePhrases() });
    },
  });
}

/** GitHub organizations the user belongs to (`GET /api/user/organizations`). */
export function useOrganizations(
  options?: QueryOptions<GetUserOrganizationsResponse>
): UseQueryResult<GetUserOrganizationsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.organizations(),
    queryFn: () => api.get<GetUserOrganizationsResponse>('/api/user/organizations'),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export function useChats(
  options?: QueryOptions<GetChatsResponse>
): UseQueryResult<GetChatsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.chats(),
    queryFn: () => api.get<GetChatsResponse>('/api/chats'),
    ...options,
  });
}

/** Create a chat. Pauses offline and replays on reconnect (no manual retry). */
export function useCreateChat(): UseMutationResult<CreateChatResponse, Error, unknown> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api.post<CreateChatResponse>('/api/chats', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

/**
 * Lightweight details for a chat's linked GitHub issue — the title the
 * badge shows next to `#number`.
 * `GET /api/github/issues/:owner/:repo/:number` returns a simplified issue
 * (title/state/html_url/assignee). No shared type for this trimmed shape, so it
 * is declared locally (the established locally-declared-response pattern).
 */
export interface LinkedIssueDetails {
  title: string;
  state: string;
  html_url: string;
  assignee?: { login: string; avatar_url: string };
}

/**
 * Fetch a chat's linked-issue details for the badge. `retry: false` so a
 * deleted/forbidden issue degrades quietly to a bare `#number` (never a spinner
 * loop), and a generous `staleTime` since the title rarely changes mid-session.
 * Disabled until a `linked` issue is provided.
 */
export function useLinkedIssueDetails(
  linked: { owner: string; repo: string; number: number } | null | undefined
): UseQueryResult<LinkedIssueDetails> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.linkedIssue(linked?.owner ?? '', linked?.repo ?? '', linked?.number ?? 0),
    queryFn: () =>
      api.get<LinkedIssueDetails>(
        `/api/github/issues/${linked!.owner}/${linked!.repo}/${linked!.number}`
      ),
    enabled: !!linked,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Per-chat settings (`/api/chat/:id/settings`) — model/permissions/agentSetup.
 * Single source of truth is the shared `GetChatSettingsResponse` (the GET response
 * shape, also reused for the PATCH `updated` payload).
 */
export type ChatSettingsPayload = GetChatSettingsResponse;

/** Response of `PATCH /api/chat/:chatId/settings` (mirrors `UpdateChatSettingsResponse`). */
export interface UpdateChatSettingsResult {
  success: boolean;
  updated?: ChatSettingsPayload;
}

/**
 * Hydrate a chat's persisted settings from `GET /api/chat/:chatId/settings`.
 *
 * The settings backend is the source of truth for an existing chat; a brand-new
 * chat with no server record yields no settings (the query errors / returns
 * empty) and the caller applies the localStorage-equivalent defaults. `retry:
 * false` keeps a "new chat" 404 from retrying. Disabled until a `chatId` exists.
 */
export function useChatSettingsQuery(
  chatId: string,
  options?: QueryOptions<ChatSettingsPayload>
): UseQueryResult<ChatSettingsPayload> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.chatSettings(chatId),
    queryFn: () => api.get<ChatSettingsPayload>(`/api/chat/${chatId}/settings`),
    enabled: !!chatId,
    retry: false,
    ...options,
  });
}

/** Persist a chat's settings (`PATCH /api/chat/:chatId/settings`). */
export function useUpdateChatSettings(): UseMutationResult<
  UpdateChatSettingsResult,
  Error,
  { chatId: string; settings: ChatSettingsPayload }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, settings }) =>
      api.patch<UpdateChatSettingsResult>(`/api/chat/${chatId}/settings`, settings),
    onSuccess: (_res, { chatId }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chatSettings(chatId) });
    },
  });
}

/** Archive / unarchive a chat (`PATCH /api/chats/:chatId/archive`). */
export function useArchiveChat(): UseMutationResult<
  { success: boolean },
  Error,
  { chatId: string; archived: boolean }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, archived }) =>
      api.patch<{ success: boolean }>(`/api/chats/${chatId}/archive`, { archived }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

/** Save / unsave a chat — the "Saved" category (`POST /api/chats/:chatId/save`). */
export function useSaveChat(): UseMutationResult<
  { success: boolean },
  Error,
  { chatId: string; saved: boolean }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, saved }) =>
      api.post<{ success: boolean }>(`/api/chats/${chatId}/save`, { saved }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

/** Pin / unpin a chat — floats to top + highlighted (`POST /api/chats/:chatId/pin`). */
export function useSetChatPin(): UseMutationResult<
  { success: boolean },
  Error,
  { chatId: string; pinned: boolean }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, pinned }) =>
      api.post<{ success: boolean }>(`/api/chats/${chatId}/pin`, { pinned }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

/** Permanently delete a chat (`DELETE /api/chats/:chatId`). Irreversible. */
export function useDeleteChat(): UseMutationResult<
  { success: boolean },
  Error,
  { chatId: string }
> {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId }) => api.del<{ success: boolean }>(`/api/chats/${chatId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

// ---------------------------------------------------------------------------
// Repositories & GitHub
// ---------------------------------------------------------------------------

export function useRepos(
  params?: Record<string, string | number | undefined>,
  options?: QueryOptions<GetReposResponse>
): UseQueryResult<GetReposResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repos(params),
    queryFn: () => api.get<GetReposResponse>(`/api/repos${toQuery(params)}`),
    ...options,
  });
}

/**
 * Working-tree git status for a chat's repo (`GET /api/repos/:owner/:repo/git-status`):
 * branch, ahead/behind, and staged/modified/untracked counts. Drives the
 * GitStatusBanner. A not-yet-cloned repo 404s → leave the banner hidden,
 * so this does NOT retry on error.
 */
export function useGitStatus(
  owner: string,
  repo: string,
  options?: QueryOptions<GitStatus>
): UseQueryResult<GitStatus> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.gitStatus(owner, repo),
    queryFn: () => api.get<GitStatus>(`/api/repos/${owner}/${repo}/git-status`),
    enabled: !!owner && !!repo,
    retry: false,
    ...options,
  });
}

/**
 * Contextual quick actions for a chat's repo
 * (`GET /api/repos/:owner/:repo/quick-actions`) — derived from package scripts;
 * drives the QuickActionsBar.
 */
export function useQuickActions(
  owner: string,
  repo: string,
  options?: QueryOptions<GetQuickActionsResponse>
): UseQueryResult<GetQuickActionsResponse> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.quickActions(owner, repo),
    queryFn: () => api.get<GetQuickActionsResponse>(`/api/repos/${owner}/${repo}/quick-actions`),
    enabled: !!owner && !!repo,
    retry: false,
    ...options,
  });
}

/** Re-export so call sites can type their own ad-hoc requests against the client. */
export type { RelayApiClient };
