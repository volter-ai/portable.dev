/**
 * Zustand stores with persistence split.
 *
 * Asserts the secret/non-secret storage split:
 *   - auth / sandbox-URL slice persists via the expo-secure-store adapter.
 *   - chat drafts / theme UI prefs / offline queue persist via MMKV.
 *   - each slice rehydrates from its OWN backend.
 *   - no JWT/secret value is ever written to MMKV or to plain AsyncStorage.
 *
 * Both backends are mocked with inspectable in-memory Maps; AsyncStorage is a
 * recording virtual mock (nothing imports it — so it must stay untouched).
 */

import {
  useAuthStore,
  AUTH_PERSIST_KEY,
  useChatStore,
  CHAT_PERSIST_KEY,
  useThemeStore,
  THEME_PERSIST_KEY,
  useReposStore,
  REPOS_PERSIST_KEY,
  useOfflineQueueStore,
  OFFLINE_QUEUE_PERSIST_KEY,
} from '../src/features/state';

// In-memory expo-secure-store: jest-expo provides no working SecureStore.
jest.mock('expo-secure-store', () => ({
  __store: new Map<string, string>(),
  setItemAsync: jest.fn(function (this: void, key: string, value: string) {
    (jest.requireMock('expo-secure-store') as { __store: Map<string, string> }).__store.set(
      key,
      value
    );
    return Promise.resolve();
  }),
  getItemAsync: jest.fn((key: string) => {
    const s = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> }).__store;
    return Promise.resolve(s.has(key) ? s.get(key)! : null);
  }),
  deleteItemAsync: jest.fn((key: string) => {
    (jest.requireMock('expo-secure-store') as { __store: Map<string, string> }).__store.delete(key);
    return Promise.resolve();
  }),
}));

// In-memory MMKV: react-native-mmkv is a native (nitro) module, unusable in Jest.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had;
    },
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

// Recording virtual AsyncStorage — NOTHING should import it; if a slice ever
// leaks to plain AsyncStorage these spies would fire.
jest.mock(
  '@react-native-async-storage/async-storage',
  () => {
    const api = {
      setItem: jest.fn(() => Promise.resolve()),
      getItem: jest.fn(() => Promise.resolve(null)),
      removeItem: jest.fn(() => Promise.resolve()),
    };
    return { __esModule: true, default: api, ...api };
  },
  { virtual: true }
);

const secureMock = () =>
  jest.requireMock('expo-secure-store') as {
    __store: Map<string, string>;
    setItemAsync: jest.Mock;
  };
const mmkvMock = () => jest.requireMock('react-native-mmkv') as { __store: Map<string, string> };
const asyncStorageMock = () =>
  jest.requireMock('@react-native-async-storage/async-storage') as {
    setItem: jest.Mock;
  };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  secureMock().__store.clear();
  secureMock().setItemAsync.mockClear();
  mmkvMock().__store.clear();
  asyncStorageMock().setItem.mockClear();
});

