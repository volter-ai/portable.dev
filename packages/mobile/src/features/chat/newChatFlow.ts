/**
 * createNewChatFlow — the `createNewChat` / `chat:create` orchestrator.
 *
 * Orchestrates the new-chat creation flow: analyse the user's first message for
 * intent, resolve the target repo (existing repo from intent, or create a new
 * GitHub repo / local folder), emit `chat:create` with the chosen
 * model/permissions/agentSetup/autoPilot, then send the first message — all on a
 * single chatId.
 *
 * Pure + framework-free: every I/O boundary (intent analysis, project creation,
 * socket emits, chatId generation) is an injected seam, so it runs deterministically
 * under Jest with the sandbox HTTP + Socket.IO mocked. The ViewModel
 * (`useChatComposer`) wires the real defaults (`useApi()` + the Socket.IO emitters).
 */

import { WORKSPACE_CHAT_OWNER, WORKSPACE_TMP_REPO } from '@vgit2/shared/browserConstants';
import { generateProjectCreationPrompt } from '@vgit2/shared/projectPrompts';

import type { ChatCreatePayload, ChatMessagePayload, SocketAck } from '@vgit2/shared/socket';
import type { CustomDisplay, UploadedFile } from '@vgit2/shared/types';

import { useChatMessagesStore } from './chatMessagesStore';

/**
 * Extract the error of a FAILED Socket.IO ack (`{ success: false }`), else null.
 * The shared emitters RESOLVE with the ack — a server-side rejection never
 * rejects the promise — so flows must inspect it or they silently proceed
 * against a chat/message the server refused.
 */
export function socketAckError(ack: unknown): string | null {
  if (
    ack !== null &&
    typeof ack === 'object' &&
    'success' in ack &&
    (ack as { success?: unknown }).success === false
  ) {
    const error = (ack as { error?: unknown }).error;
    return typeof error === 'string' && error.length > 0 ? error : 'Request rejected by the server';
  }
  return null;
}

/** Intent-type union returned by `POST /api/chats/analyze-intent`. */
export type IntentType = 'simple-task' | 'new-repo' | 'existing-repo';

/**
 * Intent-analysis result. The shared `AnalyzeIntentResponse`
 * type is intentionally loose (`useExistingRepo?: any`), so the precise shape is
 * declared here — same pattern as the locally-declared response types in `hooks.ts`.
 */
export interface IntentAnalysis {
  reasoning?: string;
  intentType: IntentType;
  /** Suggested folder / project name for ANY task. */
  suggestedName?: string;
  /** Only for `new-repo` — defaults to {@link DEFAULT_FRAMEWORK}. */
  suggestedFramework?: string;
  /** Only for `existing-repo`. */
  useExistingRepo?: { owner: string; repo: string };
  confidence?: number;
}

/**
 * Progress stages the flow reports while it runs (drives the web-parity
 * `ProjectCreationOverlay` animation — `ProjectCreationModal` on web):
 *
 *  - `analyzing`        — auto-detect only: `POST /api/chats/analyze-intent` in flight.
 *  - `creating-project` — a `new-repo` / `simple-task` intent is creating its
 *                         GitHub repo / local folder (framework + resolved name known).
 *  - `starting-chat`    — the target repo is resolved; `chat:create` + the first
 *                         message are being emitted (also the ONLY stage an
 *                         `existing-repo` intent reports — web shows no creation
 *                         animation for existing repos).
 */
export type NewChatFlowStage =
  | { type: 'analyzing' }
  | {
      type: 'creating-project';
      kind: 'new-repo' | 'simple-task';
      framework: string | null;
      projectName: string;
    }
  | { type: 'starting-chat'; owner: string; repo: string };

/** The model/permissions/agentSetup a new chat is created with. */
export interface NewChatFlowSettings {
  model: string;
  permissions: string;
  agentSetupId: string;
}

