/**
 * Message list + streaming render (FlatList).
 *
 * Drives the native Socket.IO provider with a mocked Socket.IO server emitting a
 * multi-block `claude:stream` sequence (two `parent_tool_use_id` sub-agent groups)
 * and asserts that the active-chat `MessageList`:
 *
 *   1. appends streamed blocks incrementally to the per-chat message store;
 *   2. groups sub-agent (Task) output under a collapsible header with an agent
 *      avatar (collapsed by default, expands on tap to reveal the group's blocks);
 *   3. renders the typing/processing indicator on `claude:processing` /
 *      `claude:status` (running) and clears it on `completed`;
 *   4. renders the interrupted (`claude:interrupted`) and error (`claude:error`)
 *      states, the latter appending the inline error block;
 *   5. auto-marks-as-read via `onViewableItemsChanged` — the highest visible
 *      numeric message id is acked.
 */

// Hoisted above imports: route `createSocket()`'s `io()` to our mock socket.
jest.mock('socket.io-client', () => require('../src/test/mockSocket').createSocketIoMock(), {
  virtual: true,
});

// The socket barrel transitively imports the MMKV-backed offline queue store —
// mock the native nitro module so importing the barrel is safe.
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

// MessageList now renders blocks via the BlockRenderer, whose
// TextBlock imports `react-native-markdown-display` (ESM markdown-it). Mock it to
// a marker so importing the chat barrel never loads the real parser under Jest.
jest.mock('react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children?: unknown }) => <Text>{children}</Text>,
  };
});

// The chat barrel transitively imports ChatComposer → VoiceInput → the `expo-audio`
// native module. Replace it with the controllable harness mock.
jest.mock('expo-audio', () => require('../src/test/mockExpoAudio').createExpoAudioMock());

// The user-message copy button writes via expo-clipboard (lazy-required by
// file-viewer/clipboard). Mock the native module so a copy press is assertable.
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// The socket provider chain reads the auth token + sandbox URL from SecureStore
// at module scope (secureAuthStore / relayUrlStore, and extendSession).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: async (k: string, v: string) => void store.set(k, v),
    getItemAsync: async (k: string) => (store.has(k) ? store.get(k)! : null),
    deleteItemAsync: async (k: string) => void store.delete(k),
  };
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { type ReactElement } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';

import { CLIENT_EVENTS, SERVER_EVENTS } from '@vgit2/shared/socket';
import type { ClaudeStreamBlock } from '@vgit2/shared/socket';
import type { AgentSetup, MessageAction } from '@vgit2/shared/types';
import { AUTOPILOT_COMPLETION_INSTRUCTION } from '@vgit2/shared/utils/autopilotHelpers';

import {
  computeScrollIntoViewDelta,
  MessageList,
  useChatMessagesStore,
  useChatStream,
} from '../src/features/chat';
import { SocketProvider, useSocket, useSocketStore } from '../src/features/socket';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';
import { type MockSocketIoModule } from '../src/test';

const socketMock = jest.requireMock('socket.io-client') as MockSocketIoModule;
const controller = socketMock.__controller;

const CHAT_ID = 'chat-1';

/** Inert AppState mock (no transitions needed). */
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

/** Inert NetInfo mock. */
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

/** Agent setups fixture: sub-agents carry their own colorTheme. */
const AGENT_SETUPS: AgentSetup[] = [
  {
    id: 'best-practice',
    name: 'Best Practice',
    description: '',
    systemPromptTemplate: '',
    subAgents: [
      {
        type: 'qa-specialist',
        name: 'QA Specialist',
        description: '',
        prompt: '',
        tools: [],
        model: 'inherit',
        colorTheme: '#10b981',
      },
      {
        type: 'github-specialist',
        name: 'GitHub Specialist',
        description: '',
        prompt: '',
        tools: [],
        model: 'inherit',
        colorTheme: '#8250df',
      },
    ],
    mcpServers: [],
    behavior: {
      useWorkflowManagement: true,
      preferDelegation: true,
      parallelExecution: true,
      planBeforeExecuting: true,
    },
    colorTheme: '#a88dc9',
  },
];

/** Probe: wires the active-chat ViewModel + the list under the live socket. */
function ChatProbe({ chatId }: { chatId: string }) {
  const socket = useSocket();
  const { messages, status, error, isWorking, markRead } = useChatStream(socket, chatId);
  return (
    <MessageList
      messages={messages}
      status={status}
      error={error}
      isWorking={isWorking}
      agentSetups={AGENT_SETUPS}
      onMarkRead={markRead}
    />
  );
}

/**
 * Probe for the load-more ViewModel. The "Load earlier" header lives ABOVE the
 * messages in a virtualizing FlatList (may be off-screen under Jest), so this
 * surfaces `hasMore`/`isLoadingMore`/`loadMore` directly — driving the ViewModel,
 * not the rendered button (the test-strategy "virtualization" gotcha).
 */
function LoadMoreProbe({ chatId }: { chatId: string }) {
  const { messages, hasMore, isLoadingMore, loadMore } = useChatStream(useSocket(), chatId);
  return (
    <View>
      <Text testID="lm-count">{messages.length}</Text>
      <Text testID="lm-hasmore">{hasMore ? 'yes' : 'no'}</Text>
      <Text testID="lm-loading">{isLoadingMore ? 'yes' : 'no'}</Text>
      <Pressable testID="lm-load" onPress={loadMore}>
        <Text>load</Text>
      </Pressable>
    </View>
  );
}

/** A buffered user_message (transforms into a single renderable user message). */
function bufferedUser(id: number, content: string) {
  return { id, type: 'user_message', data: { content }, timestamp: id * 1000 };
}

function block(b: Partial<ClaudeStreamBlock> & { type: string }): ClaudeStreamBlock {
  return b as ClaudeStreamBlock;
}

/** Emit one `claude:stream` block (wrapped in act). */
function stream(b: ClaudeStreamBlock): void {
  act(() => {
    controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STREAM, { chatId: CHAT_ID, block: b });
  });
}

