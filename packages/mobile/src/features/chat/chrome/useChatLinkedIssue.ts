/**
 * useChatLinkedIssue — resolves the GitHub issue linked to a chat from
 * (1) the chrome store's `linkedIssues` sink (the live `chat:linkedIssueUpdated`
 * write — a link/unlink established THIS session, before any directory refetch),
 * then (2) the cached chat-directory list the directory screen populated
 * (`ChatListItem.linkedIssue`; the RN `chat:join` ack does not carry it — same
 * sourcing as {@link useChatRepoPath}).
 *
 * A present-but-`null` store entry is an explicit unlink (returns `undefined`,
 * hiding the badge). The store read is reactive; the directory-cache read is
 * non-reactive (stable per chat). Returns `undefined` when nothing is linked /
 * resolvable — the badge then renders nothing (AC: "gracefully handles no link").
 */

import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { GetChatsResponse } from '@vgit2/shared/types';

import { useChatChromeStore, type LinkedIssue } from './chatChromeStore';

export function useChatLinkedIssue(chatId: string): LinkedIssue | undefined {
  const qc = useQueryClient();
  const live = useChatChromeStore((s) => (chatId ? s.linkedIssues[chatId] : undefined));
  if (!chatId) return undefined;
  // A present entry (a link OR an explicit `null` unlink) is authoritative over
  // the cache — the live socket write reflects a mid-session change.
  if (live !== undefined) return live ?? undefined;

  const caches = qc.getQueriesData<InfiniteData<GetChatsResponse>>({
    queryKey: ['chat-directory'],
  });
  for (const [, data] of caches) {
    if (!data) continue;
    for (const page of data.pages) {
      const match = page.chats.find((c) => c.id === chatId);
      if (match) return match.linkedIssue ?? undefined;
    }
  }
  return undefined;
}
