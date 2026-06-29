/**
 * Chat slice — client state.
 *
 * Persisted via the MMKV adapter (chat drafts + AI-style/UI prefs are non-secret).
 * Server
 * state (the chat list, messages, pagination) is owned by TanStack Query,
 * NOT this slice — this holds only the local/draft/preference state.
 */

import { DEFAULT_AI_STYLE, type AIStyleMode } from '@vgit2/shared/aiStyles';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mmkvStateStorage } from './storage';

/** Per-chat overrides persisted alongside drafts (also synced to /api/chat/:id/settings). */
export interface ChatSettings {
  model?: string;
  permissions?: string;
  agentSetupId?: string;
}

/**
 * New-chat preferences — the model/permissions/agentSetup a freshly
 * created chat inherits. The web persists these globally in localStorage
 * (`vgit2_model_preference` / `vgit2_permissions_preference` /
 * `vgit2_agent_setup_preference`); the RN analog is
 * this MMKV-persisted field. Defaults match the web fallbacks.
 */
export type NewChatSettings = Required<ChatSettings>;

/** New-chat defaults (same values as `chat/chatSettingsDefaults.NEW_CHAT_SETTINGS`).
 *  Agent defaults to `freestyle` (the unopinionated direct-execution agent). */
export const DEFAULT_NEW_CHAT_SETTINGS: NewChatSettings = {
  model: DEFAULT_MODEL_MODE,
  permissions: 'bypass_permissions',
  agentSetupId: 'freestyle',
};

/**
 * Resolve the new-chat settings for a given project (the "last mode selected
 * there" memory). Precedence: built-in defaults → the global last-used
 * (`newChatSettings`) → the per-project snapshot (`settingsByProject[projectKey]`).
 *
 * A project with no remembered settings therefore falls back to the global
 * last-used, and ultimately to {@link DEFAULT_NEW_CHAT_SETTINGS} (freestyle) — so
 * the agent is NEVER silently best-practice. `projectKey` omitted (the home
 * composer, which doesn't know the project until intent analysis resolves) =
 * the global last-used only.
 */
export function resolveNewChatSettings(
  global: NewChatSettings,
  byProject: Record<string, NewChatSettings>,
  projectKey?: string
): NewChatSettings {
  const project = projectKey ? byProject[projectKey] : undefined;
  return { ...DEFAULT_NEW_CHAT_SETTINGS, ...global, ...(project ?? {}) };
}

export interface ChatState {
  activeChat: string;
  currentChatRoute: string;
  /** chatId → unsent draft text. */
  drafts: Record<string, string>;
  /** chatId → per-chat settings. */
  chatSettings: Record<string, ChatSettings>;
  /** New-chat preferences (model/permissions/agentSetup) — web localStorage parity.
   *  This is the GLOBAL last-used, used by the project-agnostic home composer and as the
   *  fallback for a project with no remembered settings. */
  newChatSettings: NewChatSettings;
  /**
   * Per-project "last mode selected there" memory, keyed by a stable project key
   * (`owner/repo` lowercased, `name:<basename>`, or the workspace sentinel — see
   * `chat/projectKey.ts`). Resolved via {@link resolveNewChatSettings}; written by
   * {@link ChatState.setProjectChatSettings} whenever a chat's settings change or a
   * new chat is created for a known project.
   */
  settingsByProject: Record<string, NewChatSettings>;

  // AI-style + render preferences (web: persisted to localStorage individually).
  aiStyle: AIStyleMode;
  customAiStylePrompt: string;
  collapseSubagentsDefault: boolean;
  autoLoadMessagesOnScroll: boolean;
  summaryRefreshInterval: number;

  setActiveChat: (chatId: string) => void;
  setCurrentChatRoute: (route: string) => void;
  updateChatDraft: (chatId: string, draft: string) => void;
  clearChatDraft: (chatId: string) => void;
  updateChatSettings: (chatId: string, settings: ChatSettings) => void;
  /** Merge a partial change into the GLOBAL new-chat preferences (model/permissions/etc.). */
  setNewChatSettings: (settings: Partial<NewChatSettings>) => void;
  /**
   * Record a chat-settings change for a specific project (the sticky memory). Merges
   * `settings` into both the per-project snapshot (resolved from the current value for
   * that project) AND the global last-used, so the global fallback always tracks the
   * most recent pick anywhere.
   */
  setProjectChatSettings: (projectKey: string, settings: Partial<NewChatSettings>) => void;
  setAiStyle: (style: AIStyleMode) => void;
  setCustomAiStylePrompt: (prompt: string) => void;
  setCollapseSubagentsDefault: (collapse: boolean) => void;
  setAutoLoadMessagesOnScroll: (enabled: boolean) => void;
  setSummaryRefreshInterval: (interval: number) => void;
  /** Wipe all chat-local state back to defaults (sign-out — `forceSignOut`). */
  reset: () => void;
}

