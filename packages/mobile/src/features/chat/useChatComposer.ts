/**
 * useChatComposer — the new-chat input ViewModel.
 *
 * Owns the home-input draft (debounced-persisted to MMKV via `chatStore`), the
 * model/permissions/agentSetup selectors (MMKV-persisted new-chat
 * preferences), the agent-setup option list (from `useAgentSetups()`), and the
 * `submit()` that runs {@link createNewChatFlow} (intent analysis → project
 * creation → `chat:create` → first message) and navigates to the new chat.
 *
 * MVVM ViewModel-as-hook. The HTTP seams default to the authed `useApi()` client;
 * the Socket.IO emitters come from the injected socket (default
 * `useOptionalSocket()`). Both — plus the debounce timer, chatId factory, and
 * navigator — are injectable so the screen renders + tests run deterministically
 * with the sandbox/Socket.IO mocked.
 */

import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentSetup,
  CreateLocalFolderResponse,
  CreateProjectResponse,
  UploadedFile,
} from '@vgit2/shared/types';

import { useApi } from '../api/ApiProvider';
import { useAgentSetups } from '../api/hooks';
import { useOptionalSocket, useSocketStore } from '../socket';
import type { NativeSocket } from '../socket';
import { useChatStore, type NewChatSettings } from '../state';
import { useOfflineQueueStore } from '../state/offlineQueueStore';
import { useChatMessagesStore } from './chatMessagesStore';
import { CLAUDE_ACCOUNT_ROUTE, isLoginCommand } from './composer/clientSlashCommands';
import {
  createNewChatFlow,
  socketAckError,
  type IntentAnalysis,
  type NewChatFlowResult,
  type NewChatFlowStage,
} from './newChatFlow';
import { projectKeyForOwnerRepo } from './projectKey';

/** The home input persists its draft under a reserved chat-store key. */
export const HOME_DRAFT_KEY = '__home__';

/**
 * The project-selection mode of the home input (web `HomeInputTabs` parity):
 * `workspace` is the DEFAULT general-workspace chat (no project, no overlay —
 * prd-general-workspace-home-chat, D53); `auto-detect` runs intent analysis;
 * `new-project` forces a new repo created with the chosen framework;
 * `existing-project` targets an already-cloned repo.
 */
export type ProjectSelection =
  | { type: 'auto-detect' }
  | { type: 'new-project' }
  | { type: 'existing-project'; owner: string; repo: string; path: string };

/**
 * The live project-creation status driving the `ProjectCreationOverlay`
 * animation (web `ProjectCreationModal` parity). Non-null only while a submit
 * is in flight (and never for an explicit existing-repo selection — the web
 * shows no creation animation when targeting an existing repo).
 */
export interface ProjectCreationStatus {
  /** `analyzing` = intent analysis in flight; `creating` = repo/chat creation. */
  phase: 'analyzing' | 'creating';
  /**
   * Drives the overlay copy: `project` (new repo) / `task` (legacy) show "Creating",
   * `workspace` (a one-off routed to the shared scratch — no project is created) shows
   * "Navigating Workspace".
   */
  kind: 'project' | 'task' | 'workspace';
  /** Framework id (`bun`, `nextjs`, …) for a new repo; null otherwise. */
  framework: string | null;
  /** The resolved project/repo name — slides in over the framework when known. */
  projectName: string | null;
}

/**
 * The built-in DEFAULT agent setup — shown even before `/api/agent-setups`
 * loads, then replaced by the server's full object (with its real prompt). It is
 * the placeholder for the new-chat default agent (`freestyle`), so the picker
 * trigger resolves to "Freestyle" immediately on a cold mount. A faithful
 * placeholder of the backend `FREESTYLE_SETUP`
 * (`packages/api/src/prompts/agents/freestyle.ts`): same id / name / description
 * / `colorTheme`, with `subAgents` left empty until the live list arrives.
 */
export const DEFAULT_AGENT_SETUP: AgentSetup = {
  id: 'freestyle',
  name: 'Freestyle',
  description: 'Unopinionated agent',
  systemPromptTemplate: '',
  subAgents: [],
  mcpServers: [],
  behavior: {
    useWorkflowManagement: false,
    preferDelegation: false,
    parallelExecution: false,
    planBeforeExecuting: false,
  },
  colorTheme: '#7aa892',
};

