/**
 * rev12 cross-surface presence (PRD D55) — mobile surface.
 *
 *  - `useRunningOnPc` / `RunningOnPcBadge`: joins the chat id against the
 *    `user:runtime_state` claudeSessions entries with `origin: 'terminal'`
 *    (a terminal session's chatId is its Claude Code session id == the
 *    discovered chat's id). Badge: "Running on PC" mid-turn, "Open on PC"
 *    between turns, nothing when no terminal session exists.
 *  - `useChatStream` external-turn refresh: a `chat:external_turn_completed`
 *    for the OPEN chat re-joins the room so the transcript hydrates the turn
 *    that streamed nowhere; other chats' turns don't disturb it.
 *  - `applyExternalMessages` (D62 mid-turn live-follow): pushed transcript rows
 *    (`chat:external_messages`) fold through the SAME reducers as the live
 *    stream, idempotently — a terminal turn renders like a local run.
 *  - `ClaudeSessionCard`: a terminal-origin session is labeled "Terminal".
 */

// Theme (mmkv-backed store) reaches native MMKV at first use — mock it
// (established pattern; any useAppTheme consumer needs this).
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    createMMKV: () => ({
      set: (k: string, v: string) => void store.set(k, v),
      getString: (k: string) => store.get(k),
      remove: (k: string) => void store.delete(k),
      clearAll: () => void store.clear(),
    }),
    MMKV: class {},
  };
});

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';

import { RunningOnPcBadge } from '../src/features/chat/RunningOnPcBadge';
import { RunningOnPcBanner } from '../src/features/chat/RunningOnPcBanner';
import { useChatMessagesStore } from '../src/features/chat/chatMessagesStore';
import { useChatStream } from '../src/features/chat/useChatStream';
import { useRunningOnPc } from '../src/features/chat/useRunningOnPc';
import { ClaudeSessionCard } from '../src/features/runtime/cards';
import { useSocketStore } from '../src/features/socket/socketStore';
import { useRuntimeStore } from '../src/features/state/runtimeStore';

import type { BufferedMessage, RuntimeClaudeSessionPayload } from '@vgit2/shared/types';

import { onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ApiProvider } from '../src/features/api/ApiProvider';
import { createQueryClient } from '../src/features/api/queryClient';
import type { RelayApiClient } from '../src/features/api/relayClient';

const terminalSession = (
  overrides: Partial<RuntimeClaudeSessionPayload> = {}
): RuntimeClaudeSessionPayload => ({
  chatId: 'sess-1',
  repoPath: '/repo',
  status: 'running',
  isProcessing: true,
  lastActivityAt: 1000,
  idleMs: 0,
  resumable: true,
  origin: 'terminal',
  ...overrides,
});

const applySessions = (claudeSessions: RuntimeClaudeSessionPayload[]) =>
  act(() =>
    useRuntimeStore.getState().applySnapshot({
      tunnels: [],
      processes: [],
      claudeSessions,
      claudeSessionIdleTtlMs: null,
    })
  );

afterEach(() => {
  act(() => {
    useRuntimeStore.getState().reset();
    useSocketStore.getState().reset();
  });
});

/** A fake NetInfo that reports online (ApiProvider bridges it into onlineManager). */
const NET_INFO_ONLINE = {
  addEventListener: (cb: (s: { isConnected: boolean }) => void) => {
    cb({ isConnected: true });
    return () => {};
  },
  fetch: async () => ({ isConnected: true }),
};

/** Mount a component under an ApiProvider with an injected fake relay client. */
function renderWithApi(node: ReactNode, post: RelayApiClient['post']) {
  const queryClient = createQueryClient();
  const client = { post } as unknown as RelayApiClient;
  const utils = render(
    <ApiProvider client={client} queryClient={queryClient} netInfo={NET_INFO_ONLINE as any}>
      {node}
    </ApiProvider>
  );
  return { ...utils, queryClient };
}

describe('useRunningOnPc (the id join)', () => {
  it('reports a terminal session for its chat id, and nothing for others', () => {
    applySessions([terminalSession()]);
    const { result } = renderHook(() => useRunningOnPc('sess-1'));
    expect(result.current).toEqual({ onPc: true, runningOnPc: true });

    const other = renderHook(() => useRunningOnPc('sess-2'));
    expect(other.result.current).toEqual({ onPc: false, runningOnPc: false });
  });

  it('an api-spawned (portable) session never matches — the chat run state covers those', () => {
    applySessions([terminalSession({ origin: 'portable' })]);
    const { result } = renderHook(() => useRunningOnPc('sess-1'));
    expect(result.current.onPc).toBe(false);
  });
});

describe('RunningOnPcBadge', () => {
  it('renders "Running on PC" while a terminal turn is in flight', () => {
    applySessions([terminalSession()]);
    render(<RunningOnPcBadge chatId="sess-1" />);
    expect(screen.getByText('Running on PC')).toBeTruthy();
  });

  it('renders "Open on PC" for a live-idle terminal session', () => {
    applySessions([terminalSession({ status: 'idle', isProcessing: false, idleMs: 5000 })]);
    render(<RunningOnPcBadge chatId="sess-1" />);
    expect(screen.getByText('Open on PC')).toBeTruthy();
  });

  it('renders nothing when the chat has no terminal session', () => {
    render(<RunningOnPcBadge chatId="sess-1" />);
    expect(screen.queryByTestId('chat-on-pc-sess-1')).toBeNull();
  });
});