/** MMKV persist key for the chat slice. */
export const CHAT_PERSIST_KEY = 'portable.chat';

/** The non-action chat state — the single source of both the initial + reset values. */
type ChatData = Pick<
  ChatState,
  | 'activeChat'
  | 'currentChatRoute'
  | 'drafts'
  | 'chatSettings'
  | 'newChatSettings'
  | 'settingsByProject'
  | 'aiStyle'
  | 'customAiStylePrompt'
  | 'collapseSubagentsDefault'
  | 'autoLoadMessagesOnScroll'
  | 'summaryRefreshInterval'
>;

const INITIAL_CHAT_DATA: ChatData = {
  activeChat: '',
  currentChatRoute: '/chat/directory',
  drafts: {},
  chatSettings: {},
  newChatSettings: DEFAULT_NEW_CHAT_SETTINGS,
  settingsByProject: {},
  aiStyle: DEFAULT_AI_STYLE,
  customAiStylePrompt: '',
  collapseSubagentsDefault: false, // web default: expanded
  autoLoadMessagesOnScroll: true, // web default: enabled
  summaryRefreshInterval: 30, // web default: 30s
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      ...INITIAL_CHAT_DATA,

      setActiveChat: (activeChat) => set({ activeChat }),
      setCurrentChatRoute: (currentChatRoute) => set({ currentChatRoute }),
      updateChatDraft: (chatId, draft) => set({ drafts: { ...get().drafts, [chatId]: draft } }),
      clearChatDraft: (chatId) => {
        const next = { ...get().drafts };
        delete next[chatId];
        set({ drafts: next });
      },
      updateChatSettings: (chatId, settings) =>
        set({
          chatSettings: {
            ...get().chatSettings,
            [chatId]: { ...get().chatSettings[chatId], ...settings },
          },
        }),
      setNewChatSettings: (settings) =>
        set({ newChatSettings: { ...get().newChatSettings, ...settings } }),
      setProjectChatSettings: (projectKey, settings) =>
        set((state) => {
          const base = resolveNewChatSettings(
            state.newChatSettings,
            state.settingsByProject,
            projectKey
          );
          return {
            newChatSettings: { ...state.newChatSettings, ...settings },
            settingsByProject: {
              ...state.settingsByProject,
              [projectKey]: { ...base, ...settings },
            },
          };
        }),
      setAiStyle: (aiStyle) => set({ aiStyle }),
      setCustomAiStylePrompt: (customAiStylePrompt) => set({ customAiStylePrompt }),
      setCollapseSubagentsDefault: (collapseSubagentsDefault) => set({ collapseSubagentsDefault }),
      setAutoLoadMessagesOnScroll: (autoLoadMessagesOnScroll) => set({ autoLoadMessagesOnScroll }),
      setSummaryRefreshInterval: (summaryRefreshInterval) => set({ summaryRefreshInterval }),
      reset: () => set({ ...INITIAL_CHAT_DATA }),
    }),
    {
      name: CHAT_PERSIST_KEY,
      storage: createJSONStorage(() => mmkvStateStorage),
      // v1: one-time cleanup of the STALE legacy default. `newChatSettings` is
      // persisted as a whole object, so a device that ran the app before the agent
      // default flipped best-practice → freestyle still had `agentSetupId:
      // 'best-practice'` baked into MMKV — changing DEFAULT_NEW_CHAT_SETTINGS never
      // migrated it, so the composer kept sending best-practice. Map that stale
      // default to freestyle once, and seed the new per-project map.
      version: 1,
      migrate: (persisted, fromVersion) => {
        const state = (persisted ?? {}) as Partial<ChatData>;
        if (fromVersion < 1) {
          if (state.newChatSettings?.agentSetupId === 'best-practice') {
            state.newChatSettings = { ...state.newChatSettings, agentSetupId: 'freestyle' };
          }
          if (!state.settingsByProject) state.settingsByProject = {};
        }
        return state as ChatData;
      },
    }
  )
);