export interface NewChatFlowDeps {
  /** The user's first message (becomes the chat title + the first message body). */
  message: string;
  /** Chosen model/permissions/agentSetup. */
  settings: NewChatFlowSettings;
  /**
   * Already-uploaded attachments riding the first message as `files` (web
   * `ProjectCreationModal` parity: `sendMessage({ files: uploadedFiles })`).
   */
  files?: UploadedFile[];
  /**
   * Explicit framework override for a `new-repo` intent. When omitted, the
   * framework is `intent.suggestedFramework ?? DEFAULT_FRAMEWORK` (web parity).
   */
  framework?: string;
  /**
   * Explicit intent that SKIPS `analyzeIntent` (web parity: choosing "New project"
   * or an existing repo in the project-selection dropdown bypasses intent analysis).
   * When omitted, the intent is resolved via {@link analyzeIntent} (auto-detect).
   */
  forcedIntent?: IntentAnalysis;
  /** `POST /api/chats/analyze-intent`. */
  analyzeIntent: (message: string) => Promise<IntentAnalysis>;
  /** `POST /api/projects/create` → the new GitHub repo's owner/repo. */
  createProject: (
    folderName: string,
    framework: string
  ) => Promise<{ owner: string; repo: string }>;
  /** `POST /api/projects/create-local` → the local folder's owner/repo. */
  createLocalProject: (folderName: string) => Promise<{ owner: string; repo: string }>;
  /** `chat:create` socket emit. */
  emitCreateChat: (payload: ChatCreatePayload) => Promise<SocketAck>;
  /** `chat:message` socket emit (the first message). */
  sendMessage: (payload: ChatMessagePayload) => Promise<unknown>;
  /** Generate the chatId (web: `chat-${Date.now()}`). */
  makeChatId: () => string;
  /**
   * Generate the first message's id. When provided, the id rides `chat:message`
   * as `messageId` so the caller can seed the user-visible message locally and
   * dedupe the backend echo against it (the echo carries the FULL scaffolding
   * prompt for a `new-repo`, not the user's description).
   */
  makeMessageId?: () => string;
  /** Progress reporting seam (drives the creation-animation overlay). */
  onStage?: (stage: NewChatFlowStage) => void;
  /**
   * Optimistically mark the first run as started (default: the real
   * `chatMessagesStore.markRunStarted`) — keeps the typing indicator alive
   * through the session-spawn window after navigating into the new chat.
   */
  markRunStarted?: (chatId: string) => void;
  /**
   * Roll the optimistic run-start back when the first message FAILS (rejected
   * ack or transport error) — default: `chatMessagesStore.markInterrupted`
   * (status → completed + the run-start window cleared), so a later visit to
   * the chat (it exists — `chat:create` acked) shows it idle, not a ghost
   * typing indicator.
   */
  markRunFailed?: (chatId: string) => void;
}

export interface NewChatFlowResult {
  chatId: string;
  intent: IntentAnalysis;
  owner: string;
  repo: string;
  /** The framework used to create a `new-repo` project (undefined otherwise). */
  framework?: string;
}

/** Default framework for a `new-repo` intent when none is suggested (web parity: `bun`). */
export const DEFAULT_FRAMEWORK = 'bun';

/** Sanitise a free-text name into a safe folder slug (web `ProjectCreationModal` parity). */
export function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Derive a folder name from the intent's suggestion, falling back to the message. */
function resolveFolderName(intent: IntentAnalysis, message: string): string {
  const candidate = intent.suggestedName?.trim() || message.split(/\s+/).slice(0, 4).join('-');
  return sanitizeFolderName(candidate) || 'project';
}

/**
 * Run the full new-chat creation flow and return the created chatId + the resolved
 * intent/repo/framework. Throws if an `existing-repo` intent is missing its repo.
 */