describe('useChatStream external-turn refresh', () => {
  const makeSocket = () => ({
    joinChat: jest.fn(async () => ({ success: true, messages: [], status: 'completed' })),
    emitters: { markRead: jest.fn(async () => ({})) },
  });

  it('re-joins the room when a terminal turn completes for THIS chat', async () => {
    const socket = makeSocket();
    act(() => useSocketStore.getState().markConnected('sock-1'));

    renderHook(() => useChatStream(socket, 'sess-1'));
    await act(async () => {});
    expect(socket.joinChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSocketStore.getState().setLastExternalTurn('sess-1');
    });
    expect(socket.joinChat).toHaveBeenCalledTimes(2);
  });

  it("ignores another chat's completed terminal turn", async () => {
    const socket = makeSocket();
    act(() => useSocketStore.getState().markConnected('sock-1'));

    renderHook(() => useChatStream(socket, 'sess-1'));
    await act(async () => {});
    expect(socket.joinChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSocketStore.getState().setLastExternalTurn('sess-OTHER');
    });
    expect(socket.joinChat).toHaveBeenCalledTimes(1);
  });
});

describe('applyExternalMessages (D62 mid-turn live-follow)', () => {
  afterEach(() => act(() => useChatMessagesStore.getState().reset()));

  const rows: BufferedMessage[] = [
    { id: 3, type: 'user_message', data: { content: 'terminal prompt' }, timestamp: 3000 },
    {
      id: 4,
      type: 'claude_code_block',
      data: { type: 'text', content: 'working on it', blockId: 'b4' },
      timestamp: 4000,
    },
    {
      id: 5,
      type: 'claude_code_block',
      data: {
        type: 'tool_use',
        id: 'tu-1',
        blockId: 'tu-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      timestamp: 5000,
    },
    {
      id: 6,
      type: 'claude_code_block',
      data: { type: 'tool_result', id: 'tu-1', blockId: 'tu-1:result', content: 'ok' },
      timestamp: 6000,
    },
  ];

  it('folds pushed transcript rows through the live-stream reducers', () => {
    act(() => useChatMessagesStore.getState().applyExternalMessages('sess-1', rows));

    const messages = useChatMessagesStore.getState().getMessages('sess-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'terminal prompt', id: '3' });
    expect(messages[1].role).toBe('assistant');
    // text + tool_use + the tool_result attached to its matching tool_use
    expect((messages[1].blocks ?? []).map((b) => b.type)).toEqual([
      'text',
      'tool_use',
      'tool_result',
    ]);
  });

  it('re-applying the same batch is idempotent (overlap with the Stop-hook refresh)', () => {
    act(() => {
      useChatMessagesStore.getState().applyExternalMessages('sess-1', rows);
      useChatMessagesStore.getState().applyExternalMessages('sess-1', rows);
    });

    const messages = useChatMessagesStore.getState().getMessages('sess-1');
    expect(messages).toHaveLength(2);
    expect(messages[1].blocks ?? []).toHaveLength(3);
  });

  it('skips unknown row types and rows without content (forward-compatible)', () => {
    act(() =>
      useChatMessagesStore.getState().applyExternalMessages('sess-1', [
        { id: 1, type: 'mystery_row', data: { anything: true }, timestamp: 1000 },
        { id: 2, type: 'user_message', data: {}, timestamp: 2000 },
      ] as BufferedMessage[])
    );
    expect(useChatMessagesStore.getState().getMessages('sess-1')).toHaveLength(0);
  });
});

describe('RunningOnPcBanner (Stop on PC — D60)', () => {
  it('renders nothing when the chat has no terminal session', () => {
    const post = jest.fn();
    renderWithApi(<RunningOnPcBanner chatId="sess-1" />, post as any);
    expect(screen.queryByTestId('running-on-pc-banner-sess-1')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('POSTs stop-on-pc(end) and shows the continue-here notice on a confirmed stop', async () => {
    applySessions([terminalSession()]);
    const post = jest.fn(async () => ({ stopped: true, reason: 'stopped' }));
    const { queryClient } = renderWithApi(<RunningOnPcBanner chatId="sess-1" />, post as any);

    fireEvent.press(screen.getByTestId('stop-on-pc'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/chat/sess-1/stop-on-pc', { mode: 'end' })
    );
    await waitFor(() =>
      expect(screen.getByTestId('stop-on-pc-notice')).toHaveTextContent(/continues here/i)
    );

    queryClient.clear();
    onlineManager.setOnline(true);
  });

  it('warns that a send will fork when the stop is not confirmed', async () => {
    applySessions([terminalSession()]);
    const post = jest.fn(async () => ({ stopped: false, reason: 'not-confirmed' }));
    const { queryClient } = renderWithApi(<RunningOnPcBanner chatId="sess-1" />, post as any);

    fireEvent.press(screen.getByTestId('stop-on-pc'));
    await waitFor(() =>
      expect(screen.getByTestId('stop-on-pc-notice')).toHaveTextContent(/fork a copy/i)
    );

    queryClient.clear();
    onlineManager.setOnline(true);
  });
});

describe('ClaudeSessionCard origin label', () => {
  it('labels a terminal-origin session "Terminal"', () => {
    render(
      <ClaudeSessionCard session={terminalSession()} testID="runtime-claude-session-sess-1" />
    );
    expect(screen.getByText('Terminal')).toBeTruthy();
  });

  it('shows no origin label for an api-spawned session', () => {
    render(
      <ClaudeSessionCard
        session={terminalSession({ origin: 'portable' })}
        testID="runtime-claude-session-sess-1"
      />
    );
    expect(screen.queryByText('Terminal')).toBeNull();
  });
});
