/**
 * Permissions, secrets, ask-user & connection-request flows.
 *
 * Drives the native Socket.IO provider with a mocked Socket.IO server and asserts
 * the four interactive prompts end-to-end:
 *   1. `tool_permission_required` retroactively flags a streamed tool block →
 *      the native permission UI renders → approve emits `permission:respond`.
 *   2. `ask_user_question` renders the native question prompt → answering invokes
 *      the `answer_user_question` callback (fire-and-forget) + clears the prompt.
 *   3. A secrets form emits `secrets:submit` and resolves on the `secrets:submitted`
 *      confirmation (the form flips to the submitted state).
 *   4. A connection-request block enters the connection flow (`startConnection`).
 */

// Route `createSocket()`'s `io()` to the recording mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel transitively imports the MMKV-backed offline queue store.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (key: string, value: string | number | boolean) => store.set(key, String(value)),
    getString: (key: string) => (store.has(key) ? store.get(key) : undefined),
    remove: (key: string) => store.delete(key),
    contains: (key: string) => store.has(key),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance };
});

// The block renderer imports `react-native-markdown-display` (ESM markdown-it).
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// The chat barrel transitively imports ChatComposer → VoiceInput → `expo-audio`.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

// The socket provider chain reads the auth token + sandbox URL from SecureStore.
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { useRef } from 'react';
import { FlatList, Keyboard } from 'react-native';

import { CLIENT_EVENTS, SERVER_EVENTS } from '@vgit2/shared/socket';
import type { ClaudeStreamBlock } from '@vgit2/shared/socket';

import {
  ActiveChatInteractions,
  ChatInteractionProvider,
  MessageList,
  useChatMessagesStore,
  useChatStream,
  useInteractionStore,
  type MeasureNode,
  type MessageListHandle,
} from '../src/features/chat';
import { ConnectionRequestBlock, SecretsBlock } from '../src/features/chat/blocks';
import { SocketProvider, useSocket, useSocketStore } from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

const CHAT_ID = 'chat-1';

function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
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

function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => (listener = null);
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

const secretsBlock: ClaudeStreamBlock = {
  type: 'tool_use',
  id: 'secrets-1',
  toolName: 'request_user_secrets',
  toolInput: {
    file_path: '/workspace/.env',
    secrets: [{ key: 'OPENAI_API_KEY', description: 'OpenAI key' }],
  },
};

const connectionBlock: ClaudeStreamBlock = {
  type: 'tool_use',
  id: 'conn-1',
  toolName: 'mcp__run-connection__request_user_connection',
  toolInput: { service: 'slack', reason: 'Need Slack', required: true },
};

const onStartConnection = jest.fn();

/**
 * Deterministic measurement stub for the scroll-into-view path (measureInWindow
 * is a no-op under Jest): the list's visible window is 400px tall at the top of
 * the screen; the focused "Other" input sits at y=700 — i.e. below the fold /
 * behind the keyboard.
 */
const measureNodeStub: MeasureNode = async (_node, role) =>
  role === 'viewport'
    ? { x: 0, y: 0, width: 320, height: 400 }
    : { x: 12, y: 700, width: 296, height: 36 };

/**
 * Mounts the live socket + every interaction surface under one provider,
 * mirroring the ActiveChatScreen composition: the ask prompt renders INSIDE the
 * transcript scroller (the MessageList `footer`), and focusing its "Other" input
 * asks the list to scroll it above the keyboard (issue #10).
 */
function InteractionProbe({ chatId }: { chatId: string }) {
  const socket = useSocket();
  const { messages, status, error, isWorking } = useChatStream(socket, chatId);
  const listRef = useRef<MessageListHandle>(null);
  return (
    <ChatInteractionProvider chatId={chatId} socket={socket} onStartConnection={onStartConnection}>
      <MessageList
        ref={listRef}
        messages={messages}
        status={status}
        error={error}
        isWorking={isWorking}
        measureNode={measureNodeStub}
        footer={
          <ActiveChatInteractions
            chatId={chatId}
            onOtherInputFocus={(input) => listRef.current?.scrollFooterInputIntoView(input)}
          />
        }
      />
      <SecretsBlock block={secretsBlock} />
      <ConnectionRequestBlock block={connectionBlock} />
    </ChatInteractionProvider>
  );
}

