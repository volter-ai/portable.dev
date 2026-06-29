/**
 * useChatSettings — per-chat model/permissions/agentSetup.
 *
 * MVVM ViewModel-as-hook. The persisted source of truth is the chat-settings
 * backend (`/api/chat/:id/settings`, hydrated via {@link useChatSettingsQuery});
 * a local Zustand override (`chatStore.chatSettings`) holds the user's optimistic
 * in-app change until it is synced back via `PATCH`. A brand-new chat with no
 * server record falls back to the localStorage-equivalent {@link NEW_CHAT_SETTINGS}.
 *
 * Resolution: defaults → server → local override (see {@link resolveChatSettings}).
 */

import { useCallback, useEffect, useMemo } from 'react';

import { useChatSettingsQuery, useUpdateChatSettings } from '../api/hooks';
import {
  resolveNewChatSettings,
  useChatStore,
  type ChatSettings,
  type NewChatSettings,
} from '../state';
import { NEW_CHAT_SETTINGS, resolveChatSettings } from './chatSettingsDefaults';

export interface UseChatSettings {
  /** Fully-resolved settings (defaults ← server ← local override). */
  settings: Required<ChatSettings>;
  /** True while the initial server hydration is in flight. */
  loading: boolean;
  /** True when the chat has no server-side settings record yet (defaults applied). */
  isNewChat: boolean;
  /** Optimistically update the local override AND persist to the backend. */
  update: (partial: ChatSettings) => void;
}

export function useChatSettings(chatId: string, projectKey?: string): UseChatSettings {
  const stored = useChatStore((s) => s.chatSettings[chatId]);
  const setLocal = useChatStore((s) => s.updateChatSettings);
  const setProjectChatSettings = useChatStore((s) => s.setProjectChatSettings);

  // The per-project sticky base ("last mode selected there") — used as the
  // new-chat default when this chat has no server record yet (defaults to the
  // global last-used → freestyle when the project is unknown / unseen).
  const global = useChatStore((s) => s.newChatSettings);
  const projectEntry = useChatStore((s) =>
    projectKey ? s.settingsByProject[projectKey] : undefined
  );
  const projectDefaults = useMemo<NewChatSettings>(
    () =>
      projectKey
        ? resolveNewChatSettings(
            global,
            projectEntry ? { [projectKey]: projectEntry } : {},
            projectKey
          )
        : NEW_CHAT_SETTINGS,
    [global, projectEntry, projectKey]
  );

  const query = useChatSettingsQuery(chatId);
  const mutation = useUpdateChatSettings();

  // Hydrate the local override from the server once it arrives, so subsequent
  // selectors render the persisted values without a network round-trip.
  const serverData = query.data;
  useEffect(() => {
    if (serverData) setLocal(chatId, serverData);
  }, [chatId, serverData, setLocal]);

  const update = useCallback(
    (partial: ChatSettings) => {
      setLocal(chatId, partial);
      mutation.mutate({ chatId, settings: partial });
      // Remember this as the project's "last mode selected there" (also bumps the
      // global last-used) so the next chat for this project inherits the choice.
      if (projectKey) setProjectChatSettings(projectKey, partial as Partial<NewChatSettings>);
    },
    [chatId, setLocal, mutation, projectKey, setProjectChatSettings]
  );

  const settings = resolveChatSettings(stored, serverData ?? undefined, projectDefaults);

  return {
    settings: settings ?? NEW_CHAT_SETTINGS,
    loading: query.isLoading,
    // No server record (the query errored, e.g. a 404 for a never-persisted chat).
    isNewChat: query.isError || (!serverData && !stored),
    update,
  };
}