function blockCount(): number {
  const msgs = useChatMessagesStore.getState().getMessages(CHAT_ID);
  return msgs.reduce((n, m) => n + (m.blocks?.length ?? 0), 0);
}

describe('message list + streaming render', () => {
  let appCtl: ReturnType<typeof createAppStateController>;
  let netCtl: ReturnType<typeof createNetInfoController>;

  async function mountChat(): Promise<void> {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
      >
        <ChatProbe chatId={CHAT_ID} />
      </SocketProvider>
    );
    // Flush the async socket-creation effect (resolves token + URL, binds handlers).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Bring the socket up so the join effect fires (joins on `connect`).
    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Mount an arbitrary probe (load-more tests use `LoadMoreProbe`). */
  async function mountProbe(node: ReactElement): Promise<void> {
    appCtl = createAppStateController();
    netCtl = createNetInfoController();
    render(
      <SocketProvider
        getAuthToken={async () => 'token-abc'}
        getRelayUrl={async () => 'https://sandbox.portable.test'}
        appState={appCtl.appState}
        netInfo={netCtl.netInfo}
      >
        {node}
      </SocketProvider>
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

  /** Toggle the socket down→up (the navigate-away-and-back / reconnect re-entry). */
  async function reconnect(): Promise<void> {
    await act(async () => {
      controller.setConnected(false);
      await Promise.resolve();
    });
    await act(async () => {
      controller.setConnected(true);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  afterEach(() => {
    act(() => {
      useSocketStore.getState().reset();
      useChatMessagesStore.getState().reset();
    });
    controller.reset();
  });

  it('joins the chat on mount (chat:join emitted for the room)', async () => {
    await mountChat();
    const joins = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_JOIN);
    expect(joins).toHaveLength(1);
    expect(joins[0].args[0]).toMatchObject({ chatId: CHAT_ID });
  });

  it('appends streamed blocks incrementally and groups sub-agents with collapse/expand', async () => {
    await mountChat();

    // Main-agent text, then a Task that spawns sub-agent "task-1", its two blocks,
    // a second Task "task-2", and that sub-agent's block.
    stream(block({ type: 'text', blockId: 'a', content: 'Starting work' }));
    expect(blockCount()).toBe(1);

    stream(
      block({
        type: 'tool_use',
        id: 'task-1',
        blockId: 'b',
        toolName: 'Task',
        toolInput: { subagent_type: 'qa-specialist' },
      })
    );
    expect(blockCount()).toBe(2);

    stream(block({ type: 'tool_use', id: 'c1', blockId: 'c', parent_tool_use_id: 'task-1' }));
    stream(
      block({ type: 'text', blockId: 'd', content: 'qa working', parent_tool_use_id: 'task-1' })
    );
    stream(
      block({
        type: 'tool_use',
        id: 'task-2',
        blockId: 'e',
        toolName: 'Task',
        toolInput: { subagent_type: 'github-specialist' },
      })
    );
    stream(block({ type: 'tool_use', id: 'f1', blockId: 'f', parent_tool_use_id: 'task-2' }));

    // All six blocks landed on one assistant message, in order.
    expect(blockCount()).toBe(6);

    // Two sub-agent groups rendered with avatars; bodies collapsed by default.
    expect(screen.getByTestId('agent-group-task-1')).toBeTruthy();
    expect(screen.getByTestId('agent-group-task-2')).toBeTruthy();
    expect(screen.getByTestId('agent-avatar-task-1')).toBeTruthy();
    expect(screen.queryByTestId('agent-body-task-1')).toBeNull();

    // Expanding the first sub-agent reveals its two blocks.
    fireEvent.press(screen.getByTestId('agent-toggle-task-1'));
    expect(screen.queryByTestId('agent-body-task-1')).not.toBeNull();
    expect(screen.queryByTestId('agent-body-task-2')).toBeNull();
  });

  it('consolidates INTERLEAVED sub-agent blocks into ONE card per agent (no fragment spam)', async () => {
    await mountChat();

    // Two parallel sub-agents whose output is INTERLEAVED in the stream, with the
    // main agent narrating between them — the shape the old consecutive grouping
    // shattered into a wall of tiny cards.
    stream(block({ type: 'text', blockId: 'a', content: 'Delegating' }));
    stream(
      block({
        type: 'tool_use',
        id: 'task-1',
        blockId: 'b',
        toolName: 'Task',
        toolInput: { subagent_type: 'qa-specialist', description: 'Run the test suite' },
      })
    );
    stream(
      block({
        type: 'tool_use',
        id: 'task-2',
        blockId: 'c',
        toolName: 'Task',
        toolInput: { subagent_type: 'github-specialist', description: 'Open the PR' },
      })
    );
    // Interleaved children A,B,A,B + a main narration block in the middle.
    stream(block({ type: 'text', blockId: 'd', content: 'qa 1', parent_tool_use_id: 'task-1' }));
    stream(block({ type: 'text', blockId: 'e', content: 'gh 1', parent_tool_use_id: 'task-2' }));
    stream(block({ type: 'text', blockId: 'f', content: 'still going' }));
    stream(block({ type: 'text', blockId: 'g', content: 'qa 2', parent_tool_use_id: 'task-1' }));
    stream(block({ type: 'text', blockId: 'h', content: 'gh 2', parent_tool_use_id: 'task-2' }));

    // EXACTLY ONE card per sub-agent — interleaving folds into the same card.
    expect(screen.getAllByTestId(/^agent-group-/)).toHaveLength(2);
    expect(screen.getByTestId('agent-group-task-1')).toBeTruthy();
    expect(screen.getByTestId('agent-group-task-2')).toBeTruthy();

    // Each card shows the CONFIGURED designation + the spawning Task's description.
    expect(screen.getByTestId('agent-name-task-1')).toHaveTextContent('QA Specialist');
    expect(screen.getByTestId('agent-task-task-1')).toHaveTextContent('Run the test suite');
    expect(screen.getByTestId('agent-name-task-2')).toHaveTextContent('GitHub Specialist');
    expect(screen.getByTestId('agent-task-task-2')).toHaveTextContent('Open the PR');

    // The card count reflects ONLY the sub-agent's own blocks (the spawning Task is
    // folded into the header, not double-rendered): task-1 = {qa 1, qa 2} = 2.
    fireEvent.press(screen.getByTestId('agent-toggle-task-1'));
    const body1 = within(screen.getByTestId('agent-body-task-1'));
    expect(body1.getByText('qa 1')).toBeTruthy();
    expect(body1.getByText('qa 2')).toBeTruthy();
    // The other agent's interleaved block never leaked into this card.
    expect(body1.queryByText('gh 1')).toBeNull();
  });

  it('shows the processing/typing indicator on processing + status, clears on completed', async () => {
    await mountChat();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_PROCESSING, { chatId: CHAT_ID });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).not.toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STATUS, {
        chatId: CHAT_ID,
        status: 'running',
      });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).not.toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STATUS, {
        chatId: CHAT_ID,
        status: 'completed',
      });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
  });

  it("keeps the typing indicator when the chat:join ack carries the stale spawn-window 'completed' (home/repo → chat hand-off)", async () => {
    // The new-chat flow just sent the first message and navigated here
    // (`markRunStarted`), while the backend — its Claude session still
    // spawning — answers the screen's join with a stale 'completed' snapshot.
    useChatMessagesStore.getState().markRunStarted(CHAT_ID);
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [],
      status: 'completed',
    });

    await mountChat();

    // The stale snapshot is SKIPPED (`processingChats` parity): the
    // optimistic 'running' survives and the indicator stays up.
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('running');
    expect(screen.queryByTestId('chat-typing-indicator')).not.toBeNull();

    // The real server events then own the lifecycle as usual.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STATUS, {
        chatId: CHAT_ID,
        status: 'completed',
      });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
  });

  it('adopts the join snapshot again once the optimistic start is stale (grace window passed)', async () => {
    useChatMessagesStore.getState().markRunStarted(CHAT_ID, Date.now() - 60_000);
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [],
      status: 'completed',
    });

    await mountChat();

    await waitFor(() => {
      expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('completed');
    });
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
  });

  it("animates the working indicator inside the ACTIVE sub-agent group, in that agent's color", async () => {
    await mountChat();

    // Main text, then a Task spawning "github-specialist" and one of its blocks —
    // the sub-agent group is the run's ACTIVE (last) group.
    stream(block({ type: 'text', blockId: 'a', content: 'Starting work' }));
    stream(
      block({
        type: 'tool_use',
        id: 'task-2',
        blockId: 'e',
        toolName: 'Task',
        toolInput: { subagent_type: 'github-specialist' },
      })
    );
    stream(block({ type: 'tool_use', id: 'f1', blockId: 'f', parent_tool_use_id: 'task-2' }));

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STATUS, {
        chatId: CHAT_ID,
        status: 'running',
      });
    });

    // The group avatar takes the sub-agent's own colorTheme.
    expect(screen.getByTestId('agent-avatar-task-2')).toHaveStyle({ backgroundColor: '#8250df' });

    // Exactly ONE indicator, INSIDE the active group (collapsed → header dots).
    expect(screen.getAllByTestId('chat-typing-indicator')).toHaveLength(1);
    expect(
      within(screen.getByTestId('agent-group-task-2')).queryByTestId('chat-typing-indicator')
    ).not.toBeNull();

    // Expanding keeps it — now the full "{agent} is working..." line in the body,
    // using the CONFIGURED sub-agent name (getAgentInfo), not the humanized slug.
    fireEvent.press(screen.getByTestId('agent-toggle-task-2'));
    const body = within(screen.getByTestId('agent-body-task-2'));
    expect(body.queryByTestId('chat-typing-indicator')).not.toBeNull();
    expect(body.getByText('GitHub Specialist is working...')).toBeTruthy();

    // A main-agent block hands the animation back to the after-groups indicator.
    stream(block({ type: 'text', blockId: 'g', content: 'Wrapping up' }));
    expect(screen.getAllByTestId('chat-typing-indicator')).toHaveLength(1);
    expect(
      within(screen.getByTestId('agent-group-task-2')).queryByTestId('chat-typing-indicator')
    ).toBeNull();

    // Completed clears it everywhere.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_STATUS, {
        chatId: CHAT_ID,
        status: 'completed',
      });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
  });

  it('renders the interrupted state (status → completed, no typing)', async () => {
    await mountChat();
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_PROCESSING, { chatId: CHAT_ID });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).not.toBeNull();

    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_INTERRUPTED, { chatId: CHAT_ID });
    });
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('completed');
  });

  it('appends the inline error block and SUPPRESSES the raw error footer', async () => {
    await mountChat();
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_ERROR, {
        chatId: CHAT_ID,
        // Raw internal text the backend also sends — must NOT leak into the chat
        // when a structured block is present (portable.dev#18).
        error: '[LocalAiCredentialsService] FATAL: No local Anthropic credential configured.',
        errorBlock: { type: 'error', blockId: 'err', title: 'Claude sign-in needed' },
      });
    });
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('error');
    // The structured block landed on the message list…
    expect(blockCount()).toBe(1);
    // …and the raw footer (which would render `error` verbatim) is NOT shown.
    expect(screen.queryByTestId('chat-error')).toBeNull();
    expect(useChatMessagesStore.getState().errors[CHAT_ID]).toBeUndefined();
  });

  it('shows the raw footer for a generic error with no structured block', async () => {
    await mountChat();
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_ERROR, {
        chatId: CHAT_ID,
        error: 'Something broke',
      });
    });
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('error');
    // No block → the footer is the only error signal (catch-all).
    expect(screen.queryByTestId('chat-error')).not.toBeNull();
    expect(blockCount()).toBe(0);
  });

  it('auto-marks-as-read via onViewableItemsChanged (highest visible numeric id)', async () => {
    await mountChat();
    // Seed a user message carrying a numeric id via the backend echo.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.USER_MESSAGE, {
        chatId: CHAT_ID,
        id: '7',
        content: 'hi',
        timestamp: 1,
      });
    });

    // Cast through `never`: UNSAFE_getByType's param resolves against the React
    // 18 @types in the tree while this package is React 19 (the `bigint` ReactNode
    // diff), so the concrete FlatList type isn't assignable. The runtime is fine.
    const list = screen.UNSAFE_getByType(FlatList as never);
    act(() => {
      list.props.onViewableItemsChanged({ viewableItems: [{ item: { id: '7' } }] });
    });

    const reads = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_MARK_READ);
    expect(reads).toHaveLength(1);
    expect(reads[0].args[0]).toMatchObject({ chatId: CHAT_ID, messageId: 7 });
  });

  it('strips the leaked autopilot instruction from the live user_message echo', async () => {
    await mountChat();
    // Autopilot ON → the backend echoes the AUGMENTED content (user text + the
    // completion instruction). The optimistic bubble must not be replaced with it.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.USER_MESSAGE, {
        chatId: CHAT_ID,
        id: 'm-1',
        content: `add a comment to the README${AUTOPILOT_COMPLETION_INSTRUCTION}`,
        timestamp: 1,
      });
    });

    const msgs = useChatMessagesStore.getState().getMessages(CHAT_ID);
    const echoed = msgs.find((m) => m.id === 'm-1');
    expect(echoed?.content).toBe('add a comment to the README');
    expect(echoed?.content).not.toContain('<promise>COMPLETE</promise>');
    expect(echoed?.content).not.toContain('IMPORTANT: You MUST');
  });
  it('renders a copy button on a user message that copies its text and flips to a check', async () => {
    await mountChat();
    // Seed a user message via the backend echo.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.USER_MESSAGE, {
        chatId: CHAT_ID,
        id: '7',
        content: 'copy me please',
        timestamp: 1,
      });
    });

    const clipboard = jest.requireMock('expo-clipboard') as { setStringAsync: jest.Mock };
    clipboard.setStringAsync.mockClear();

    const button = screen.getByTestId('message-copy-0');
    expect(button.props.accessibilityLabel).toBe('Copy message');

    await act(async () => {
      fireEvent.press(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clipboard.setStringAsync).toHaveBeenCalledWith('copy me please');
    await waitFor(() =>
      expect(screen.getByTestId('message-copy-0').props.accessibilityLabel).toBe('Copied')
    );
  });

  // ── re-join MERGE (navigate-away-and-back must not wipe live messages) ──

  it('reconnecting to a RUNNING chat with an empty join ack does NOT wipe live messages', async () => {
    await mountChat();
    // The chat is actively running with live-streamed content.
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_PROCESSING, { chatId: CHAT_ID });
    });
    stream(block({ type: 'text', blockId: 'a', content: 'live work in progress' }));
    expect(blockCount()).toBe(1);
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('running');

    // The persisted buffer lags → the re-join ack is EMPTY (the session is still
    // processing, so the backend honestly reports 'running'). This is exactly the
    // repro: navigate to Home, tab back.
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [],
      status: 'running',
    });
    await reconnect();

    // The merge no-ops on the empty ack — live block survives, status stays running.
    expect(blockCount()).toBe(1);
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('running');
    expect(screen.queryByTestId('chat-typing-indicator')).not.toBeNull();
  });

  it('a SHORT re-join ack on a running chat MERGES (keeps the live block + the backend message)', async () => {
    await mountChat();
    act(() => {
      controller.emitServerEvent(SERVER_EVENTS.CLAUDE_PROCESSING, { chatId: CHAT_ID });
    });
    stream(block({ type: 'text', blockId: 'a', content: 'streamed, not yet persisted' }));

    // Re-join returns only the persisted user message (the assistant blocks lag);
    // the session is still processing → honest 'running' status.
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [bufferedUser(1, 'the prompt')],
      status: 'running',
    });
    await reconnect();

    const msgs = useChatMessagesStore.getState().getMessages(CHAT_ID);
    // backend user message + the live-only assistant message, in order.
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(blockCount()).toBe(1); // the live block 'a' was preserved
    expect(useChatMessagesStore.getState().statuses[CHAT_ID]).toBe('running');
  });

  // ── load-more (re-join with a growing count) ──

  it('load-more re-joins with a bigger count and grows the list; hasMore flips off', async () => {
    // Page 1: latest 50 (here 2) with more behind it.
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [bufferedUser(1, 'm1'), bufferedUser(2, 'm2')],
      status: 'completed',
      hasMore: true,
    });
    await mountProbe(<LoadMoreProbe chatId={CHAT_ID} />);

    expect(screen.getByTestId('lm-count')).toHaveTextContent('2');
    expect(screen.getByTestId('lm-hasmore')).toHaveTextContent('yes');

    // Page 2: re-join returns the latest 100 (here 3) and reports no more behind it.
    controller.setAck(CLIENT_EVENTS.CHAT_JOIN, {
      success: true,
      messages: [bufferedUser(1, 'm1'), bufferedUser(2, 'm2'), bufferedUser(3, 'm3')],
      status: 'completed',
      hasMore: false,
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('lm-load'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The second join carried the grown count (50 → 100), the list grew, hasMore off.
    const joins = controller.emissions.filter((e) => e.event === CLIENT_EVENTS.CHAT_JOIN);
    expect(joins[joins.length - 1].args[0]).toMatchObject({ chatId: CHAT_ID, count: 100 });
    expect(screen.getByTestId('lm-count')).toHaveTextContent('3');
    expect(screen.getByTestId('lm-hasmore')).toHaveTextContent('no');
  });

  it('threads onActionClick down to an actions-block chip (tap fires it)', () => {
    const onActionClick = jest.fn();
    const action: MessageAction = {
      id: 'act-1',
      label: 'Start fix',
      prompt: 'Fix the failing test',
      actionType: 'send_message',
    };
    // Direct render (no socket): one assistant message carrying an actions block.
    render(
      <MessageList
        messages={[
          { id: 'm1', role: 'assistant', blocks: [block({ type: 'actions', actions: [action] })] },
        ]}
        onActionClick={onActionClick}
      />
    );

    fireEvent.press(screen.getByTestId('block-action-act-1'));

    expect(onActionClick).toHaveBeenCalledWith(action);
  });
});