describe('persistence split — secrets → SecureStore, non-secrets → MMKV', () => {
  it('persists the auth/sandbox slice ONLY via the SecureStore adapter', async () => {
    useAuthStore.getState().setUser({
      userId: 'u-1',
      username: 'octocat',
      email: 'octo@example.com',
    });
    useAuthStore.getState().setSandboxUrl('https://sandbox-abc.modal.run');
    await flush();

    const secureRaw = secureMock().__store.get(AUTH_PERSIST_KEY);
    expect(secureRaw).toBeDefined();
    expect(secureRaw).toContain('octo@example.com');
    expect(secureRaw).toContain('https://sandbox-abc.modal.run');

    // The auth slice must NOT land in the MMKV (non-secret) backend...
    expect(mmkvMock().__store.has(AUTH_PERSIST_KEY)).toBe(false);
    // ...nor in plain AsyncStorage, and the sandbox URL must not leak there.
    for (const v of mmkvMock().__store.values()) {
      expect(v).not.toContain('sandbox-abc.modal.run');
    }
    expect(asyncStorageMock().setItem).not.toHaveBeenCalled();
  });

  it('persists chat drafts + AI-style prefs via MMKV (not SecureStore)', async () => {
    useChatStore.getState().updateChatDraft('chat-1', 'an unsent draft');
    useChatStore.getState().setAiStyle('pirate');
    await flush();

    const mmkvRaw = mmkvMock().__store.get(CHAT_PERSIST_KEY);
    expect(mmkvRaw).toBeDefined();
    expect(mmkvRaw).toContain('an unsent draft');
    expect(mmkvRaw).toContain('pirate');

    expect(secureMock().__store.has(CHAT_PERSIST_KEY)).toBe(false);
    expect(asyncStorageMock().setItem).not.toHaveBeenCalled();
  });

  it('persists theme UI prefs and ONLY the repos UI prefs via MMKV', async () => {
    useThemeStore.getState().setAccent('teal');
    useReposStore.getState().setSearchQuery('react-native');
    useReposStore.getState().setLanguageFilter('TypeScript');
    // Server cache must NOT be persisted (partialize drops it).
    useReposStore.getState().setPreloadedRepos([
      // minimal Repository-ish object; only the persistence path is under test
      { id: 1, name: 'should-not-persist' } as never,
    ]);
    await flush();

    expect(mmkvMock().__store.get(THEME_PERSIST_KEY)).toContain('teal');

    const reposRaw = mmkvMock().__store.get(REPOS_PERSIST_KEY)!;
    expect(reposRaw).toContain('react-native');
    expect(reposRaw).toContain('TypeScript');
    expect(reposRaw).not.toContain('should-not-persist');

    expect(secureMock().__store.has(THEME_PERSIST_KEY)).toBe(false);
    expect(secureMock().__store.has(REPOS_PERSIST_KEY)).toBe(false);
  });

  it('persists the offline message queue via MMKV so it survives app kill', async () => {
    useOfflineQueueStore.getState().enqueue({
      id: 'm-1',
      chatId: 'chat-1',
      content: 'queued while offline',
      queuedAt: 1_000,
    });
    await flush();

    const raw = mmkvMock().__store.get(OFFLINE_QUEUE_PERSIST_KEY);
    expect(raw).toBeDefined();
    expect(raw).toContain('queued while offline');
    expect(secureMock().__store.has(OFFLINE_QUEUE_PERSIST_KEY)).toBe(false);
    expect(asyncStorageMock().setItem).not.toHaveBeenCalled();
  });
});

describe('rehydration restores each slice from its correct backend', () => {
  it('rehydrates the auth slice from SecureStore', async () => {
    secureMock().__store.set(
      AUTH_PERSIST_KEY,
      JSON.stringify({
        state: {
          user: { userId: 'u-9', username: 'restored', email: 'r@example.com' },
          isAuthenticated: true,
          onWaitlist: false,
          sandboxUrl: 'https://restored.modal.run',
        },
        version: 0,
      })
    );

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.user?.email).toBe('r@example.com');
    expect(s.isAuthenticated).toBe(true);
    expect(s.sandboxUrl).toBe('https://restored.modal.run');
  });

  it('rehydrates the chat slice from MMKV', async () => {
    mmkvMock().__store.set(
      CHAT_PERSIST_KEY,
      JSON.stringify({
        state: {
          activeChat: 'chat-7',
          currentChatRoute: '/chat/directory',
          drafts: { 'chat-7': 'restored draft' },
          chatSettings: {},
          aiStyle: 'zen',
          customAiStylePrompt: '',
          collapseSubagentsDefault: true,
          autoLoadMessagesOnScroll: false,
          summaryRefreshInterval: 60,
        },
        version: 0,
      })
    );

    await useChatStore.persist.rehydrate();

    const s = useChatStore.getState();
    expect(s.drafts['chat-7']).toBe('restored draft');
    expect(s.aiStyle).toBe('zen');
    expect(s.summaryRefreshInterval).toBe(60);
  });

  it('rehydrates the offline queue from MMKV', async () => {
    mmkvMock().__store.set(
      OFFLINE_QUEUE_PERSIST_KEY,
      JSON.stringify({
        state: {
          queue: [{ id: 'm-2', chatId: 'c-2', content: 'survived kill', queuedAt: 5 }],
        },
        version: 0,
      })
    );

    await useOfflineQueueStore.persist.rehydrate();

    const q = useOfflineQueueStore.getState().queue;
    expect(q).toHaveLength(1);
    expect(q[0].content).toBe('survived kill');
  });
});
