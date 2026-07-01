/**
 * project-creation animation overlay.
 *
 * Two layers:
 *
 *   1. Pure `createNewChatFlow` units — the `onStage` progress seam fires the
 *      documented sequence per intent type, and the first message carries the
 *      payload (`new-repo` → `generateProjectCreationPrompt` content +
 *      `customDisplay.displayText` = the user's description + a `messageId`).
 *
 *   2. `ChatComposer` integration (same harness as `chat-composer.test.tsx`) —
 *      the overlay appears on submit, tracks analyzing → framework → resolved
 *      project name (the gateway handlers are GATED on manual promises so each
 *      intermediate state is observable), disappears after navigation (and on
 *      error), never shows for an explicit existing-repo selection, and the
 *      seeded user message survives the backend echo that carries the full
 *      scaffolding prompt (store dedup by messageId).
 */

// Hoisted above imports: route `createSocket()`'s `io()` to the mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The chat barrel transitively imports the block renderers, whose
// TextBlock imports `react-native-markdown-display` (ESM markdown-it). Mock it.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// react-native-mmkv backs the chat store (drafts + new-chat preferences).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, v),
    getString: (k: string) => store.get(k) ?? undefined,
    remove: (k: string) => store.delete(k),
    contains: (k: string) => store.has(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// In-memory keychain for expo-secure-store (sandbox URL + authToken live here).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

// The native NetInfo module must never load under Jest (providers inject stubs).
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));

// ChatComposer embeds VoiceInput, which imports the `expo-audio`
// native module. Replace it with the controllable harness mock.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

// uploadAttachment appends the multipart part via appendFormDataFile, which
// lazy-requires expo-file-system (winter-fetch part) — in-memory mock.
jest.mock('expo-file-system', () =>
  require('../src/test/mockExpoFileSystem').createExpoFileSystemMock()
);

// Controllable library picker (the chat-attachments harness pattern) — used by
// the files-ride-the-first-message scenario. The callbacks read the controller
// lazily, so the hoisted factory is TDZ-safe.
const pickerController = { imageAssets: [] as unknown[], launchCalls: 0 };
jest.mock('expo-image-picker', () => ({
  __esModule: true,
  launchImageLibraryAsync: jest.fn(async () => {
    pickerController.launchCalls += 1;
    return pickerController.imageAssets.length === 0
      ? { canceled: true, assets: null }
      : { canceled: false, assets: pickerController.imageAssets };
  }),
}));

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { generateProjectCreationPrompt } from '@vgit2/shared/projectPrompts';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@vgit2/shared/socket';
import type { ChatMessagePayload } from '@vgit2/shared/socket';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { ChatComposer, HOME_DRAFT_KEY } from '../src/features/chat';
import { useChatMessagesStore } from '../src/features/chat/chatMessagesStore';
import { ProjectCreationOverlay } from '../src/features/chat/ProjectCreationOverlay';
import {
  createNewChatFlow,
  type NewChatFlowDeps,
  type NewChatFlowStage,
} from '../src/features/chat/newChatFlow';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, AppStateStatus } from '../src/features/socket';
import { useChatStore } from '../src/features/state';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway, type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;
const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;
const mmkvStore = (jest.requireMock('react-native-mmkv') as { __store: Map<string, string> })
  .__store;

const SANDBOX_BASE = 'https://sandbox.portable.test';

// This file (unlike chat-attachments/voice) imports `expo-router` (via
// useChatComposer), which pulls Expo's winter runtime — its FormData patch
// assumes the RN polyfill (`this._parts`) while jest-expo's global FormData is
// WHATWG, so `append` with a file part crashes ("reading 'push'"). Install an
// RN-shaped FormData AFTER imports (per-file jest env, no cross-file leak) so
// the upload path behaves like the device.
class RnLikeFormData {
  _parts: Array<[string, unknown]> = [];
  append(key: string, value: unknown): void {
    this._parts.push([key, value]);
  }
  has(key: string): boolean {
    return this._parts.some(([k]) => k === key);
  }
  getAll(key: string): unknown[] {
    return this._parts.filter(([k]) => k === key).map(([, v]) => v);
  }
}
beforeAll(() => {
  (globalThis as { FormData: unknown }).FormData = RnLikeFormData;
});

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