async function mount(): Promise<void> {
  const appCtl = createAppStateController();
  const netCtl = createNetInfoController();
  render(
    <SocketProvider
      getAuthToken={async () => 'token-abc'}
      getRelayUrl={async () => 'https://sandbox.portable.test'}
      appState={appCtl.appState}
      netInfo={netCtl.netInfo}
    >
      <InteractionProbe chatId={CHAT_ID} />
    </SocketProvider>
  );
  // Flush the async socket build (token + URL → bind handlers).
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Bring the socket up so emitWithAck has a live transport.
  await act(async () => {
    controller.setConnected(true);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitServer(event: string, payload: unknown): void {
  act(() => {
    controller.emitServerEvent(event, payload);
  });
}

describe('interaction flows', () => {
  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useChatMessagesStore.getState().reset();
      useInteractionStore.getState().reset();
    });
    controller.reset();
    onStartConnection.mockClear();
  });

  it('tool_permission_required → native permission UI → permission:respond', async () => {
    await mount();

    // Seed a streamed assistant message holding a Bash tool block (no permission).
    act(() => {
      useChatMessagesStore.getState().setMessages(CHAT_ID, [
        {
          id: '1',
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              id: 'bash-1',
              toolName: 'Bash',
              toolInput: { command: 'rm -rf node_modules' },
            },
          ],
        },
      ]);
    });
    // No permission prompt yet.
    expect(screen.queryByTestId('block-permission')).toBeNull();

    // Server flags the tool as needing permission → the native UI appears.
    emitServer(SERVER_EVENTS.TOOL_PERMISSION_REQUIRED, {
      chat_id: CHAT_ID,
      request_id: 'req-9',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
    });
    expect(screen.getByTestId('block-permission')).toBeTruthy();
    expect(screen.getByTestId('block-permission-approve')).toBeTruthy();

    // Approve → emits permission:respond with the request id + approval.
    fireEvent.press(screen.getByTestId('block-permission-approve'));
    const responds = controller.emissions.filter(
      (e) => e.event === CLIENT_EVENTS.PERMISSION_RESPOND
    );
    expect(responds).toHaveLength(1);
    expect(responds[0].args[0]).toEqual({ requestId: 'req-9', chatId: CHAT_ID, approved: true });
    // The prompt clears after responding.
    expect(screen.queryByTestId('block-permission-approve')).toBeNull();
  });

  it('ask_user_question → native prompt → answer_user_question callback', async () => {
    await mount();

    expect(screen.queryByTestId('ask-user-question')).toBeNull();

    emitServer(SERVER_EVENTS.ASK_USER_QUESTION, {
      chat_id: CHAT_ID,
      request_id: 'q-1',
      questions: [
        {
          question: 'Which database?',
          header: 'DB',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'Mongo', description: 'Document' },
          ],
        },
      ],
    });

    expect(screen.getByTestId('ask-user-question')).toBeTruthy();

    // Select an option + submit → fire-and-forget answer_user_question.
    fireEvent.press(screen.getByTestId('ask-option-0-Postgres'));
    fireEvent.press(screen.getByTestId('ask-question-submit'));

    const answers = controller.emissions.filter(
      (e) => e.event === CLIENT_EVENTS.ANSWER_USER_QUESTION
    );
    expect(answers).toHaveLength(1);
    expect(answers[0].hadAck).toBe(false); // fire-and-forget
    expect(answers[0].args[0]).toEqual({
      type: 'answer_user_question',
      request_id: 'q-1',
      chat_id: CHAT_ID,
      answers: { '0': ['Postgres'] },
    });
    // The prompt is cleared once answered.
    expect(useInteractionStore.getState().getAskPrompt(CHAT_ID)).toBeUndefined();
  });

  // Issue #10 symptom 1: with several stacked questions the prompt overflowed the
  // screen and NOTHING could scroll it — the shared Submit button was unreachable.
  // The prompt (questions + Submit) must live INSIDE the transcript FlatList (its
  // footer), so the one real scroller owns it.
  it('renders the ask prompt + shared Submit inside the transcript scroller (issue #10)', async () => {
    await mount();

    emitServer(SERVER_EVENTS.ASK_USER_QUESTION, {
      chat_id: CHAT_ID,
      request_id: 'q-2',
      questions: [
        {
          question: 'Pick a framework',
          header: 'FW',
          multiSelect: false,
          options: [
            { label: 'Expo', description: 'React Native' },
            { label: 'Flutter', description: 'Dart' },
          ],
        },
        {
          question: 'Pick a database',
          header: 'DB',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'Mongo', description: 'Document' },
          ],
        },
      ],
    });

    // Both the question form AND its shared Submit are descendants of the FlatList,
    // i.e. part of the scrollable content — not a fixed sibling below it.
    const list = within(screen.getByTestId('message-list'));
    expect(list.getByTestId('ask-user-question')).toBeTruthy();
    expect(list.getByTestId('ask-question-submit')).toBeTruthy();
  });

  // Issue #10 symptom 2: choosing "Other" opened the keyboard OVER the text input.
  // Focusing the input must scroll it into the list's visible window (measured
  // against the keyboard-shrunk viewport): stub rects put the input's bottom at
  // 736 and the visible bottom at 400-12(margin)=388 → scroll down by 348.
  describe('focusing the "Other" input scrolls it above the keyboard (issue #10)', () => {
    /** Seed a single-question prompt whose "Other" input is toggled + focused. */
    async function seedAndFocusOther(): Promise<{
      scrollToOffset: jest.SpyInstance;
      list: { props: Record<string, (arg: unknown) => void> };
      keyboardHandlers: Array<() => void>;
    }> {
      emitServer(SERVER_EVENTS.ASK_USER_QUESTION, {
        chat_id: CHAT_ID,
        request_id: 'q-3',
        questions: [
          {
            question: 'Which database?',
            header: 'DB',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: 'Relational' },
              { label: 'Mongo', description: 'Document' },
            ],
          },
        ],
      });

      const list = screen.UNSAFE_getByType(FlatList as never);
      const scrollToOffset = jest
        .spyOn(list.instance, 'scrollToOffset')
        .mockImplementation(() => undefined);
      // Capture every keyboardDidShow handler the component arms on focus.
      const keyboardHandlers: Array<() => void> = [];
      jest.spyOn(Keyboard, 'addListener').mockImplementation((event, cb) => {
        if (event === 'keyboardDidShow') keyboardHandlers.push(cb as () => void);
        return { remove: () => undefined } as never;
      });

      fireEvent.press(screen.getByTestId('ask-option-0-Other'));
      fireEvent(screen.getByTestId('ask-other-input-0'), 'focus');
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      return { scrollToOffset, list, keyboardHandlers };
    }

    afterEach(() => jest.restoreAllMocks());

    it('the immediate measure scrolls the focused input into view', async () => {
      await mount();
      const { scrollToOffset } = await seedAndFocusOther();
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 348, animated: true });
    });

    // The device-critical path: on focus the keyboard is not yet up (the KAV has not
    // shrunk the list), so a keyboardDidShow re-measure is armed. Firing it must
    // re-scroll — deleting that listener would silently regress the real fix.
    it('re-measures and re-scrolls once the keyboard finishes opening', async () => {
      await mount();
      const { scrollToOffset, keyboardHandlers } = await seedAndFocusOther();
      scrollToOffset.mockClear();
      expect(keyboardHandlers).toHaveLength(1);
      keyboardHandlers[0]();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 348, animated: true });
    });

    // The target offset is the CURRENT scroll offset + the delta (clamped ≥ 0), so a
    // user who scrolled before focusing lands at the right absolute position — not at
    // the bare delta. Drives onScroll to a non-zero offset first.
    it('adds the live scroll offset to the delta (clamped ≥ 0)', async () => {
      await mount();
      const list = screen.UNSAFE_getByType(FlatList as never);
      act(() => list.props.onScroll({ nativeEvent: { contentOffset: { y: 250 } } }));
      const { scrollToOffset } = await seedAndFocusOther();
      // 250 (current offset) + 348 (delta) = 598.
      expect(scrollToOffset).toHaveBeenCalledWith({ offset: 598, animated: true });
    });
  });

  it('secrets form → secrets:submit, resolves on secrets:submitted', async () => {
    await mount();

    // Fill the secret + submit → emits secrets:submit with the captured value.
    fireEvent.changeText(screen.getByTestId('block-secrets-input-OPENAI_API_KEY'), 'sk-123');
    await act(async () => {
      fireEvent.press(screen.getByTestId('block-secrets-submit'));
      await Promise.resolve();
    });

    const submits = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.SECRETS_SUBMIT);
    expect(submits).toHaveLength(1);
    expect(submits[0].args[0]).toEqual({
      chatId: CHAT_ID,
      secrets: { OPENAI_API_KEY: 'sk-123' },
    });
    // Submitting (awaiting confirmation): not yet resolved.
    expect(screen.queryByTestId('block-secrets-submitted')).toBeNull();

    // Server confirms → the form resolves into the submitted state.
    emitServer(SERVER_EVENTS.SECRETS_SUBMITTED, { chatId: CHAT_ID });
    expect(screen.getByTestId('block-secrets-submitted')).toBeTruthy();
    expect(useInteractionStore.getState().getSecretsStatus(CHAT_ID)).toBe('submitted');
  });

  it('connection-request block → enters the connection flow', async () => {
    await mount();

    fireEvent.press(screen.getByTestId('block-connection-request-connect'));
    expect(onStartConnection).toHaveBeenCalledTimes(1);
    expect(onStartConnection).toHaveBeenCalledWith('slack');
  });
});
