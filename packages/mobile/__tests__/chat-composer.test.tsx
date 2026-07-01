/**
 * Chat input (text, model/permissions/agentSetup selectors).
 *
 * Mounts the native `ChatComposer` inside the authed TanStack Query layer
 * (`createMockGateway`) AND the RN Socket.IO provider (virtual `socket.io-client`
 * mock), with an in-memory SecureStore + MMKV. Verifies (per the story's AC):
 *
 *   1. the model / permissions / agentSetup bottom sheets update the (MMKV-backed)
 *      new-chat settings;
 *   2. debounced draft text persists to MMKV via `chatStore.drafts`;
 *   3. submitting fires the `createNewChat` / `chat:create` flow carrying the intent
 *      analysis result, the chosen model + permissions + agentSetup, AND the
 *      framework (a `new-repo` intent → `POST /api/projects/create` with the
 *      framework) — then sends the first message and navigates to the new chat.
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

// ChatComposer embeds VoiceInput, which lazy-`require`s `expo-speech-recognition`
// (native on-device STT) when the mic is tapped. Stub it so the recording flow runs.
jest.mock('expo-speech-recognition', () =>
  require('../src/test/nativeMocks').speechRecognitionMockFactory()
);

import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { generateProjectCreationPrompt } from '@vgit2/shared/projectPrompts';
import { CLIENT_EVENTS } from '@vgit2/shared/socket';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient, type NetInfoLike } from '../src/features/api/queryClient';
import { RelayApiClient } from '../src/features/api/relayClient';
import { AUTH_TOKEN_KEY } from '../src/features/auth/secureAuthStore';
import { ChatComposer, HOME_DRAFT_KEY } from '../src/features/chat';
import { RELAY_URL_KEY } from '../src/features/api/relayUrlStore';
import { SocketProvider, useSocketStore } from '../src/features/socket';
import type { AppStateLike, AppStateStatus } from '../src/features/socket';
import { useChatStore } from '../src/features/state';
import { useOfflineQueueStore } from '../src/features/state/offlineQueueStore';
import { useChatMessagesStore } from '../src/features/chat/chatMessagesStore';
import { GatewayClient } from '../src/services/gatewayClient';
import { createMockGateway, type MockGateway, type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;
const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> })
  .__store;
const mmkvStore = (jest.requireMock('react-native-mmkv') as { __store: Map<string, string> })
  .__store;

const SANDBOX_BASE = 'https://sandbox.portable.test';

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Always-online NetInfo (connectivity isn't under test here). */
const onlineNetInfo: NetInfoLike = { addEventListener: () => () => {} };

/** Inert AppState (no transitions needed). */
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