/** Debounce window (ms) before a draft keystroke is persisted to MMKV. */
export const DRAFT_DEBOUNCE_MS = 400;

export interface UseChatComposerOptions {
  /** Draft key in `chatStore.drafts` (default: the reserved home key). */
  draftKey?: string;
  /** Socket source (default: `useOptionalSocket()`). */
  socket?: NativeSocket | null;
  /** Debounce window before persisting a draft (default {@link DRAFT_DEBOUNCE_MS}). */
  debounceMs?: number;
  /** Navigate to the created chat (default: `router.push`). */
  navigate?: (chatId: string) => void;
  /** chatId factory (default: `chat-${Date.now()}`). */
  makeChatId?: () => string;
  /** First-message id factory (default: `msg-${Date.now()}`). */
  makeMessageId?: () => string;
}

export interface UseChatComposer {
  /** Current input text. */
  text: string;
  /** Update the input text (debounced-persisted to MMKV). */
  setText: (text: string) => void;
  /** Resolved new-chat settings (model/permissions/agentSetup). */
  settings: NewChatSettings;
  setModel: (model: string) => void;
  setPermissions: (permissions: string) => void;
  setAgentSetupId: (agentSetupId: string) => void;
  /** Available agent setups (full objects; always includes the built-in default). */
  agentSetups: AgentSetup[];
  /** Project-selection mode (auto-detect / new-project / existing repo). */
  projectSelection: ProjectSelection;
  setProjectSelection: (selection: ProjectSelection) => void;
  /** Selected framework id for a `new-project` (null = use the default `bun`). */
  framework: string | null;
  setFramework: (framework: string | null) => void;
  /** True while a submit is in flight. */
  submitting: boolean;
  /** Live creation-animation status (null when no creation is in flight). */
  creation: ProjectCreationStatus | null;
  /** Last submit error message, if any. */
  error: string | null;
  /** Result of the last successful submit (chatId + intent + repo + framework). */
  result: NewChatFlowResult | null;
  /** True when there is non-empty text and a socket is connected. */
  canSubmit: boolean;
  /**
   * Run the full new-chat creation flow + navigate to the new chat. Optional
   * `files` = already-uploaded attachments riding the first message (web
   * parity). Resolves `true` on success (the view clears its attachment bar).
   */
  submit: (files?: UploadedFile[]) => Promise<boolean>;
}

