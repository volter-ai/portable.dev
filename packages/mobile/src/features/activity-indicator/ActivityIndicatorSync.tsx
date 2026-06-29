/**
 * ActivityIndicatorSync — a render-null mount (the `ChatListSync` /
 * `ThemeSync` / `StoreReviewTracker` precedent) that keeps the per-platform
 * activity indicators in sync with the chats that are currently executing.
 *
 * Mounted by `AppShell` INSIDE `ApiProvider` (it reads the chat-directory query
 * cache for a chat's title/repo, like `useChatRepoPath`). It subscribes to the
 * socket-fed `chatMessagesStore` (run statuses + streamed blocks) and reconciles
 * the running set against the platform backend on every change — covering EVERY
 * chat (foreground or background) in one place, since the streaming handlers are
 * bound globally in `useNativeSocket`.
 *
 * iOS shows a Live Activity; every other platform (Android included, which
 * removed the per-second-spamming ongoing notification) is a silent no-op.
 * Every collaborator is injectable so the wiring is tested with a fake
 * service/backend and no native modules.
 */

import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { GetChatsResponse } from '@vgit2/shared/types';
import { getRepoFromPath } from '@vgit2/shared/utils/pathHelpers';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';

import { useChatMessagesStore } from '../chat/chatMessagesStore';
import { useChatChromeStore } from '../chat/chrome/chatChromeStore';

import {
  createActivityIndicatorService,
  type ActivityIndicatorService,
} from './activityIndicatorService';
import { deriveActivityIndicators, type ResolveActivityMeta } from './deriveActivityIndicators';
import { resolveActivityBackend } from './resolveActivityBackend';
import type { ActivityBackend } from './types';

export interface ActivityIndicatorSyncDeps {
  /** Inject a whole service (highest priority — used to assert reconcile calls). */
  service?: ActivityIndicatorService;
  /** Inject just the backend (the default service wraps it). */
  backend?: ActivityBackend;
  /** Inject the title/repo resolver (default reads chrome store + directory cache). */
  resolveMeta?: ResolveActivityMeta;
}

const MAX_TITLE_LENGTH = 64;

export function ActivityIndicatorSync({ deps }: { deps?: ActivityIndicatorSyncDeps } = {}): null {
  const queryClient = useQueryClient();
  const statuses = useChatMessagesStore((s) => s.statuses);
  const messages = useChatMessagesStore((s) => s.messages);
  const repoPaths = useChatChromeStore((s) => s.repoPaths);

  const service = useMemo<ActivityIndicatorService>(() => {
    if (deps?.service) return deps.service;
    return createActivityIndicatorService({
      backend: deps?.backend ?? resolveActivityBackend(Platform.OS),
    });
  }, [deps?.service, deps?.backend]);

  useEffect(() => {
    const resolveMeta: ResolveActivityMeta =
      deps?.resolveMeta ??
      ((chatId) => {
        // repo_path: the chrome store (a chat created this session) first, then the
        // cached chat-directory list — the `useChatRepoPath` resolution order.
        let repoPath: string | undefined = repoPaths[chatId];
        let chat: GetChatsResponse['chats'][number] | undefined;
        const caches = queryClient.getQueriesData<InfiniteData<GetChatsResponse>>({
          queryKey: ['chat-directory'],
        });
        for (const [, data] of caches) {
          if (!data) continue;
          for (const page of data.pages) {
            const match = page.chats.find((c) => c.id === chatId);
            if (match) {
              chat = match;
              if (!repoPath && match.repo_path) repoPath = match.repo_path;
            }
          }
        }
        const repoName = getRepoFromPath(repoPath) ?? '';
        const rawTitle =
          chat?.firstMessagePreview || chat?.summary || chat?.title || repoName || 'Portable';
        return { title: rawTitle.slice(0, MAX_TITLE_LENGTH), repoName };
      });

    service.reconcile(deriveActivityIndicators({ statuses, messages }, resolveMeta));
  }, [statuses, messages, repoPaths, queryClient, service, deps?.resolveMeta]);

  // Tear every indicator down on unmount (sign-out / session-epoch remount).
  useEffect(() => () => service.stopAll(), [service]);

  return null;
}