describe('chat input (selectors, draft, create-chat flow)', () => {
  let gateway: MockGateway;
  let qc: QueryClient;
  const navigate = jest.fn();

  beforeEach(() => {
    // Reset stores + mocks for isolation.
    act(() => {
      useChatStore.setState({
        drafts: {},
        newChatSettings: {
          model: 'sonnet',
          permissions: 'bypass_permissions',
          agentSetupId: 'best-practice',
          effort: 'high',
        },
      });
      useSocketStore.getState().reset();
      useOfflineQueueStore.getState().clear();
      useChatMessagesStore.getState().reset();
    });
    controller.reset();
    navigate.mockClear();
    secureStore.clear();
    mmkvStore.clear();
    secureStore.set(RELAY_URL_KEY, SANDBOX_BASE);
    secureStore.set(AUTH_TOKEN_KEY, 'authtoken-abc');

    gateway = createMockGateway();
    // Sandbox endpoints registered by FULL URL (the client targets the sandbox base,
    // which differs from the gateway base, so the path is the absolute URL).
    gateway.on('GET', `${SANDBOX_BASE}/api/agent-setups`, () => ({
      body: {
        agentSetups: [
          { id: 'best-practice', name: 'Best Practice' },
          { id: 'freestyle', name: 'Freestyle' },
        ],
      },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, () => ({
      body: {
        reasoning: 'wants a fresh app',
        intentType: 'new-repo',
        suggestedName: 'My Cool App',
        suggestedFramework: 'nextjs',
        confidence: 0.92,
      },
    }));
    gateway.on('POST', `${SANDBOX_BASE}/api/projects/create`, () => ({
      body: { owner: 'octocat', repoName: 'my-cool-app', repoPath: '~/x' },
    }));
    gateway.on('GET', `${SANDBOX_BASE}/api/projects/recent?limit=10`, () => ({
      body: { projects: [] },
    }));

    qc = createQueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    qc.clear();
    onlineManager.setOnline(true);
    act(() => useSocketStore.getState().reset());
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
            <ChatComposer navigate={navigate} makeChatId={() => 'chat-test-1'} debounceMs={20} />
          </SocketProvider>
        </ApiProvider>
      </SafeAreaProvider>
    );
    // Flush the async socket-creation effect (resolves token + URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Bring the socket up so the create-chat emit has a live transport.
    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('updates model/permissions/agentSetup via bottom sheets', async () => {
    await mount();

    // Focus the input to expand the card (the control row — model /
    // permissions / agent / auto-pilot — is hidden while collapsed).
    fireEvent(screen.getByTestId('chat-composer-input'), 'focus');

    // Model sheet → pick Haiku.
    fireEvent.press(screen.getByTestId('open-model-sheet'));
    expect(screen.getByTestId('model-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('model-option-haiku'));
    expect(useChatStore.getState().newChatSettings.model).toBe('haiku');

    // Permissions sheet → pick Plan.
    fireEvent.press(screen.getByTestId('open-permissions-sheet'));
    fireEvent.press(screen.getByTestId('permissions-option-plan'));
    expect(useChatStore.getState().newChatSettings.permissions).toBe('plan');

    // Agent sheet → pick the server-provided Freestyle setup.
    fireEvent.press(screen.getByTestId('open-agent-sheet'));
    await waitFor(() => expect(screen.getByTestId('agent-option-freestyle')).toBeTruthy());
    fireEvent.press(screen.getByTestId('agent-option-freestyle'));
    expect(useChatStore.getState().newChatSettings.agentSetupId).toBe('freestyle');
  });

  it('shows a default-permissions button beside "Auto detect" that sets the new-chat default without expanding the composer', async () => {
    await mount();

    // Visible BEFORE the input is ever focused/expanded — unlike the control-row
    // permissions button (which only reveals once the card expands), this one
    // labels the current default at a glance (issue #5, ac).
    expect(screen.getByTestId('composer-permissions-trigger')).toBeTruthy();
    expect(screen.getByText('Bypass')).toBeTruthy();

    // Tapping it opens the SAME permissions sheet the (hidden) control-row button
    // opens — one picker, two entry points.
    fireEvent.press(screen.getByTestId('composer-permissions-trigger'));
    expect(screen.getByTestId('permissions-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('permissions-option-plan'));

    // The GLOBAL new-chat default updates (every future new chat inherits it),
    // and the button's label reflects the new default immediately.
    expect(useChatStore.getState().newChatSettings.permissions).toBe('plan');
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('hides the text input while the voice surface is active', async () => {
    await mount();
    expect(screen.getByTestId('chat-composer-input')).toBeTruthy();

    // Start recording → the TextInput hides so the live-text + controls column
    // (text on top, cancel/waveform/stop below) spans the whole input card. The empty
    // trailing slot is now the shared InputActionButton in voice mode (`chat-composer-voice`).
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-voice'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('chat-composer-input')).toBeNull();
    expect(screen.getByTestId('voice-input-recording')).toBeTruthy();
    expect(screen.getByTestId('voice-live-panel')).toBeTruthy();

    // Cancel → recording discarded, the TextInput returns with no inserted text.
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-cancel'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('voice-input-recording')).toBeNull();
    expect(screen.getByTestId('chat-composer-input').props.value).toBeFalsy();
  });

  it('holding the send button transforms it to a voice button (and back)', async () => {
    await mount();

    // Type → the trailing button is Send (default), with a small mic badge hinting the hold.
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'hello');
    expect(screen.getByTestId('chat-composer-send')).toBeTruthy();
    expect(screen.getByTestId('chat-composer-send-badge')).toBeTruthy();

    // Long-press → transforms into a Voice button (mic primary).
    fireEvent(screen.getByTestId('chat-composer-send'), 'longPress');
    expect(screen.getByTestId('chat-composer-voice')).toBeTruthy();
    expect(screen.queryByTestId('chat-composer-send')).toBeNull();

    // Long-press again transforms back to Send.
    fireEvent(screen.getByTestId('chat-composer-voice'), 'longPress');
    expect(screen.getByTestId('chat-composer-send')).toBeTruthy();
  });

  it('voice is transient: after a dictation appends, the button auto-reverts to send', async () => {
    const speech = jest.requireMock('expo-speech-recognition').ExpoSpeechRecognitionModule as {
      __emitResult: (t: string, f: boolean) => void;
    };
    await mount();

    // Type, then hold to switch the trailing button to Voice.
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'hello');
    fireEvent(screen.getByTestId('chat-composer-send'), 'longPress');
    expect(screen.getByTestId('chat-composer-voice')).toBeTruthy();

    // Tap Voice → start recording (the field hides; the recording surface shows).
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-voice'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('voice-input-recording')).toBeTruthy();

    // Speak, then stop → the transcript appends AND the button auto-reverts to Send.
    act(() => speech.__emitResult('world', true));
    await act(async () => {
      fireEvent.press(screen.getByTestId('voice-input-stop'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('chat-composer-input').props.value).toBe('hello world');
    expect(screen.getByTestId('chat-composer-send')).toBeTruthy();
    expect(screen.queryByTestId('chat-composer-voice')).toBeNull();
  });

  it('persists the draft to MMKV (debounced)', async () => {
    await mount();

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'build me a todo app');

    // Debounced write lands in the chat store (MMKV-backed).
    await waitFor(() =>
      expect(useChatStore.getState().drafts[HOME_DRAFT_KEY]).toBe('build me a todo app')
    );
    // And it reached the MMKV backing store under the chat-store persist key.
    await waitFor(() => {
      const raw = mmkvStore.get('portable.chat');
      expect(raw && JSON.parse(raw).state.drafts[HOME_DRAFT_KEY]).toBe('build me a todo app');
    });
  });

  it('selecting "Auto detect" fires the chat:create flow carrying intent, model, permissions, framework, agentSetup', async () => {
    await mount();

    // Opt into Auto detect (the Home DEFAULT is now a general workspace chat).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));

    // Focus to expand the card (the control row is collapsed until focus/typing).
    fireEvent(screen.getByTestId('chat-composer-input'), 'focus');

    // Choose non-default model + permissions + agent.
    fireEvent.press(screen.getByTestId('open-model-sheet'));
    fireEvent.press(screen.getByTestId('model-option-haiku'));
    fireEvent.press(screen.getByTestId('open-permissions-sheet'));
    fireEvent.press(screen.getByTestId('permissions-option-plan'));
    fireEvent.press(screen.getByTestId('open-agent-sheet'));
    await waitFor(() => expect(screen.getByTestId('agent-option-freestyle')).toBeTruthy());
    fireEvent.press(screen.getByTestId('agent-option-freestyle'));

    // Compose + submit.
    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-send'));
      // Let the intent → project-create → emit → sendMessage chain resolve.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Intent analysis was requested.
    const intentReq = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/chats/analyze-intent`
    );
    expect(intentReq?.body).toMatchObject({ message: 'make me a blog' });

    // The new-repo intent created a project carrying the framework.
    const projectReq = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/projects/create`
    );
    expect(projectReq?.body).toMatchObject({ framework: 'nextjs' });

    // chat:create emitted with the chosen settings + the resolved repo.
    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits).toHaveLength(1);
    expect(createEmits[0].args[0]).toMatchObject({
      chatId: 'chat-test-1',
      type: 'claude_code',
      title: 'make me a blog',
      owner: 'octocat',
      repo: 'my-cool-app',
      model: 'haiku',
      permissions: 'plan',
      agentSetupId: 'freestyle',
    });

    // First message sent on the new chat — a `new-repo` intent sends the full
    // project-creation prompt as the wire content, with the user's description
    // riding `customDisplay`.
    const msgEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MESSAGE);
    expect(msgEmits).toHaveLength(1);
    expect(msgEmits[0].args[0]).toMatchObject({
      chatId: 'chat-test-1',
      content: generateProjectCreationPrompt({
        framework: 'nextjs',
        projectName: 'my-cool-app',
        description: 'make me a blog',
      }),
      customDisplay: { category: 'plainMessage', displayText: 'make me a blog' },
    });

    // Navigated to the new chat + the home draft cleared.
    expect(navigate).toHaveBeenCalledWith('chat-test-1');
    expect(useChatStore.getState().drafts[HOME_DRAFT_KEY]).toBeUndefined();
  });

  it('selecting "New project" + a framework bypasses intent analysis and forces a new repo', async () => {
    await mount();

    // Open the project dropdown and choose "New project".
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    expect(screen.getByTestId('project-sheet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('project-option-new-project'));

    // The framework pills now appear; pick Vite.
    await waitFor(() => expect(screen.getByTestId('framework-pill-vite')).toBeTruthy());
    fireEvent.press(screen.getByTestId('framework-pill-vite'));

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a landing page');
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-send'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // Intent analysis was NOT called (explicit selection bypasses it).
    expect(
      gateway.requests.find(
        (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/chats/analyze-intent`
      )
    ).toBeUndefined();

    // The project was created with the explicitly-chosen framework.
    const projectReq = gateway.requests.find(
      (r) => r.method === 'POST' && r.url === `${SANDBOX_BASE}/api/projects/create`
    );
    expect(projectReq?.body).toMatchObject({ framework: 'vite' });

    // chat:create emitted against the created repo; navigated to the new chat.
    const createEmits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_CREATE);
    expect(createEmits).toHaveLength(1);
    expect(createEmits[0].args[0]).toMatchObject({ owner: 'octocat', repo: 'my-cool-app' });
    expect(navigate).toHaveBeenCalledWith('chat-test-1');

    // Selection reset back to auto-detect after submit (framework pills gone).
    expect(screen.queryByTestId('framework-pill-vite')).toBeNull();
  });

  it('flushes the repos + recent-projects caches after creating a new repo', async () => {
    await mount();

    // Opt into Auto detect so the new-repo intent runs (the Home default is workspace).
    fireEvent.press(screen.getByTestId('composer-project-trigger'));
    fireEvent.press(screen.getByTestId('project-option-auto-detect'));

    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'make me a blog');
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-send'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // The new-repo create flushed BOTH the repos LIST and the recent-projects
    // dropdown caches (prefix/fuzzy match) so the freshly-created repo appears in
    // the Repos tab + the project dropdown without an app restart — the bug
    // was that the stale in-memory query cache hid it, so the tester thought
    // creation had failed even though the repo existed.
    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['repos']);
    expect(invalidatedKeys).toContainEqual(['recent-projects']);
  });

  it('preserves the first message in the offline queue when the socket drops mid-tunnel-rotation', async () => {
    // Target an EXISTING repo (no project create) so the flow is purely
    // chat:create → chat:message.
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, () => ({
      body: { intentType: 'existing-repo', useExistingRepo: { owner: 'octocat', repo: 'hello' } },
    }));
    await mount();
    // Simulate a tunnel changeover dropping the socket AFTER it was up (chat:create
    // still "acks" against the mock, but the connection state reports DOWN — so the
    // first message would never reach the PC and must be preserved, not lost).
    act(() => {
      controller.setConnected(false);
    });

    fireEvent.changeText(
      screen.getByTestId('chat-composer-input'),
      'a long and important prompt I do not want to lose'
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-send'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // The chat WAS created — so we navigate into it…
    expect(navigate).toHaveBeenCalledWith('chat-test-1');

    // …and the first message is PRESERVED in the persisted offline queue (NOT lost),
    // ready for ActiveChatScreen's useOfflineMessageQueue to flush on reconnect.
    const queue = useOfflineQueueStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      chatId: 'chat-test-1',
      content: 'a long and important prompt I do not want to lose',
    });

    // The optimistic user bubble is KEPT (the reconnect flush reuses the same id, so
    // the backend echo dedups it — never unseeded the way a genuine rejection is).
    const messages = useChatMessagesStore.getState().getMessages('chat-test-1');
    expect(messages.some((m) => m.id === queue[0].id && m.role === 'user')).toBe(true);
  });

  it('does NOT flush the repos cache for an existing-repo intent', async () => {
    // Re-point intent analysis at an EXISTING repo: no project is created, so there
    // is nothing new to surface and the repos cache must be left untouched.
    gateway.on('POST', `${SANDBOX_BASE}/api/chats/analyze-intent`, () => ({
      body: { intentType: 'existing-repo', useExistingRepo: { owner: 'octocat', repo: 'hello' } },
    }));
    await mount();

    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');

    fireEvent.changeText(screen.getByTestId('chat-composer-input'), 'fix the bug in hello');
    await act(async () => {
      fireEvent.press(screen.getByTestId('chat-composer-send'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).not.toContainEqual(['repos']);
    expect(invalidatedKeys).not.toContainEqual(['recent-projects']);
  });
});
