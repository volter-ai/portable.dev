/**
 * useChatRepoPath — resolves a chat's `repo_path` from (1) the
 * chrome store's repoPaths sink (a chat created this session — repo Overview
 * hand-off, home composer, task viewer — never appears in the directory cache;
 * filled optimistically on the `chat:create` ack and authoritatively by the
 * `chat:created` broadcast), then (2) the cached chat-directory list the
 * directory screen populated (the `chat:join` ack does not carry `repo_path`).
 * The store read is reactive
 * (the `chat:created` broadcast can land after the chat screen mounts); the
 * directory-cache read stays non-reactive — `repo_path` is stable per chat, and
 * `ChatChrome` degrades gracefully to no-banner if neither source has it yet.
 */

import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { GetChatsResponse } from '@vgit2/shared/types';

import { queryKeys } from '../../api/keys';
import { useChatChromeStore } from './chatChromeStore';

export function useChatRepoPath(chatId: string): string | undefined {
  const qc = useQueryClient();
  const createdRepoPath = useChatChromeStore((s) => (chatId ? s.repoPaths[chatId] : undefined));
  if (!chatId) return undefined;
  if (createdRepoPath) return createdRepoPath;

  const caches = qc.getQueriesData<InfiniteData<GetChatsResponse>>({
    queryKey: ['chat-directory'],
  });
  for (const [, data] of caches) {
    if (!data) continue;
    for (const page of data.pages) {
      const match = page.chats.find((c) => c.id === chatId);
      if (match?.repo_path) return match.repo_path;
    }
  }

  // Cold path: the Home "Continue chats" widget populates the ['chats']
  // cache before navigation. The user may tap a chat card before the Chat tab
  // (and its ['chat-directory'] query) has ever mounted — consult this cache last.
  const chatsCache = qc.getQueryData<GetChatsResponse>(queryKeys.chats());
  if (chatsCache) {
    const match = chatsCache.chats.find((c) => c.id === chatId);
    if (match?.repo_path) return match.repo_path;
  }

  return undefined;
}
