/**
 * Global client state (Zustand).
 *
 * Slices are split by storage sensitivity:
 *   - SecureStore-persisted: authStore (auth / sandbox-URL / Clerk).
 *   - MMKV-persisted: chatStore (drafts + AI-style), themeStore (UI prefs),
 *     reposStore (UI prefs only), offlineQueueStore (outgoing queue).
 *   - In-memory (not persisted): runtimeStore (socket-sourced).
 *
 * No JWT or secret is ever written through the MMKV adapter or plain AsyncStorage.
 */

export { secureStateStorage, mmkvStateStorage, getMmkv, MMKV_ID } from './storage';

export { useAuthStore, AUTH_PERSIST_KEY, type AuthState, type AuthUser } from './authStore';

export {
  useChatStore,
  CHAT_PERSIST_KEY,
  DEFAULT_NEW_CHAT_SETTINGS,
  resolveNewChatSettings,
  type ChatState,
  type ChatSettings,
  type NewChatSettings,
} from './chatStore';

export { useThemeStore, THEME_PERSIST_KEY, type ThemeState } from './themeStore';

export {
  useDevModeStore,
  isDevModeEnabled,
  DEV_MODE_STORAGE_KEY,
  type DevModeState,
} from './devModeStore';

export { useReposStore, REPOS_PERSIST_KEY, type ReposState } from './reposStore';

export { useRuntimeStore, type RuntimeState } from './runtimeStore';

export {
  useOfflineQueueStore,
  OFFLINE_QUEUE_PERSIST_KEY,
  type OfflineQueueState,
  type QueuedMessage,
} from './offlineQueueStore';