// ── Auto-scroll: ALWAYS snap to the bottom on content growth ──
//
// `onContentSizeChange` fires on ANY content-height change. The rule is purely the height
// DELTA: a GROWTH (new message / streamed block) ALWAYS scrolls to the bottom — there is
// NO near-bottom / follow gate (it stranded the stream off the bottom and scrolled to the
// top); a collapse SHRINKS and never scrolls. The "AI is responding" placeholder appearing
// (isWorking → true) also snaps to the bottom. These tests drive the FlatList seam directly,
// spying on the list instance's `scrollToEnd`.
describe('auto-scroll: always snap to the bottom on content growth', () => {
  // The component defers the snap-to-bottom one frame (requestAnimationFrame) so it runs
  // after the layout commit on the New Architecture; tests inject a SYNCHRONOUS runner so
  // `scrollToEnd` is observable in the same tick.
  const runScrollNow = (cb: () => void) => cb();

  /** A message carrying a collapsible sub-agent group AND a Bash tool block. */
  function collapsibleMessage(id: string): {
    id: string;
    role: 'assistant';
    blocks: ClaudeStreamBlock[];
  } {
    return {
      id,
      role: 'assistant',
      blocks: [
        block({
          type: 'tool_use',
          id: 'task-1',
          blockId: `${id}-b`,
          toolName: 'Task',
          toolInput: { subagent_type: 'qa-specialist' },
        }),
        block({ type: 'tool_use', id: 'c1', blockId: `${id}-c`, parent_tool_use_id: 'task-1' }),
        block({
          type: 'tool_use',
          id: 'sh',
          blockId: `${id}-sh`,
          toolName: 'Bash',
          toolInput: { command: 'ls -la' },
        }),
      ],
    };
  }

  /** Spy on the rendered FlatList instance's `scrollToEnd` (the auto-scroll call). */
  function spyOnScrollToEnd(): jest.SpyInstance {
    const list = screen.UNSAFE_getByType(FlatList as never);
    return jest.spyOn(list.instance, 'scrollToEnd').mockImplementation(() => undefined);
  }

  /** Fire the FlatList's `onContentSizeChange(width, height)` (re-reads fresh props). */
  function fireContentSize(height: number): void {
    const list = screen.UNSAFE_getByType(FlatList as never);
    act(() => list.props.onContentSizeChange(0, height));
  }

  it('does NOT scroll when content SHRINKS (a collapse)', () => {
    render(
      <MessageList
        messages={[collapsibleMessage('m1')]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();

    // Open-at-bottom: the first (0 -> H) growth scrolls. Consume it.
    fireContentSize(1200);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();

    // Collapsing a section shrinks the content — the height-delta is negative, so the
    // viewport must hold (the one behaviour kept).
    fireContentSize(900);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('scrolls to the bottom when content GROWS (a new message / streamed block)', () => {
    render(
      <MessageList
        messages={[collapsibleMessage('m1')]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();
    fireContentSize(1200); // open-at-bottom
    scrollToEnd.mockClear();

    fireContentSize(1500); // a new streamed block grows the content
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  // Regression: opening a history-laden chat must land at the BOTTOM, not the top.
  // Virtualization measures content height incrementally (several growth events), so the
  // scroll must be NON-animated — an animated scroll would lag the incremental measurement
  // and strand the list partway (i.e. open at the top).
  it('opens at the bottom: every incremental growth pins (non-animated)', () => {
    render(
      <MessageList
        messages={[collapsibleMessage('m1')]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();

    // Virtualization measures the content in steps — each growth must keep pinning to the
    // true bottom.
    fireContentSize(400);
    fireContentSize(900);
    fireContentSize(1600);

    expect(scrollToEnd).toHaveBeenCalledTimes(3);
    // Instant (animated: false) so each incremental growth lands at the true bottom.
    for (const call of scrollToEnd.mock.calls) {
      expect(call[0]).toEqual({ animated: false });
    }
  });

  // The near-bottom / follow gate is REMOVED (the user asked to always return to the
  // bottom on a new message). There is no scroll-position condition — a growth ALWAYS
  // scrolls, even after the user scrolled up to read earlier output.
  it('scrolls to the bottom on every growth, regardless of scroll position', () => {
    render(
      <MessageList
        messages={[collapsibleMessage('m1')]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();
    fireContentSize(1200); // open-at-bottom
    scrollToEnd.mockClear();

    // Two new streamed blocks arrive — each grows the content and snaps to the bottom.
    fireContentSize(1500);
    fireContentSize(2000);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  // The "AI is responding" placeholder (typing indicator) appearing is a STATE change
  // (isWorking → true), not necessarily a measured content growth — it must still snap
  // the view to the bottom so the user sees the run started.
  it('snaps to the bottom when the AI-responding placeholder appears (isWorking → true)', () => {
    const userMsg = { id: 'u1', role: 'user' as const, blocks: [] };
    render(
      <MessageList messages={[userMsg]} agentSetups={AGENT_SETUPS} scheduleScroll={runScrollNow} />
    );
    const scrollToEnd = spyOnScrollToEnd();

    screen.rerender(
      <MessageList
        messages={[userMsg]}
        isWorking
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    expect(scrollToEnd).toHaveBeenCalled();
  });

  // The direct "a new message arrived" signal: when a message lands at the TAIL the view
  // snaps to the bottom even if `onContentSizeChange` lags — but a load-earlier PREPEND
  // (older message at the HEAD, tail unchanged) must NOT yank a scrolled-up reader down.
  it('snaps when a new message lands at the tail, NOT on a load-earlier prepend', () => {
    const a = { id: 'a', role: 'assistant' as const, blocks: [] };
    const b = { id: 'b', role: 'user' as const, blocks: [] };
    render(<MessageList messages={[a]} agentSetups={AGENT_SETUPS} scheduleScroll={runScrollNow} />);
    const scrollToEnd = spyOnScrollToEnd();

    // New message at the tail → snaps to the bottom.
    screen.rerender(
      <MessageList messages={[a, b]} agentSetups={AGENT_SETUPS} scheduleScroll={runScrollNow} />
    );
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();

    // Load-earlier prepend: an older message is added at the HEAD, the tail id is unchanged
    // → no scroll (a scrolled-up reader keeps their place).
    const older = { id: 'older', role: 'user' as const, blocks: [] };
    screen.rerender(
      <MessageList
        messages={[older, a, b]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('a real agent-group / tool-block toggle does not fire a growth (no scroll)', () => {
    render(
      <MessageList
        messages={[collapsibleMessage('m1')]}
        agentSetups={AGENT_SETUPS}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();
    fireContentSize(1200); // open-at-bottom
    scrollToEnd.mockClear();

    // Both collapsible kinds expand on tap (row-local state, no onContentSizeChange auto-
    // fires under Jest), so no growth is reported and nothing scrolls.
    fireEvent.press(screen.getByTestId('agent-toggle-task-1'));
    expect(screen.queryByTestId('agent-body-task-1')).not.toBeNull();
    fireEvent.press(screen.getByTestId('tool-block-bash-toggle'));
    expect(screen.queryByTestId('tool-block-bash-body')).not.toBeNull();
    expect(scrollToEnd).not.toHaveBeenCalled();

    // Collapsing them back shrinks the content — still no scroll (height-based decision).
    fireEvent.press(screen.getByTestId('agent-toggle-task-1'));
    fireEvent.press(screen.getByTestId('tool-block-bash-toggle'));
    fireContentSize(950);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});

// ── Auto-load earlier history on scroll-to-top (replaces the "Load earlier" tap) ──
//
// `onStartReached` triggers `loadMore` as the user nears the TOP, but ONLY after a real
// user drag (`onScrollBeginDrag`) so the programmatic open-time `scrollToEnd` — which
// momentarily sits at the start — never auto-loads a page. The old tap button is gone;
// the header is just a spinner while a load-earlier re-join is in flight.
describe('auto-load earlier history on scroll-to-top', () => {
  const textMessage = (id: string) => ({
    id,
    role: 'assistant' as const,
    blocks: [block({ type: 'text', text: 'hi', blockId: `${id}-t` })],
  });
  const getList = () => screen.UNSAFE_getByType(FlatList as never);

  it('auto-loads only AFTER a real user drag reaches the start (not on the open scroll)', () => {
    const onLoadMore = jest.fn();
    render(<MessageList messages={[textMessage('5')]} hasMore onLoadMore={onLoadMore} />);
    const list = getList();

    // Reaching the start without a user drag (the programmatic scrollToEnd path) is ignored.
    act(() => list.props.onStartReached?.());
    expect(onLoadMore).not.toHaveBeenCalled();

    // A genuine drag arms it; nearing the top then auto-loads — no tap.
    act(() => list.props.onScrollBeginDrag?.());
    act(() => list.props.onStartReached?.());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-load when there is no more history (hasMore=false)', () => {
    const onLoadMore = jest.fn();
    render(<MessageList messages={[textMessage('5')]} hasMore={false} onLoadMore={onLoadMore} />);
    const list = getList();
    act(() => list.props.onScrollBeginDrag?.());
    act(() => list.props.onStartReached?.());
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('shows the loading spinner header (no tap button) while a load-earlier is in flight', () => {
    render(<MessageList messages={[]} isLoadingMore hasMore />);
    expect(screen.queryByTestId('chat-load-earlier-loading')).not.toBeNull();
    // The old "Load earlier messages" Pressable is gone.
    expect(screen.queryByTestId('chat-load-earlier')).toBeNull();
  });
});

// ── Background-task notification filtering (the runtime status blob must not show) ──
//
// The Claude Code / Agent SDK injects a `<task-notification>` status blob into the message
// stream (e.g. when a background command is killed). It is machine context for the agent —
// the list hides a notification-ONLY message and strips a notification mixed into real text.
describe('task-notification filtering', () => {
  const NOTE =
    '<task-notification><status>killed</status>' +
    '<summary>Background command "Start dev server" was stopped</summary></task-notification>';

  it('hides a user message that is ENTIRELY a task notification', () => {
    render(
      <MessageList
        messages={[{ id: 'tn', role: 'user' as const, content: NOTE, blocks: [] }]}
        agentSetups={AGENT_SETUPS}
      />
    );
    // The bubble is filtered out entirely — no user content, count is 0.
    expect(screen.queryByTestId('message-user-content')).toBeNull();
    expect(screen.getByTestId('chat-message-count')).toHaveTextContent(/^0$/);
  });

  it('keeps a mixed message but strips the notification blob from the bubble', () => {
    render(
      <MessageList
        messages={[
          { id: 'mix', role: 'user' as const, content: `Deploy the app\n${NOTE}`, blocks: [] },
        ]}
        agentSetups={AGENT_SETUPS}
      />
    );
    const bubble = screen.getByTestId('message-user-content');
    expect(bubble).toHaveTextContent(/Deploy the app/);
    expect(bubble).not.toHaveTextContent(/task-notification/);
    expect(bubble).not.toHaveTextContent(/killed/);
    expect(screen.getByTestId('chat-message-count')).toHaveTextContent(/^1$/);
  });
});

// ── File-edit grouping (consolidate Write/Edit/MultiEdit into one widget) ──
//
// A turn that touches many files (or edits one file repeatedly) used to render
// one card per edit — a long, noisy vertical stack. `groupFileEditBlocks` gives
// file edits the same "group by identity" treatment `groupBlocksByAgent` gives
// sub-agent output: ALL of a scope's edit blocks fold into ONE `FileEditGroup`
// card, robust to interleaving, while a single edit still renders inline.
describe('file-edit grouping (consolidated "Files edited" widget)', () => {
  const editUse = (id: string, filePath: string) =>
    block({
      type: 'tool_use',
      id,
      blockId: id,
      toolName: 'Edit',
      toolInput: { file_path: filePath, old_string: 'old', new_string: 'new' },
    });
  const writeUse = (id: string, filePath: string) =>
    block({
      type: 'tool_use',
      id,
      blockId: id,
      toolName: 'Write',
      toolInput: { file_path: filePath, content: 'hello' },
    });

  it('consolidates 3+ file edits into a single "Files edited" widget (not one card per edit)', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            blocks: [
              editUse('e1', '/repo/a.ts'),
              editUse('e2', '/repo/b.ts'),
              writeUse('e3', '/repo/c.ts'),
            ],
          },
        ]}
      />
    );

    // ONE consolidated widget, not three separate cards — collapsed by default.
    expect(screen.getAllByTestId(/^file-edit-group-toggle-/)).toHaveLength(1);
    expect(screen.queryByTestId('tool-block-edit')).toBeNull();
    expect(screen.queryByTestId('tool-block-write')).toBeNull();
    expect(screen.getByTestId('file-edit-group-count-e1')).toHaveTextContent('3');
    // Collapsed still shows WHICH files changed (never hides the information).
    expect(screen.getByTestId('file-edit-group-preview-e1')).toHaveTextContent(/a\.ts/);
    expect(screen.getByTestId('file-edit-group-preview-e1')).toHaveTextContent(/b\.ts/);
    expect(screen.getByTestId('file-edit-group-preview-e1')).toHaveTextContent(/c\.ts/);
  });

  it('expanding the group reveals each edit individually (file name + diff still inspectable)', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            blocks: [editUse('e1', '/repo/a.ts'), editUse('e2', '/repo/b.ts')],
          },
        ]}
      />
    );

    fireEvent.press(screen.getByTestId('file-edit-group-toggle-e1'));
    const body = within(screen.getByTestId('file-edit-group-body-e1'));
    // Both edits render via the real per-file EditBlock (native diff), each still
    // its own independent collapsible.
    expect(body.getAllByTestId('tool-block-edit')).toHaveLength(2);
    const toggles = body.getAllByTestId('tool-block-edit-toggle');
    expect(toggles).toHaveLength(2);

    // Tapping one edit's own toggle reveals its diff (the detail survives the group).
    fireEvent.press(toggles[0]);
    expect(screen.getAllByTestId('diff-highlight').length).toBeGreaterThan(0);
  });

  it('is robust to interleaving: narration/other tool calls between edits still consolidate into ONE widget', () => {
    render(
      <MessageList
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            blocks: [
              block({ type: 'text', blockId: 't1', content: 'Updating three files' }),
              editUse('e1', '/repo/a.ts'),
              block({ type: 'text', blockId: 't2', content: 'now the second' }),
              block({
                type: 'tool_use',
                id: 'bash1',
                blockId: 'bsh',
                toolName: 'Bash',
                toolInput: { command: 'ls' },
              }),
              editUse('e2', '/repo/b.ts'),
              block({ type: 'text', blockId: 't3', content: 'and the third' }),
              writeUse('e3', '/repo/c.ts'),
            ],
          },
        ]}
      />
    );

    // Exactly ONE group — interleaving folds into the same card, not three fragments.
    expect(screen.getAllByTestId(/^file-edit-group-toggle-/)).toHaveLength(1);
    // The narration + the unrelated Bash call stay INLINE, in their original order.
    expect(screen.getByText('Updating three files')).toBeTruthy();
    expect(screen.getByText('now the second')).toBeTruthy();
    expect(screen.getByText('and the third')).toBeTruthy();
    expect(screen.getByTestId('tool-block-bash')).toBeTruthy();

    fireEvent.press(screen.getByTestId('file-edit-group-toggle-e1'));
    expect(screen.getAllByTestId('tool-block-edit')).toHaveLength(2);
    expect(screen.getByTestId('tool-block-write')).toBeTruthy();
  });

  it('a lone file edit renders inline with no group wrapper (only busy multi-edit turns consolidate)', () => {
    render(
      <MessageList
        messages={[{ id: 'm1', role: 'assistant', blocks: [editUse('e1', '/repo/a.ts')] }]}
      />
    );

    expect(screen.queryAllByTestId(/^file-edit-group-toggle-/)).toHaveLength(0);
    expect(screen.getByTestId('tool-block-edit')).toBeTruthy();
  });

  it("composes with sub-agent grouping: a sub-agent's own multi-file edits consolidate inside its card", () => {
    render(
      <MessageList
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            blocks: [
              block({
                type: 'tool_use',
                id: 'task-1',
                blockId: 'b',
                toolName: 'Task',
                toolInput: { subagent_type: 'qa-specialist' },
              }),
              block({ ...editUse('e1', '/repo/a.ts'), parent_tool_use_id: 'task-1' }),
              block({ ...editUse('e2', '/repo/b.ts'), parent_tool_use_id: 'task-1' }),
            ],
          },
        ]}
        agentSetups={AGENT_SETUPS}
      />
    );

    // No file-edit group at the top level (the main agent has no blocks of its
    // own here) — the sub-agent's card owns it, collapsed with the rest.
    expect(screen.queryAllByTestId(/^file-edit-group-toggle-/)).toHaveLength(0);
    fireEvent.press(screen.getByTestId('agent-toggle-task-1'));
    const body = within(screen.getByTestId('agent-body-task-1'));
    expect(body.getAllByTestId(/^file-edit-group-toggle-/)).toHaveLength(1);
  });
});

// ── rev12 cross-surface presence: the "Working locally..." transcript indicator ──
//
// While a terminal turn is in flight on the PC (`workingOnPc`), nothing streams to
// the app — the transcript only hydrates when the turn COMPLETES
// (`chat:external_turn_completed`), so without this the chat reads as dead while
// the header badge says "Running on PC". The footer shows the working dots with a
// "Working locally..." line instead. The LOCAL run's indicator (`isWorking`)
// always wins — the two never double up.
describe('working-on-pc indicator (rev12 presence)', () => {
  const assistantMessage = {
    id: 'm1',
    role: 'assistant' as const,
    blocks: [block({ type: 'text', text: 'previous turn', blockId: 'b1' })],
  };

  it('shows "Working locally..." while a terminal turn is in flight on the PC', () => {
    render(<MessageList messages={[assistantMessage]} workingOnPc />);
    expect(screen.getByTestId('working-on-pc-indicator')).toBeTruthy();
    expect(screen.getByText('Working locally...')).toBeTruthy();
    // The local run's indicator is a different element and stays absent.
    expect(screen.queryByTestId('chat-typing-indicator')).toBeNull();
  });

  it('renders no indicator when no terminal turn is in flight', () => {
    render(<MessageList messages={[assistantMessage]} />);
    expect(screen.queryByTestId('working-on-pc-indicator')).toBeNull();
  });

  it('the local run indicator wins when both are active (no doubled dots)', () => {
    render(<MessageList messages={[assistantMessage]} isWorking status="running" workingOnPc />);
    expect(screen.queryByTestId('working-on-pc-indicator')).toBeNull();
    expect(screen.getAllByTestId('chat-typing-indicator')).toHaveLength(1);
  });
});

// ── Issue #10: the interactive ask-user prompt rides the transcript scroller ──
//
// The prompt used to mount as a fixed sibling BELOW the FlatList: with several
// stacked questions it overflowed the column with no scroll owner (Submit
// unreachable) and no scroller for keyboard avoidance (the keyboard covered the
// "Other" input). The fix folds it into the list as the `footer` prop, and
// `scrollFooterInputIntoView` nudges a focused footer input into the list's
// visible (keyboard-shrunk) window.
describe('interactive footer (issue #10)', () => {
  const runScrollNow = (cb: () => void) => cb();
  const msg = { id: 'm1', role: 'assistant' as const, blocks: [] };

  /** Spy on the FlatList instance's scrollToEnd (the growth auto-snap). */
  function spyOnScrollToEnd(): jest.SpyInstance {
    const list = screen.UNSAFE_getByType(FlatList as never);
    return jest.spyOn(list.instance, 'scrollToEnd').mockImplementation(() => undefined);
  }
  function fireContentSize(height: number): void {
    const list = screen.UNSAFE_getByType(FlatList as never);
    act(() => list.props.onContentSizeChange(0, height));
  }

  it('renders the injected footer exactly once, inside the list content', () => {
    render(<MessageList messages={[msg]} footer={<Text testID="footer-probe">prompt</Text>} />);
    // Exactly one, and it is a descendant of the FlatList (scrollable content) — not a
    // sibling below it (the pre-fix layout that broke reaching Submit).
    expect(within(screen.getByTestId('message-list')).getAllByTestId('footer-probe')).toHaveLength(
      1
    );
  });

  // Issue #10 regression: with a prompt whose content overflows the viewport, an in-form
  // edit (toggling "Other" → a TextInput mounts → content grows) must NOT snap the list to
  // the bottom, or the just-revealed input flies off-screen. The run is paused during an
  // ask prompt, so `footerActive` marks "suppress the always-snap-on-growth".
  it('does NOT snap to the bottom on footer-internal growth while footerActive', () => {
    render(
      <MessageList
        messages={[msg]}
        footerActive
        footer={<Text testID="footer-probe">prompt</Text>}
        scheduleScroll={runScrollNow}
      />
    );
    const scrollToEnd = spyOnScrollToEnd();
    // The prompt first appearing is revealed ONCE (footerActive was already true at mount →
    // the initial 0→H growth is the reveal).
    fireContentSize(1200);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();
    // A later in-form growth (an "Other" input mounts) must be ignored — no yank.
    fireContentSize(1240);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('reveals the prompt with one snap when footerActive flips false→true', () => {
    const { rerender } = render(<MessageList messages={[msg]} scheduleScroll={runScrollNow} />);
    const scrollToEnd = spyOnScrollToEnd();
    fireContentSize(800); // steady-state measure (no prompt yet)
    scrollToEnd.mockClear();
    // Prompt appears → footerActive true → the next growth reveals it once…
    rerender(
      <MessageList
        messages={[msg]}
        footerActive
        footer={<Text testID="footer-probe">prompt</Text>}
        scheduleScroll={runScrollNow}
      />
    );
    fireContentSize(1100);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();
    // …and the following in-form growth is suppressed.
    fireContentSize(1140);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('still snaps on transcript growth when no prompt is active (footerActive falsy)', () => {
    render(<MessageList messages={[msg]} scheduleScroll={runScrollNow} />);
    const scrollToEnd = spyOnScrollToEnd();
    fireContentSize(800);
    scrollToEnd.mockClear();
    fireContentSize(1000); // a streamed block grows the transcript
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  // The measured-scroll math: positive = scroll down (content moves up),
  // negative = scroll up, 0 = already visible. 12px margin.
  describe('computeScrollIntoViewDelta', () => {
    const viewport = { top: 100, bottom: 500 };

    it('scrolls down when the target sits below the visible bottom', () => {
      expect(computeScrollIntoViewDelta({ top: 700, bottom: 736 }, viewport)).toBe(248);
    });

    it('scrolls up when the target sits above the visible top', () => {
      expect(computeScrollIntoViewDelta({ top: 60, bottom: 96 }, viewport)).toBe(-52);
    });

    it('does not scroll when the target is already fully visible', () => {
      expect(computeScrollIntoViewDelta({ top: 200, bottom: 236 }, viewport)).toBe(0);
    });

    it('honors the margin at the bottom edge (target flush with the fold)', () => {
      // Bottom at exactly the viewport bottom still needs the 12px margin.
      expect(computeScrollIntoViewDelta({ top: 464, bottom: 500 }, viewport)).toBe(12);
    });

    it('honors the margin at the top edge', () => {
      expect(computeScrollIntoViewDelta({ top: 104, bottom: 140 }, viewport)).toBe(-8);
    });

    it('prefers aligning the bottom when the target is taller than the viewport', () => {
      // Both edges violated (target 100..560 vs viewport 100..500): overBottom wins first,
      // scrolling down so the target's bottom + margin is visible (top spills above).
      expect(computeScrollIntoViewDelta({ top: 100, bottom: 560 }, viewport)).toBe(72);
    });

    it('honors a non-default margin argument', () => {
      expect(computeScrollIntoViewDelta({ top: 700, bottom: 736 }, viewport, 20)).toBe(256);
    });
  });
});
