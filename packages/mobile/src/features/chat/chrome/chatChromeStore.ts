/**
 * Chat-chrome store — the socket-driven per-chat context info that
 * sits around the transcript: the AI summary (`chat:summary_updated`) and the
 * container setup status (`container:status`).
 *
 * In-memory Zustand, keyed by `chatId`, NOT persisted — same lifecycle as
 * `socketStore` / `chatMessagesStore` (rebuilt from the stream on each connect,
 * `reset()` on socket teardown). The REST-sourced git status + quick actions are
 * server state and live in TanStack Query (`useGitStatus` / `useQuickActions`),
 * not here.
 */

import { create } from 'zustand';

import type { ChatListItem } from '@vgit2/shared/types';

export interface ContainerStatus {
  status: 'creating' | 'ready' | 'health_check' | string;
  message: string;
}

/** The GitHub issue linked to a chat ({@link ChatListItem.linkedIssue}). */
export type LinkedIssue = NonNullable<ChatListItem['linkedIssue']>;

/**
 * Optimistic repo path for a chat the client just created — the same
 * mock shape seeded at create time (`~/claude-workspace/user/…`).
 * `getRepoFromPath` parses owner/repo out of it, which is all the git banner /
 * quick actions need; the authoritative `repo_path` from the server's
 * `chat:created` broadcast replaces it the moment it arrives (`setRepoPath`).
 */
export function optimisticRepoPath(owner: string, repo: string): string {
  return `~/claude-workspace/user/${owner}/${repo}`;
}

export interface ChatChromeState {
  /** chatId → AI-generated summary (the `chat:summary_updated` sink). */
  summaries: Record<string, string>;
  /** chatId → container setup status (the `container:status` sink). */
  containerStatus: Record<string, ContainerStatus>;
  /**
   * chatId → `repo_path` (the `chat:created` sink). A chat created THIS session
   * (repo Overview hand-off, home composer, task viewer) never appears in the
   * chat-directory query cache, so `useChatRepoPath` reads this map first —
   * without it the git banner / quick actions only show for chats opened via
   * the directory list.
   */
  repoPaths: Record<string, string>;
  /**
   * chatId → linked GitHub issue (the `chat:linkedIssueUpdated` sink). A
   * present-but-`null` entry means an explicit unlink (hide the badge); an absent
   * entry means "unknown" — `useChatLinkedIssue` then falls back to the cached
   * chat-directory list. Lets the active-chat header reflect a mid-session
   * link/unlink live.
   */
  linkedIssues: Record<string, LinkedIssue | null>;

  setSummary: (chatId: string, summary: string) => void;
  setContainerStatus: (chatId: string, status: ContainerStatus) => void;
  /** The `chat:linkedIssueUpdated` sink — `null` clears the link. */
  setLinkedIssue: (chatId: string, linkedIssue: LinkedIssue | null) => void;
  /** Authoritative write (the `chat:created` sink) — always overwrites. */
  setRepoPath: (chatId: string, repoPath: string) => void;
  /**
   * Optimistic write (a successful `chat:create` ack) — set-if-absent,
   * so it never clobbers an authoritative `chat:created` value regardless of
   * arrival order (on the creating socket the broadcast lands BEFORE the ack).
   */
  seedRepoPath: (chatId: string, repoPath: string) => void;
  clearContainerStatus: (chatId: string) => void;
  reset: () => void;
}

export const useChatChromeStore = create<ChatChromeState>()((set) => ({
  summaries: {},
  containerStatus: {},
  repoPaths: {},
  linkedIssues: {},

  setSummary: (chatId, summary) =>
    set((s) => ({ summaries: { ...s.summaries, [chatId]: summary } })),

  setContainerStatus: (chatId, status) =>
    set((s) => ({ containerStatus: { ...s.containerStatus, [chatId]: status } })),

  setLinkedIssue: (chatId, linkedIssue) =>
    set((s) => ({ linkedIssues: { ...s.linkedIssues, [chatId]: linkedIssue } })),

  setRepoPath: (chatId, repoPath) =>
    set((s) => ({ repoPaths: { ...s.repoPaths, [chatId]: repoPath } })),

  seedRepoPath: (chatId, repoPath) =>
    set((s) => (chatId in s.repoPaths ? s : { repoPaths: { ...s.repoPaths, [chatId]: repoPath } })),

  clearContainerStatus: (chatId) =>
    set((s) => {
      if (!(chatId in s.containerStatus)) return s;
      const next = { ...s.containerStatus };
      delete next[chatId];
      return { containerStatus: next };
    }),

  reset: () => set({ summaries: {}, containerStatus: {}, repoPaths: {}, linkedIssues: {} }),
}));