function createAppState(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return { remove: () => (listener = null) };
      },
    },
    emit: (s) => listener?.(s),
  };
}

function buildClient(gateway: MockGateway): RelayApiClient {
  const gwClient = new GatewayClient({ gatewayUrl: gateway.baseUrl, fetchImpl: gateway.fetchImpl });
  return new RelayApiClient({ gateway: gwClient, fetchImpl: gateway.fetchImpl });
}

/** A manually-released gate a mock-gateway handler can await on. */
function createGate(): { release: () => void; wait: Promise<void> } {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { release, wait };
}

const SETTINGS = {
  model: 'sonnet',
  permissions: 'bypass_permissions',
  agentSetupId: 'best-practice',
  effort: 'high',
};

/** Recording deps for the pure-flow tests; intent injected per scenario. */
function buildFlowDeps(partial: Partial<NewChatFlowDeps> = {}): {
  deps: NewChatFlowDeps;
  stages: NewChatFlowStage[];
  sent: ChatMessagePayload[];
} {
  const stages: NewChatFlowStage[] = [];
  const sent: ChatMessagePayload[] = [];
  const deps: NewChatFlowDeps = {
    message: 'make me a blog',
    settings: SETTINGS,
    analyzeIntent: async () => ({ intentType: 'simple-task' }),
    createProject: async () => ({ owner: 'octocat', repo: 'my-cool-app' }),
    createLocalProject: async (folderName) => ({ owner: 'local', repo: folderName }),
    emitCreateChat: async () => ({ success: true }),
    sendMessage: async (payload) => void sent.push(payload),
    makeChatId: () => 'chat-test-1',
    makeMessageId: () => 'msg-test-1',
    onStage: (stage) => stages.push(stage),
    // No-op run-state seams so the pure tests never touch the real store.
    markRunStarted: () => {},
    markRunFailed: () => {},
    ...partial,
  };
  return { deps, stages, sent };
}

