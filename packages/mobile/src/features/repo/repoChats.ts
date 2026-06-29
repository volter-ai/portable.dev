/**
 * repoChats — pure helpers that pick the chats belonging to a single repository,
 * for the Overview tab's "Continue chats" preview ({@link OverviewTab}).
 *
 * A chat's repo is resolved EXACTLY as the chat card derives its repo tag
 * ({@link ../home/ChatCardBody}) so the preview agrees with the directory: the
 * backend-resolved GitHub `repoFullName` (owner/repo) wins, then the legacy
 * `claude-workspace/owner/repo` path parse, then the flat-clone disk basename
 * (repo NAME only — no owner is recoverable from a flat path, so a basename match
 * is name-only). Matching is case-insensitive.
 */

import type { ChatListItem } from '@vgit2/shared/types';

import { getRepoBasename, getRepoFromPath } from '../home/homeHelpers';

/** True when `chat` belongs to `owner/repo` (same derivation as the chat card). */
export function chatBelongsToRepo(chat: ChatListItem, owner: string, repo: string): boolean {
  const fullName = chat.repoFullName || getRepoFromPath(chat.repo_path) || undefined;
  if (fullName) return fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase();
  // No resolvable owner/repo (a flat clone) — fall back to the disk-path basename,
  // which only carries the repo NAME, so match on the repo name alone.
  const basename = getRepoBasename(chat.repo_path);
  return !!basename && basename.toLowerCase() === repo.toLowerCase();
}

/**
 * The repo's recent, non-archived chats, newest first, capped at `max`. Returned
 * to {@link ../home/HomeChatsSection} (bounded mode) so the preview shows ~3 and
 * scrolls internally without pushing the file tree below it off-screen.
 */
export function selectRepoChats(
  chats: ChatListItem[],
  owner: string,
  repo: string,
  max: number
): ChatListItem[] {
  return [...chats]
    .filter((c) => !c.archived && chatBelongsToRepo(c, owner, repo))
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
    .slice(0, max);
}