export async function createNewChatFlow(deps: NewChatFlowDeps): Promise<NewChatFlowResult> {
  const { message, settings } = deps;

  // An explicit project selection (new-project / existing repo) bypasses analysis;
  // otherwise auto-detect via the intent endpoint (web `HomeInputTabs` parity).
  if (!deps.forcedIntent) deps.onStage?.({ type: 'analyzing' });
  const intent = deps.forcedIntent ?? (await deps.analyzeIntent(message));

  let owner: string;
  let repo: string;
  let framework: string | undefined;

  if (intent.intentType === 'existing-repo') {
    if (!intent.useExistingRepo?.owner || !intent.useExistingRepo?.repo) {
      throw new Error('analyze-intent returned existing-repo without a repo');
    }
    owner = intent.useExistingRepo.owner;
    repo = intent.useExistingRepo.repo;
  } else if (intent.intentType === 'new-repo') {
    framework = deps.framework ?? intent.suggestedFramework ?? DEFAULT_FRAMEWORK;
    const folderName = resolveFolderName(intent, message);
    deps.onStage?.({
      type: 'creating-project',
      kind: 'new-repo',
      framework,
      projectName: folderName,
    });
    const created = await deps.createProject(folderName, framework);
    owner = created.owner;
    repo = created.repo;
  } else {
    // simple-task — a generic one-off task with NO project. It runs in the shared
    // workspace scratch folder (`<workspace>/tmp`) and groups under the synthetic
    // "Workspace" project: we send the reserved `__workspace__`/`tmp` target so the
    // backend persists a repo-less chat (no `local/<folder>` project is created).
    const folderName = resolveFolderName(intent, message);
    deps.onStage?.({
      type: 'creating-project',
      kind: 'simple-task',
      framework: null,
      projectName: folderName,
    });
    owner = WORKSPACE_CHAT_OWNER;
    repo = WORKSPACE_TMP_REPO;
  }

  deps.onStage?.({ type: 'starting-chat', owner, repo });

  const chatId = deps.makeChatId();

  // The shared emitters resolve with the server ack — a `success:false` (e.g. a
  // prepare failure) must surface as an error, not navigate into a chat the
  // server refused to create.
  const createAck = await deps.emitCreateChat({
    chatId,
    type: 'claude_code',
    title: message,
    owner,
    repo,
    model: settings.model,
    permissions: settings.permissions,
    agentSetupId: settings.agentSetupId,
  });
  const createError = socketAckError(createAck);
  if (createError) throw new Error(createError);

  // First-message content (web `ProjectCreationModal` parity): a fresh repo gets
  // the full project-creation prompt (the backend already scaffolded the
  // framework; Claude must build on it, not re-scaffold), with `customDisplay`
  // showing only the user's description; tasks/existing repos send the raw message.
  const content =
    intent.intentType === 'new-repo'
      ? generateProjectCreationPrompt({
          framework: framework ?? null,
          projectName: repo,
          description: message,
        })
      : message;
  const customDisplay: CustomDisplay | undefined =
    content !== message ? { category: 'plainMessage', displayText: message } : undefined;

  // The first message starts a run immediately: mark it optimistically so the
  // chat screen (navigated to right after this flow resolves) opens with the
  // typing indicator up and its `chat:join` skips the stale spawn-window
  // snapshot (useChatStream's RUN_START_SYNC_GRACE_MS guard).
  (deps.markRunStarted ?? ((id: string) => useChatMessagesStore.getState().markRunStarted(id)))(
    chatId
  );

  try {
    const sendAck = await deps.sendMessage({
      chatId,
      messageId: deps.makeMessageId?.(),
      content,
      customDisplay,
      files: deps.files,
      model: settings.model,
      permissions: settings.permissions,
      agentSetupId: settings.agentSetupId,
    });
    const sendError = socketAckError(sendAck);
    if (sendError) throw new Error(sendError);
  } catch (err) {
    // The run never started server-side — clear the optimistic 'running'.
    (deps.markRunFailed ?? ((id: string) => useChatMessagesStore.getState().markInterrupted(id)))(
      chatId
    );
    throw err;
  }

  return { chatId, intent, owner, repo, framework };
}