describe('createNewChatFlow stages + first message', () => {
  it('new-repo: analyzing → creating-project → starting-chat, prompt content + customDisplay', async () => {
    const { deps, stages, sent } = buildFlowDeps({
      analyzeIntent: async () => ({
        intentType: 'new-repo',
        suggestedName: 'My Cool App',
        suggestedFramework: 'nextjs',
      }),
    });

    await createNewChatFlow(deps);

    expect(stages).toEqual([
      { type: 'analyzing' },
      {
        type: 'creating-project',
        kind: 'new-repo',
        framework: 'nextjs',
        projectName: 'my-cool-app',
      },
      { type: 'starting-chat', owner: 'octocat', repo: 'my-cool-app' },
    ]);

    // Wire content = the full scaffolding prompt; the user sees the description.
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe(
      generateProjectCreationPrompt({
        framework: 'nextjs',
        projectName: 'my-cool-app',
        description: 'make me a blog',
      })
    );
    expect(sent[0].customDisplay).toEqual({
      category: 'plainMessage',
      displayText: 'make me a blog',
    });
    expect(sent[0].messageId).toBe('msg-test-1');
  });

  it('simple-task: creating-project carries kind=simple-task, raw message, no customDisplay', async () => {
    const { deps, stages, sent } = buildFlowDeps({
      analyzeIntent: async () => ({ intentType: 'simple-task', suggestedName: 'quick fix' }),
    });

    await createNewChatFlow(deps);

    // simple-task is a one-off / scratch chat: NO project is created (createLocalProject
    // is no longer called). It targets the reserved workspace scratch (`__workspace__`/`tmp`),
    // so it runs in <workspace>/tmp and groups under the synthetic "Workspace" project.
    expect(stages).toEqual([
      { type: 'analyzing' },
      { type: 'creating-project', kind: 'simple-task', framework: null, projectName: 'quick-fix' },
      { type: 'starting-chat', owner: '__workspace__', repo: 'tmp' },
    ]);
    expect(sent[0].content).toBe('make me a blog');
    expect(sent[0].customDisplay).toBeUndefined();
  });

  it('forced existing-repo: only starting-chat (no analysis, no creation animation stages)', async () => {
    const { deps, stages, sent } = buildFlowDeps({
      forcedIntent: {
        intentType: 'existing-repo',
        useExistingRepo: { owner: 'acme', repo: 'widget' },
      },
    });

    await createNewChatFlow(deps);

    expect(stages).toEqual([{ type: 'starting-chat', owner: 'acme', repo: 'widget' }]);
    expect(sent[0].content).toBe('make me a blog');
    expect(sent[0].customDisplay).toBeUndefined();
  });

  it('auto-detected existing-repo: analyzing → starting-chat (no creating-project stage)', async () => {
    const { deps, stages } = buildFlowDeps({
      analyzeIntent: async () => ({
        intentType: 'existing-repo',
        useExistingRepo: { owner: 'acme', repo: 'widget' },
      }),
    });

    await createNewChatFlow(deps);

    expect(stages).toEqual([
      { type: 'analyzing' },
      { type: 'starting-chat', owner: 'acme', repo: 'widget' },
    ]);
  });

  it('the prompt uses the CREATED repo name while the stage carries the folder slug', async () => {
    // The backend dedupes name collisions (my-cool-app → my-cool-app-1): the
    // stage shows the pre-creation slug, the prompt must use the server's name.
    const { deps, stages, sent } = buildFlowDeps({
      analyzeIntent: async () => ({
        intentType: 'new-repo',
        suggestedName: 'My Cool App',
        suggestedFramework: 'nextjs',
      }),
      createProject: async () => ({ owner: 'octocat', repo: 'my-cool-app-1' }),
    });

    await createNewChatFlow(deps);

    expect(stages[1]).toMatchObject({ type: 'creating-project', projectName: 'my-cool-app' });
    expect(stages[2]).toEqual({ type: 'starting-chat', owner: 'octocat', repo: 'my-cool-app-1' });
    expect(sent[0].content).toBe(
      generateProjectCreationPrompt({
        framework: 'nextjs',
        projectName: 'my-cool-app-1',
        description: 'make me a blog',
      })
    );
  });

  it('rejects when chat:create acks success:false — the first message is never sent', async () => {
    const { deps, sent } = buildFlowDeps({
      emitCreateChat: async () => ({ success: false, error: 'create rejected' }),
    });

    await expect(createNewChatFlow(deps)).rejects.toThrow('create rejected');
    expect(sent).toHaveLength(0);
  });

  it('rejects when the first message acks success:false and rolls the optimistic run back', async () => {
    const markRunFailed = jest.fn();
    const { deps } = buildFlowDeps({
      sendMessage: async () => ({ success: false, error: 'prepare failed' }),
      markRunFailed,
    });

    await expect(createNewChatFlow(deps)).rejects.toThrow('prepare failed');
    expect(markRunFailed).toHaveBeenCalledWith('chat-test-1');
  });

  it('threads uploaded files into the first message payload', async () => {
    const files = [
      {
        fileName: 'srv-1.jpg',
        originalName: 'photo-1.jpg',
        path: 'uploads/srv-1.jpg',
        absolutePath: '/workspace/uploads/srv-1.jpg',
        mimeType: 'image/jpeg',
        size: 1234,
      },
    ];
    const { deps, sent } = buildFlowDeps({ files });

    await createNewChatFlow(deps);

    expect(sent[0].files).toEqual(files);
  });
});