export function useChatComposer(options: UseChatComposerOptions = {}): UseChatComposer {
  const draftKey = options.draftKey ?? HOME_DRAFT_KEY;
  const debounceMs = options.debounceMs ?? DRAFT_DEBOUNCE_MS;

  const fallbackSocket = useOptionalSocket();
  const socket = options.socket !== undefined ? options.socket : fallbackSocket;

  const navigate = options.navigate ?? ((chatId: string) => router.push(`/chat/${chatId}`));
  const makeChatId = options.makeChatId ?? (() => `chat-${Date.now()}`);
  const makeMessageId = options.makeMessageId ?? (() => `msg-${Date.now()}`);

  const api = useApi();
  const queryClient = useQueryClient();

  // Draft: local React state seeded from MMKV, debounced back to the store.
  const persistedDraft = useChatStore((s) => s.drafts[draftKey] ?? '');
  const updateChatDraft = useChatStore((s) => s.updateChatDraft);
  const clearChatDraft = useChatStore((s) => s.clearChatDraft);
  const [text, setTextState] = useState(persistedDraft);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live mirror of `text` — the submit closure captures `text` at press time, so
  // the success path reads this to detect keystrokes typed while it was in
  // flight (those must survive the draft clear, not be wiped with it).
  const liveTextRef = useRef(persistedDraft);

  // New-chat preferences (model/permissions/agentSetup) — MMKV-persisted.
  // The home composer is project-agnostic at compose time (intent analysis resolves
  // the repo on submit), so it reads/writes the GLOBAL last-used; the resolved
  // project's sticky is recorded once the flow knows owner/repo (in `submit`).
  const settings = useChatStore((s) => s.newChatSettings);
  const setNewChatSettings = useChatStore((s) => s.setNewChatSettings);
  const setProjectChatSettings = useChatStore((s) => s.setProjectChatSettings);
  const updateChatSettings = useChatStore((s) => s.updateChatSettings);

  const [submitting, setSubmitting] = useState(false);
  const [creation, setCreation] = useState<ProjectCreationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewChatFlowResult | null>(null);
  // Synchronous re-entry guard (the `busyRef` precedent): the `submitting` state
  // only disables the button after the next commit, so a double-tap dispatched
  // before React renders would run two concurrent flows (two real repos/chats).
  const inFlightRef = useRef(false);
  // True once a `creating-project` stage fires this submit (a `new-repo` / `simple-task`
  // intent created a repo / local project). Drives the repos-cache flush in `finally`
  // the mobile client creates the repo via `POST /api/projects/create`, which
  // invalidates the BACKEND repos cache — but nothing invalidated the in-memory TanStack
  // Query cache, so the Repos tab + the home project dropdown kept showing the stale list
  // and the new repo looked "missing" until an app restart (the tester read that as a
  // failed creation). A ref (not state) so the synchronous `handleStage` callback sets it
  // without a re-render.
  const projectCreatedRef = useRef(false);

  // Project-selection mode + chosen framework (web `HomeInputTabs` parity). Local
  // UI state: it DEFAULTS to (and resets after a successful submit to) `auto-detect`
  // — a Home chat routes its message through intent analysis (existing repo / new
  // repo / one-off workspace task) unless the user opts into New project / an
  // existing repo.
  const [projectSelection, setProjectSelection] = useState<ProjectSelection>({
    type: 'auto-detect',
  });
  const [framework, setFramework] = useState<string | null>(null);

  const agentSetupsQuery = useAgentSetups();
  const agentSetups = useMemo<AgentSetup[]>(() => {
    const fromServer = agentSetupsQuery.data?.agentSetups ?? [];
    // Always expose the built-in default, deduped if the server already lists it.
    const seen = new Set(fromServer.map((s) => s.id));
    return seen.has(DEFAULT_AGENT_SETUP.id) ? fromServer : [DEFAULT_AGENT_SETUP, ...fromServer];
  }, [agentSetupsQuery.data]);

  const setText = useCallback(
    (next: string) => {
      liveTextRef.current = next;
      setTextState(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateChatDraft(draftKey, next);
        debounceRef.current = null;
      }, debounceMs);
    },
    [draftKey, debounceMs, updateChatDraft]
  );

  // Flush the pending debounced write on unmount so a draft is never lost.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const setModel = useCallback(
    (model: string) => setNewChatSettings({ model }),
    [setNewChatSettings]
  );
  const setPermissions = useCallback(
    (permissions: string) => setNewChatSettings({ permissions }),
    [setNewChatSettings]
  );
  const setAgentSetupId = useCallback(
    (agentSetupId: string) => setNewChatSettings({ agentSetupId }),
    [setNewChatSettings]
  );

  const canSubmit = text.trim().length > 0 && !!socket && !submitting;

  const submit = useCallback(
    async (files?: UploadedFile[]): Promise<boolean> => {
      const message = text.trim();
      // `/login` is a client command — open the Claude Account sign-in instead
      // of creating a chat (portable.dev#18). Works even while disconnected.
      if (isLoginCommand(message)) {
        setText('');
        router.push(CLAUDE_ACCOUNT_ROUTE);
        return true;
      }
      if (!message || !socket || inFlightRef.current) return false;
      inFlightRef.current = true;
      projectCreatedRef.current = false;
      setSubmitting(true);
      setError(null);
      // Creation animation (web `ProjectCreationModal` parity): visible from the
      // first await for auto-detect / new-project; an explicit existing repo gets
      // no creation overlay (the web goes straight to the chat there too).
      // An auto-detect home-widget message starts as "Navigating Workspace" (the
      // message is being routed through the workspace) and only flips to "Creating"
      // if intent analysis resolves to a NEW repo; an explicit new-project shows
      // "Creating" immediately. A one-off (simple-task) stays "Navigating Workspace".
      if (projectSelection.type !== 'existing-project') {
        setCreation({
          phase: 'analyzing',
          kind: projectSelection.type === 'new-project' ? 'project' : 'workspace',
          framework: projectSelection.type === 'new-project' ? framework : null,
          projectName: null,
        });
      }
      const handleStage = (stage: NewChatFlowStage) => {
        if (stage.type === 'creating-project') {
          // A repo / local project is being created — remember so `finally` flushes
          // the repos cache, even if a later step (chat-create / send) fails.
          projectCreatedRef.current = true;
          // A `simple-task` is a one-off routed to the shared workspace scratch — NO
          // project is created, so the overlay reads "Navigating Workspace" (kind
          // `workspace`, no project name) rather than "Creating <name>".
          const isWorkspace = stage.kind === 'simple-task';
          setCreation({
            phase: 'creating',
            kind: stage.kind === 'new-repo' ? 'project' : isWorkspace ? 'workspace' : 'task',
            framework: stage.framework,
            projectName: isWorkspace ? null : stage.projectName,
          });
        } else if (stage.type === 'starting-chat') {
          // Still in phase `analyzing` here ⇒ no creating-project stage fired ⇒
          // the intent resolved to an EXISTING repo: dismiss the overlay (web
          // shows no creation animation there — a full-screen "Creating
          // <existing repo>" would read as overwriting it). For new-repo /
          // simple-task the creating-project stage already set the final state.
          setCreation((prev) => (prev && prev.phase === 'creating' ? prev : null));
        }
      };

      // An explicit project selection bypasses intent analysis (web parity):
      //  - new-project → force a new repo built with the chosen framework (or `bun`)
      //  - existing-project → target the chosen already-cloned repo
      //  - auto-detect → leave undefined so `createNewChatFlow` calls analyze-intent
      let forcedIntent: IntentAnalysis | undefined;
      if (projectSelection.type === 'new-project') {
        forcedIntent = {
          intentType: 'new-repo',
          suggestedName: message,
          suggestedFramework: framework ?? undefined,
        };
      } else if (projectSelection.type === 'existing-project') {
        forcedIntent = {
          intentType: 'existing-repo',
          useExistingRepo: { owner: projectSelection.owner, repo: projectSelection.repo },
        };
      }

      try {
        const flowResult = await createNewChatFlow({
          message,
          settings,
          forcedIntent,
          files: files && files.length > 0 ? files : undefined,
          framework: framework ?? undefined,
          analyzeIntent: (m) =>
            api.post<IntentAnalysis>('/api/chats/analyze-intent', { message: m, pageContext: {} }),
          createProject: async (folderName, framework) => {
            const r = await api.post<CreateProjectResponse>('/api/projects/create', {
              folderName,
              framework,
            });
            return { owner: r.owner, repo: r.repoName };
          },
          createLocalProject: async (folderName) => {
            const r = await api.post<CreateLocalFolderResponse>('/api/projects/create-local', {
              folderName,
            });
            return {
              owner: (r.owner as string | undefined) ?? 'local',
              repo: (r.repoName as string | undefined) ?? folderName,
            };
          },
          emitCreateChat: socket.emitters.createChat,
          sendMessage: async (payload) => {
            // Seed the user-VISIBLE message before emitting: for a new repo the
            // wire content is the full scaffolding prompt and the backend echo
            // carries it verbatim — pre-storing the description under the same
            // messageId makes the echo a skipped duplicate (store dedup by id),
            // so the chat shows what the user typed (web `customDisplay` parity).
            if (payload.messageId) {
              const displayText =
                payload.customDisplay && 'displayText' in payload.customDisplay
                  ? payload.customDisplay.displayText
                  : payload.content;
              useChatMessagesStore.getState().appendUserMessage(payload.chatId, {
                id: payload.messageId,
                role: 'user',
                content: displayText,
                timestamp: Date.now(),
              });
            }
            // Roll back the seeded ghost when the PC RECEIVED the message and REJECTED
            // it (a `success:false` ack while connected) — the chat exists (create
            // acked) and could be opened later from the directory, so it must not show
            // a stale user bubble / typing indicator.
            const unseed = () => {
              if (!payload.messageId) return;
              const store = useChatMessagesStore.getState();
              store.setMessages(
                payload.chatId,
                store.getMessages(payload.chatId).filter((m) => m.id !== payload.messageId)
              );
            };
            // Durability across a tunnel changeover: the socket can drop between the
            // acked chat:create and chat:message (the launcher cycles its cloudflared
            // tunnel). If the send never reaches the PC — the socket reports down, OR
            // the emit throws because the transport was torn down mid-send — DON'T drop
            // the first message: PERSIST it to the offline queue (same messageId) and
            // KEEP the optimistic bubble. ActiveChatScreen's useOfflineMessageQueue
            // flushes the queue on the next disconnected→connected edge (the backend
            // echo dedups by id), exactly like a follow-up. A long first prompt composed
            // during a rotation is therefore resent on reconnect, not lost. Returning a
            // synthetic success lets the flow navigate into the (durably-pending) chat.
            const preserveForRetry = () => {
              useOfflineQueueStore.getState().enqueue({
                id: payload.messageId ?? `msg-${Date.now()}`,
                chatId: payload.chatId,
                content: payload.content,
                queuedAt: Date.now(),
                files: payload.files as UploadedFile[] | undefined,
              });
            };
            // Socket reports down (tunnel changeover) → the send can't reach the PC →
            // preserve, don't even try (mirrors the follow-up useOfflineMessageQueue).
            if (!useSocketStore.getState().connected) {
              preserveForRetry();
              return { success: true };
            }
            try {
              const ack = await socket.emitters.sendMessage(payload);
              // A REJECTION (the PC answered success:false) is NOT a lost message — roll
              // back and let the flow surface the error.
              if (socketAckError(ack)) unseed();
              return ack;
            } catch {
              // The emit threw (transport torn down mid-send) — the message never
              // reached the PC, so preserve it for the reconnect flush.
              preserveForRetry();
              return { success: true };
            }
          },
          makeChatId,
          makeMessageId,
          onStage: handleStage,
        });

        // Clear the home draft now the first message has been sent — but ONLY if
        // the input still holds the submitted text: keystrokes typed while the
        // flow was in flight are newer input and must survive (along with their
        // pending debounced write). When clearing, cancel the pending write
        // first, or it would land AFTER the clear and resurrect the sent draft.
        if (liveTextRef.current.trim() === message) {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          clearChatDraft(draftKey);
          liveTextRef.current = '';
          setTextState('');
        }
        setResult(flowResult);
        // Seed the chat's OWN local settings snapshot — issue #4: this chat must keep
        // showing the permission it was created with for its whole lifetime, never the
        // project's (mutable) "last mode selected there", which a LATER chat in the same
        // project can overwrite.
        updateChatSettings(flowResult.chatId, settings);
        // Remember the settings used as this project's "last mode selected there"
        // so the next chat for the resolved repo inherits it (per-project sticky).
        setProjectChatSettings(projectKeyForOwnerRepo(flowResult.owner, flowResult.repo), settings);
        // Reset the project/framework selection back to auto-detect (web parity).
        setProjectSelection({ type: 'auto-detect' });
        setFramework(null);
        navigate(flowResult.chatId);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create chat');
        return false;
      } finally {
        inFlightRef.current = false;
        setSubmitting(false);
        setCreation(null);
        // Flush the repos caches when this submit created a repo / local project
        // Prefix/fuzzy match (the `['storage-list']` precedent) so EVERY
        // filtered Repos-tab query (`['repos', { search?, language?, sort }]`) AND the
        // home project-selection dropdown (`['recent-projects', limit]`) refetch — the
        // freshly-created repo then appears immediately instead of staying hidden
        // behind the stale in-memory cache until an app restart.
        if (projectCreatedRef.current) {
          void queryClient.invalidateQueries({ queryKey: ['repos'] });
          void queryClient.invalidateQueries({ queryKey: ['recent-projects'] });
        }
      }
    },
    [
      api,
      clearChatDraft,
      draftKey,
      framework,
      makeChatId,
      makeMessageId,
      navigate,
      projectSelection,
      queryClient,
      setProjectChatSettings,
      settings,
      socket,
      updateChatSettings,
      text,
    ]
  );

  return {
    text,
    setText,
    settings,
    setModel,
    setPermissions,
    setAgentSetupId,
    agentSetups,
    projectSelection,
    setProjectSelection,
    framework,
    setFramework,
    submitting,
    creation,
    error,
    result,
    canSubmit,
    submit,
  };
}
