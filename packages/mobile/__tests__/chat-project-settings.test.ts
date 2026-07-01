/**
 * Per-project sticky chat settings ("last mode selected there") + the stale
 * best-practice → freestyle migration.
 *
 * Covers the pure resolver/key helpers, the `setProjectChatSettings` store action
 * (writes BOTH the per-project snapshot AND the global last-used), and the v1
 * persist migration that maps the stale earlier default (`agentSetupId:
 * 'best-practice'` baked into MMKV before the default flipped to freestyle) to
 * freestyle on rehydrate.
 */

import {
  DEFAULT_NEW_CHAT_SETTINGS,
  resolveNewChatSettings,
  useChatStore,
  CHAT_PERSIST_KEY,
  type NewChatSettings,
} from '../src/features/state';
import {
  projectKeyForOwnerRepo,
  projectKeyFromRepoPath,
  WORKSPACE_PROJECT_KEY,
} from '../src/features/chat/projectKey';

// In-memory MMKV (native nitro module — unusable in Jest). chatStore persists here.
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

const mmkvMock = () => jest.requireMock('react-native-mmkv') as { __store: Map<string, string> };

beforeEach(() => {
  mmkvMock().__store.clear();
  useChatStore.getState().reset();
});

describe('resolveNewChatSettings — precedence', () => {
  const global: NewChatSettings = {
    model: 'opus',
    permissions: 'bypass_permissions',
    agentSetupId: 'orchestrator',
    effort: 'high',
  };

  it('falls back to the global last-used when the project has no record', () => {
    expect(resolveNewChatSettings(global, {}, 'acme/widget')).toEqual(global);
  });

  it('falls back to the global last-used when no projectKey is given (home composer)', () => {
    expect(resolveNewChatSettings(global, { 'acme/widget': global })).toEqual(global);
  });

  it('prefers the per-project snapshot over the global', () => {
    const project: NewChatSettings = { ...global, agentSetupId: 'best-practice', model: 'haiku' };
    expect(resolveNewChatSettings(global, { 'acme/widget': project }, 'acme/widget')).toEqual(
      project
    );
  });

  it('defaults to freestyle when neither global nor project is set', () => {
    expect(resolveNewChatSettings(DEFAULT_NEW_CHAT_SETTINGS, {}).agentSetupId).toBe('freestyle');
  });
});

describe('projectKey helpers', () => {
  it('keys a GitHub repo by lowercased owner/repo', () => {
    expect(projectKeyForOwnerRepo('Acme', 'Widget')).toBe('acme/widget');
  });

  it('keys the reserved workspace target by the workspace sentinel', () => {
    expect(projectKeyForOwnerRepo('__workspace__', 'tmp')).toBe(WORKSPACE_PROJECT_KEY);
  });

  it('derives the key from an open chat repo_path (claude-workspace layout)', () => {
    expect(projectKeyFromRepoPath('~/claude-workspace/user@example.com/acme/widget')).toBe(
      'acme/widget'
    );
  });

  it('falls back to the flat-clone disk basename when the path is not claude-workspace', () => {
    expect(projectKeyFromRepoPath('/home/me/code/widget')).toBe('name:widget');
  });

  it('falls back to the workspace sentinel for a repo-less chat', () => {
    expect(projectKeyFromRepoPath(undefined)).toBe(WORKSPACE_PROJECT_KEY);
    expect(projectKeyFromRepoPath(null)).toBe(WORKSPACE_PROJECT_KEY);
  });
});

describe('setProjectChatSettings', () => {
  it('writes both the per-project snapshot and the global last-used', () => {
    useChatStore
      .getState()
      .setProjectChatSettings('acme/widget', { agentSetupId: 'best-practice' });

    const s = useChatStore.getState();
    expect(s.settingsByProject['acme/widget'].agentSetupId).toBe('best-practice');
    // The global fallback tracks the most recent pick anywhere.
    expect(s.newChatSettings.agentSetupId).toBe('best-practice');
    // Untouched fields fall back to the resolved base (freestyle defaults).
    expect(s.settingsByProject['acme/widget'].model).toBe(DEFAULT_NEW_CHAT_SETTINGS.model);
  });

  it('keeps per-project snapshots independent', () => {
    useChatStore.getState().setProjectChatSettings('acme/a', { agentSetupId: 'orchestrator' });
    useChatStore.getState().setProjectChatSettings('acme/b', { agentSetupId: 'best-practice' });

    const s = useChatStore.getState();
    expect(s.settingsByProject['acme/a'].agentSetupId).toBe('orchestrator');
    expect(s.settingsByProject['acme/b'].agentSetupId).toBe('best-practice');
  });
});

describe('v1 migration — stale best-practice default → freestyle', () => {
  it('maps a persisted best-practice global default to freestyle on rehydrate', async () => {
    mmkvMock().__store.set(
      CHAT_PERSIST_KEY,
      JSON.stringify({
        state: {
          drafts: {},
          chatSettings: {},
          newChatSettings: {
            model: 'opus',
            permissions: 'bypass_permissions',
            agentSetupId: 'best-practice',
          },
        },
        version: 0,
      })
    );

    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().newChatSettings.agentSetupId).toBe('freestyle');
    // The new per-project map is seeded.
    expect(useChatStore.getState().settingsByProject).toEqual({});
  });

  it('preserves a non-stale persisted agent (a deliberate pick survives)', async () => {
    mmkvMock().__store.set(
      CHAT_PERSIST_KEY,
      JSON.stringify({
        state: {
          drafts: {},
          chatSettings: {},
          newChatSettings: {
            model: 'opus',
            permissions: 'bypass_permissions',
            agentSetupId: 'orchestrator',
          },
        },
        version: 0,
      })
    );

    await useChatStore.persist.rehydrate();

    expect(useChatStore.getState().newChatSettings.agentSetupId).toBe('orchestrator');
  });
});