describe('ProjectCreationOverlay in the home composer', () => {
  let gateway: MockGateway;
  let qc: QueryClient;
  const navigate = jest.fn();

  beforeEach(() => {
    act(() => {
      useChatStore.setState({
        drafts: {},
        newChatSettings: { ...SETTINGS },
      });
      useSocketStore.getState().reset();
      useChatMessagesStore.getState().reset();
    });
    controller.reset();
    navigate.mockClear();
    pickerController.imageAssets = [];
    pickerController.launchCalls = 0;
    secureStore.clear();
    mmkvStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'authtoken-abc');

    gateway = createMockGateway();
    gateway.on('GET', `${SANDBOX_BASE}/api/agent-setups`, () => ({
      body: { agentSetups: [{ id: 'best-practice', name: 'Best Practice' }] },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, () => ({
      body: {
        intentType: 'new-repo',
        suggestedName: 'My Cool App',
        suggestedFramework: 'nextjs',
      },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/projects/create`, () => ({
      body: { owner: 'octocat', repoName: 'my-cool-app', repoPath: '~/x' },
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/projects/recent?limit=10`, () => ({
      body: { projects: [{ name: 'widget', path: '/w/widget', owner: 'acme' }] },
    }));

    qc = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    qc.clear();
    onlineManager.setOnline(true);
    act(() => {
      useSocketStore.getState().reset();
      useChatMessagesStore.getState().reset();
    });
    controller.reset();
  });

  async function mount(): Promise<void> {
    const client = buildClient(gateway);
    const appCtl = createAppState();
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ApiProvider client={client} queryClient={qc} netInfo={onlineNetInfo}>
          <SocketProvider
            getAuthToken={async () => 'authtoken-abc'}
            getRelayUrl={async () => SANDBOX_BASE}
            appState={appCtl.appState}
            netInfo={onlineNetInfo}
          >
            <ChatComposer
              navigate={navigate}
              makeChatId={() => 'chat-test-1'}
              makeMessageId={() => 'msg-test-1'}
              debounceMs={20}
            />
          </SocketProvider>
        </ApiProvider>
      </SafeAreaProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flushFlow(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('tracks analyzing → framework → project name, then hides after navigation', async () => {
    // Gate the two creation calls so each intermediate overlay state is observable.
    const intentGate = createGate();
    const createGate2 = createGate();
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, async () => {
      await intentGate.wait;
      return {
        body: {
          intentType: 'new-repo',
          suggestedName: 'My Cool App',
          suggestedFramework: 'nextjs',
        },
      };
    });
    gateway.on('POST', `${SANDBOX_BASE}/api/projects/create`, async () => {
      await createGate2.wait;
      return { body: { owner: 'octocat', repoName: 'my-cool-app', repoPath: '~/x' } };
    });

    await mount();
    // Opt into Auto detect (the Home default is a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));

    // Analyzing: overlay up, "Navigating" / "Workspace" (an auto-detect home-widget
    // message starts as workspace routing), spinning whale; no resolved name yet.
    expect(screen.getByTestId('project-creation-overlay')).toBeTruthy();
    expect(screen.getByTestId('project-creation-status')).toHaveTextContent(/Navigating/);
    expect(screen.getByTestId('project-creation-framework')).toHaveTextContent(/Workspace/);
    expect(screen.getByTestId('project-creation-whale')).toBeTruthy();
    expect(screen.queryByTestId('project-creation-name')).toBeNull();

    // Intent resolved to a NEW repo → headline flips to "Creating", the framework line
    // shows Next.js (catalog label + favicon), and the resolved name slides in.
    await act(async () => {
      intentGate.release();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() =>
      expect(screen.getByTestId('project-creation-status')).toHaveTextContent(/Creating/)
    );
    await waitFor(() =>
      expect(screen.getByTestId('project-creation-framework')).toHaveTextContent(/Next\.js/)
    );
    expect(screen.getByTestId('project-creation-framework-icon')).toBeTruthy();
    expect(screen.getByTestId('project-creation-name')).toHaveTextContent(/my-cool-app/);

    // Repo created → flow finishes: navigated to the chat and the overlay is gone.
    await act(async () => {
      createGate2.release();
    });
    await flushFlow();
    expect(navigate).toHaveBeenCalledWith('chat-test-1');
    expect(screen.queryByTestId('project-creation-overlay')).toBeNull();
  });

  it('seeds the user-visible description and dedupes the full-prompt backend echo', async () => {
    await mount();
    // Opt into Auto detect (the Home default is a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    await flushFlow();

    // The wire message carried the scaffolding prompt + messageId…
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect(msgEmits).toHaveLength(1);
    const payload = msgEmits[0].args[0] as ChatMessagePayload;
    const fullPrompt = generateProjectCreationPrompt({
      framework: 'nextjs',
      projectName: 'my-cool-app',
      description: 'make me a blog',
    });
    expect(payload.messageId).toBe('msg-test-1');
    expect(payload.content).toBe(fullPrompt);

    // …but the store shows only the user's description.
    const messages = useChatMessagesStore.getState().getMessages('chat-test-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'msg-test-1',
      role: 'user',
      content: 'make me a blog',
    });

    // The backend echo carries the FULL prompt under the same id — the store
    // dedup (non-optimistic, same id) must skip it, keeping the description.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.USER_MESSAGE, {
        chatId: 'chat-test-1',
        id: 'msg-test-1',
        content: fullPrompt,
        timestamp: Date.now(),
      });
    });
    const after = useChatMessagesStore.getState().getMessages('chat-test-1');
    expect(after).toHaveLength(1);
    expect(after[0].content).toBe('make me a blog');

    // Control: a DIFFERENT-id echo appends — proves the live user_message
    // handler is bound (the same-id skip above is falsifiable, not vacuous).
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.USER_MESSAGE, {
        chatId: 'chat-test-1',
        id: 'msg-other',
        content: 'hello',
        timestamp: Date.now(),
      });
    });
    const withControl = useChatMessagesStore.getState().getMessages('chat-test-1');
    expect(withControl).toHaveLength(2);
    expect(withControl[1].content).toBe('hello');
  });

  it('hides the overlay and surfaces the composer error when creation fails', async () => {
    gateway.on('POST', `${SANDBOX_BASE}/api/projects/create`, () => ({
      status: 500,
      body: { error: 'boom' },
    }));

    await mount();
    // Opt into Auto detect (the Home default is a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    expect(screen.getByTestId('project-creation-overlay')).toBeTruthy();

    await flushFlow();
    // Pin the surfaced error to the project-creation 500 (not a generic failure).
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-error')).toHaveTextContent(/boom/)
    );
    expect(
      gateway.requests.some(
        (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/projects/create`
      )
    ).toBe(true);
    expect(screen.queryByTestId('project-creation-overlay')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('dismisses the overlay when auto-detect resolves to an existing repo', async () => {
    const intentGate = createGate();
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, async () => {
      await intentGate.wait;
      return {
        body: { intentType: 'existing-repo', useExistingRepo: { owner: 'acme', repo: 'widget' } },
      };
    });

    await mount();
    // Opt into Auto detect (the Home default is a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'fix the login bug in widget');
    fireEvent.press(screen.getByTestId('chat-composer-send'));

    // Visible during analysis (intent unknown yet)…
    expect(screen.getByTestId('project-creation-overlay')).toBeTruthy();

    // …but dismissed as soon as the intent resolves to an existing repo — no
    // repo is created, so no "Creating <repo>" surface.
    await act(async () => {
      intentGate.release();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.queryByTestId('project-creation-overlay')).toBeNull());

    await flushFlow();
    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits).toHaveLength(1);
    expect(createEmits[0].args[0]).toMatchObject({ owner: 'acme', repo: 'widget' });
    expect(navigate).toHaveBeenCalledWith('chat-test-1');
  });

  it('surfaces a chat:create rejection — no first message, no navigation, no ghost', async () => {
    controller.setAck(CLIENT_EVENTS.CHAT_CREATE, { success: false, error: 'create rejected' });

    await mount();
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    await flushFlow();

    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-error')).toHaveTextContent(/create rejected/)
    );
    expect(controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE)).toHaveLength(
      0
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(useChatMessagesStore.getState().getMessages('chat-test-1')).toHaveLength(0);
  });

  it('rolls back the seed and the optimistic run when the first message is rejected', async () => {
    controller.setAck(CLIENT_EVENTS.CHAT_MESSAGE, { success: false, error: 'prepare failed' });

    await mount();
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    await flushFlow();

    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-error')).toHaveTextContent(/prepare failed/)
    );
    expect(navigate).not.toHaveBeenCalled();
    const store = useChatMessagesStore.getState();
    // Seeded ghost removed AND the optimistic run-start rolled back — opening
    // this chat from the directory later shows it idle, not "running".
    expect(store.getMessages('chat-test-1')).toHaveLength(0);
    expect(store.statuses['chat-test-1']).toBe('completed');
    // The typed text survives a failed submit (only success clears it).
    expect(screen.getByTestId('chat-composer-input').props.value).toBe('make me a blog');
  });

  it('keystrokes typed while the submit is in flight survive the success-path clear', async () => {
    const gate = createGate();
    gateway.on('POST', `${SANDBOX_BASE}/api/projects/create`, async () => {
      await gate.wait;
      return { body: { owner: 'octocat', repoName: 'my-cool-app', repoPath: '~/x' } };
    });

    await mount();
    // Opt into Auto detect (the Home default is a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));

    // Type MORE while the flow awaits the gated project creation.
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog and a pony');

    await act(async () => {
      gate.release();
    });
    await flushFlow();

    expect(navigate).toHaveBeenCalledWith('chat-test-1');
    // The newer keystrokes survive the clear — in the input AND the draft store.
    expect(screen.getByTestId('chat-composer-input').props.value).toBe('make me a blog and a pony');
    await waitFor(() =>
      expect(useChatStore.getState().drafts[HOME_DRAFT_KEY]).toBe('make me a blog and a pony')
    );
    // The sent message is still the text submitted at press time.
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect((msgEmits[0].args[0] as ChatMessagePayload).customDisplay).toEqual({
      category: 'plainMessage',
      displayText: 'make me a blog',
    });
  });

  it('attachments ride the first message as files and the bar clears on success', async () => {
    pickerController.imageAssets = [
      {
        uri: 'file:///photo-1.jpg',
        fileName: 'photo-1.jpg',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        fileSize: 1024 * 1024, // < 5 MB → no compression path
      },
    ];
    gateway.on('POST', `${SANDBOX_BASE}/api/upload`, () => ({
      body: {
        fileName: 'srv-1.jpg',
        originalName: 'photo-1.jpg',
        path: 'uploads/srv-1.jpg',
        absolutePath: '/workspace/uploads/srv-1.jpg',
        mimeType: 'image/jpeg',
        size: 1234,
      },
    }));

    await mount();

    // Attach from the library via the inline "+" → source sheet.
    // Capture onDismiss before pressing: once the sheet closes (visible=false) the
    // Modal leaves the RNTL tree, so the callback must be grabbed while it is open.
    fireEvent.press(screen.getByTestId('attach-button'));
    const onDismissAttach = screen.getByTestId('attach-source-sheet').props.onDismiss;
    await act(async () => {
      fireEvent.press(screen.getByTestId('attach-source-library'));
    });
    // Trigger onDismiss to fire the deferred picker launch.
    await act(async () => {
      await onDismissAttach?.();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByTestId(/^attachment-item-/)).toBeTruthy());
    // Wait for the upload to FINISH (the uploading overlay clears) — only
    // `done` attachments ride the message.
    await waitFor(() => expect(screen.queryByTestId(/^attachment-uploading-/)).toBeNull());
    expect(gateway.requests.map((r) => `${r.method} ${r.url}`)).toContain(
      `POST ${SANDBOX_BASE}/api/upload`
    );
    expect(screen.queryByTestId(/^attachment-error-/)).toBeNull();

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    await flushFlow();

    // The upload response rides the first message as `files`.
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect(msgEmits).toHaveLength(1);
    expect((msgEmits[0].args[0] as ChatMessagePayload).files).toEqual([
      {
        fileName: 'srv-1.jpg',
        originalName: 'photo-1.jpg',
        path: 'uploads/srv-1.jpg',
        absolutePath: '/workspace/uploads/srv-1.jpg',
        mimeType: 'image/jpeg',
        size: 1234,
      },
    ]);
    expect(navigate).toHaveBeenCalledWith('chat-test-1');

    // The attachment strip cleared after the successful submit.
    await waitFor(() => expect(screen.queryByTestId(/^attachment-item-/)).toBeNull());
  });

  it('renders the task fallback label and the resolved name (direct render, kind=task)', () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ProjectCreationOverlay
          status={{ phase: 'creating', kind: 'task', framework: null, projectName: 'quick-fix' }}
          nameRevealDelayMs={0}
        />
      </SafeAreaProvider>
    );
    expect(screen.getByTestId('project-creation-framework')).toHaveTextContent(/task/);
    // No framework → no favicon.
    expect(screen.queryByTestId('project-creation-framework-icon')).toBeNull();
    expect(screen.getByTestId('project-creation-name')).toHaveTextContent(/quick-fix/);
    expect(screen.getByTestId('project-creation-whale')).toBeTruthy();
  });

  it('reads "Navigating Workspace" for a one-off (direct render, kind=workspace)', () => {
    render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ProjectCreationOverlay
          status={{ phase: 'creating', kind: 'workspace', framework: null, projectName: null }}
          nameRevealDelayMs={0}
        />
      </SafeAreaProvider>
    );
    // A workspace one-off creates no project → "Navigating" / "Workspace", no name slide.
    expect(screen.getByTestId('project-creation-status')).toHaveTextContent(/Navigating/);
    expect(screen.getByTestId('project-creation-framework')).toHaveTextContent(/Workspace/);
    expect(screen.queryByTestId('project-creation-name')).toBeNull();
    expect(screen.queryByTestId('project-creation-framework-icon')).toBeNull();
  });

  it('seeds the new chat with its own settings snapshot so the permission never reverts (issue #4)', async () => {
    // The home composer's chosen permission is NOT the default — a fresh
    // chat must open showing THIS value, not fall back to `bypass_permissions`.
    act(() => {
      useChatStore.setState({ newChatSettings: { ...SETTINGS, permissions: 'plan' } });
    });

    await mount();
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    fireEvent.press(screen.getByTestId('chat-composer-send'));
    await flushFlow();

    expect(navigate).toHaveBeenCalledWith('chat-test-1');
    // The chat now owns a local settings snapshot of its own — independent of
    // the project's sticky "last mode selected there", which can be overwritten
    // later by a DIFFERENT chat in the same project.
    expect(useChatStore.getState().chatSettings['chat-test-1']).toMatchObject({
      permissions: 'plan',
    });
  });

  it('shows no creation overlay for an explicit existing-repo selection', async () => {
    await mount();

    // Pick the recent project from the project sheet.
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    await waitFor(() => expect(screen.getByTestId('project-option-/w/widget')).toBeTruthy());
    fireEvent.press(screen.getByTestId('project-option-/w/widget'));

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'fix the login bug');
    fireEvent.press(screen.getByTestId('chat-composer-send'));

    // No overlay at any point in the existing-repo path.
    expect(screen.queryByTestId('project-creation-overlay')).toBeNull();
    await flushFlow();
    expect(screen.queryByTestId('project-creation-overlay')).toBeNull();

    // Direct chat creation against the chosen repo, raw message content.
    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits).toHaveLength(1);
    expect(createEmits[0].args[0]).toMatchObject({ owner: 'acme', repo: 'widget' });
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect(msgEmits[0].args[0]).toMatchObject({ content: 'fix the login bug' });
    expect(navigate).toHaveBeenCalledWith('chat-test-1');
  });
});
