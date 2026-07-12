/**
 * startRepoChat — create a chat scoped to a repository, optionally seeded with a
 * first message, and navigate to it.
 *
 * The RN port of the web `RepoHomeTab` chat hand-off (`handleSendMessage` /
 * `handleQuickActionClick`): emit `chat:create` for the repo (the backend
 * resolves `repo_path` and auto-clones if needed), navigate to `/chat/:id`, and
 * — when a first `message` rides along — send it via `chat:message` so the
 * transcript opens already working. With a message the chat TITLE is the message;
 * without one it falls back to `owner/repo`.
 *
 * Pure orchestrator: every I/O boundary is injected (same pattern as
 * `createNewChatFlow`). The live wiring is the repo Overview tab's
 * `useRepoOverview` — the HOME grid no longer creates chats
 * (it navigates to the repo Overview page instead).
 */

import type { ChatCreatePayload, ChatMessagePayload } from '@vgit2/shared/socket';

import { useChatMessagesStore } from './chatMessagesStore';
import type { NewChatSettings } from '../state';

export interface StartRepoChatDeps {
  owner: string;
  repo: string;
  settings: NewChatSettings;
  /**
   * Optional first message (web `RepoHomeTab` parity): becomes the chat title
   * and is sent into the chat right after creation. Requires `emitSendMessage`.
   */
  message?: string;
  /**
   * Optional absolute path of a git worktree of `owner/repo` — the chat then
   * RUNS inside that worktree (the backend validates the path against the
   * repo's real worktree set and persists it as the chat cwd). portable.dev#17.
   */
  worktree?: string;
  /** `chat:create` emitter (ack `{ success }`). */
  emitCreateChat: (payload: ChatCreatePayload) => Promise<{ success?: boolean; error?: string }>;
  /** `chat:message` emitter — only used when `message` is set. */
  emitSendMessage?: (payload: ChatMessagePayload) => Promise<unknown>;
  /** Navigate to the created chat. */
  navigate: (chatId: string) => void;
  /** chatId factory (default: `chat-${Date.now()}`). */
  makeChatId?: () => string;
  /**
   * Optimistically mark the first run as started (default: the real
   * `chatMessagesStore.markRunStarted`) — keeps the typing indicator alive
   * through the session-spawn window after navigating into the new chat.
   */
  markRunStarted?: (chatId: string) => void;
}

/**
 * Create a chat scoped to `owner/repo` (+ optional first message) and navigate
 * to it. Throws when the create ack fails; a failed first-message send after a
 * successful create is swallowed (the user is already in the chat and the
 * composer can resend — navigation is never undone).
 */
export async function startRepoChatFlow(deps: StartRepoChatDeps): Promise<string> {
  const { owner, repo, settings, emitCreateChat, emitSendMessage, navigate } = deps;
  const makeChatId = deps.makeChatId ?? (() => `chat-${Date.now()}`);
  const message = deps.message?.trim() || undefined;

  const chatId = makeChatId();
  const ack = await emitCreateChat({
    chatId,
    type: 'claude_code',
    title: message ?? `${owner}/${repo}`,
    owner,
    repo,
    model: settings.model,
    permissions: settings.permissions,
    agentSetupId: settings.agentSetupId,
    ...(deps.worktree ? { worktree: deps.worktree } : {}),
  });
  if (ack?.success === false) {
    throw new Error(ack.error ?? 'Failed to create chat');
  }

  // A seeded first message starts a run immediately: mark it optimistically
  // BEFORE navigating so the chat screen opens with the typing indicator up and
  // its `chat:join` skips the stale spawn-window snapshot (useChatStream).
  if (message && emitSendMessage) {
    (deps.markRunStarted ?? ((id: string) => useChatMessagesStore.getState().markRunStarted(id)))(
      chatId
    );
  }

  // Web parity: navigate first, then send — the chat screen's room join picks
  // up the user_message echo.
  navigate(chatId);

  if (message && emitSendMessage) {
    try {
      await emitSendMessage({
        chatId,
        content: message,
        model: settings.model,
        permissions: settings.permissions,
        agentSetupId: settings.agentSetupId,
      });
    } catch {
      // Already navigated; the active chat surfaces send state itself.
    }
  }

  return chatId;
}
