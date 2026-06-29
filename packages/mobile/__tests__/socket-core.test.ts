/**
 * Integration test for the transport-agnostic Socket.IO core
 * (`@vgit2/shared/socket`) — the single source of truth this React Native
 * client consumes.
 *
 * Covers acceptance criteria:
 *  - `createSocket(authToken, baseUrl, opts)` merges baseline + injected options
 *    and sets the handshake auth token (platform lifecycle injected, not baked in).
 *  - Every named emit helper emits the expected event name with its payload shape
 *    and honours the callback-ack contract (resolves with the server ack).
 *  - Fire-and-forget helpers (`answerUserQuestion`) emit without an ack and
 *    report whether a socket was available.
 *  - `emitWithAck` rejects with "Socket not connected" when there is no socket.
 *  - Injected platform-lifecycle hooks fire dedup (`isSequentialDuplicate`) /
 *    consolidation (`consolidateToolMessages`) correctly.
 *
 * `socket.io-client` is mocked (virtual) so `createSocket()` can be exercised
 * without opening a real transport or hitting raw-ESM transform issues.
 */

// Hoisted above imports by babel-plugin-jest-hoist.
jest.mock(
  'socket.io-client',
  () => {
    const mockIo = jest.fn(() => ({
      connected: true,
      id: 'io-mock-socket',
      emit: jest.fn(),
      on: jest.fn(),
    }));
    return { __esModule: true, io: mockIo, default: mockIo };
  },
  { virtual: true }
);

import {
  CLIENT_EVENTS,
  consolidateToolMessages,
  createSocket,
  createSocketEmitters,
  emitWithAck,
  isSequentialDuplicate,
  type SocketLike,
} from '@vgit2/shared/socket';
import type { ChatMessage } from '@vgit2/shared/types';

/** A recording mock socket that auto-acks with `{ success: true }` (or an override). */
function createMockSocket(ackByEvent: Record<string, unknown> = {}) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket: SocketLike = {
    connected: true,
    id: 'mock-socket',
    emit: jest.fn((event: string, ...args: unknown[]) => {
      const last = args[args.length - 1];
      const hasAck = typeof last === 'function';
      emitted.push({ event, payload: args[0] });
      if (hasAck) {
        const ack = event in ackByEvent ? ackByEvent[event] : { success: true };
        (last as (a: unknown) => void)(ack);
      }
      return socket;
    }),
    on: jest.fn(),
  };
  return { socket, emitted };
}

describe('createSocket()', () => {
  // Resolved from the virtual mock above; a plain string arg so TS doesn't need
  // `socket.io-client` to be resolvable from this package.
  const mockedIo = (jest.requireMock('socket.io-client') as { io: jest.Mock }).io;

  beforeEach(() => mockedIo.mockClear());

  it('merges baseline options with injected platform overrides and sets auth token', () => {
    createSocket('jwt-token', '/', {
      reconnectionAttempts: 5,
      withCredentials: true,
    });

    expect(mockedIo).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedIo.mock.calls[0];
    expect(url).toBe('/');
    expect(opts).toMatchObject({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      upgrade: true,
      rememberUpgrade: true,
      closeOnBeforeunload: false,
      // injected platform-specific bits:
      reconnectionAttempts: 5,
      withCredentials: true,
      auth: { token: 'jwt-token' },
    });
  });

  it('coerces a null token to an empty handshake token', () => {
    createSocket(null, 'https://sandbox.example', {});
    const [, opts] = mockedIo.mock.calls[0];
    expect(opts.auth).toEqual({ token: '' });
  });

  it('lets an explicit auth override win over the token argument', () => {
    createSocket('ignored', '/', { auth: { token: 'override' } });
    const [, opts] = mockedIo.mock.calls[0];
    expect(opts.auth).toEqual({ token: 'override' });
  });
});

describe('emit helpers (ack contract)', () => {
  it('emitWithAck resolves with the server ack', async () => {
    const { socket } = createMockSocket({ ping: { success: true, pong: 1 } });
    await expect(emitWithAck(socket, 'ping', {})).resolves.toEqual({ success: true, pong: 1 });
  });

  it('emitWithAck rejects when there is no socket', async () => {
    await expect(emitWithAck(null, 'ping', {})).rejects.toThrow('Socket not connected');
  });

  // Each named ack-based helper: emits the right event name with the given
  // payload AND resolves once the server acks.
  const ackCases: Array<{
    name: string;
    event: string;
    invoke: (e: ReturnType<typeof createSocketEmitters>) => Promise<unknown>;
    payload: unknown;
  }> = [
    {
      name: 'createChat',
      event: CLIENT_EVENTS.CHAT_CREATE,
      payload: { chatId: 'c1', type: 'claude_code', title: 't', owner: 'o', repo: 'r' },
      invoke: (e) =>
        e.createChat({ chatId: 'c1', type: 'claude_code', title: 't', owner: 'o', repo: 'r' }),
    },
    {
      name: 'joinChat',
      event: CLIENT_EVENTS.CHAT_JOIN,
      payload: { chatId: 'c1', count: 5 },
      invoke: (e) => e.joinChat({ chatId: 'c1', count: 5 }),
    },
    {
      name: 'loadMore',
      event: CLIENT_EVENTS.CHAT_LOAD_MORE,
      payload: { chatId: 'c1', afterId: 10, limit: 25 },
      invoke: (e) => e.loadMore({ chatId: 'c1', afterId: 10, limit: 25 }),
    },
    {
      name: 'sendMessage',
      event: CLIENT_EVENTS.CHAT_MESSAGE,
      payload: { chatId: 'c1', content: 'hello' },
      invoke: (e) => e.sendMessage({ chatId: 'c1', content: 'hello' }),
    },
    {
      name: 'interruptClaude',
      event: CLIENT_EVENTS.CLAUDE_INTERRUPT,
      payload: { chatId: 'c1' },
      invoke: (e) => e.interruptClaude({ chatId: 'c1' }),
    },
    {
      name: 'respondToPermission',
      event: CLIENT_EVENTS.PERMISSION_RESPOND,
      payload: { requestId: 'r1', chatId: 'c1', approved: true },
      invoke: (e) => e.respondToPermission({ requestId: 'r1', chatId: 'c1', approved: true }),
    },
    {
      name: 'markRead',
      event: CLIENT_EVENTS.CHAT_MARK_READ,
      payload: { chatId: 'c1', messageId: 7 },
      invoke: (e) => e.markRead({ chatId: 'c1', messageId: 7 }),
    },
    {
      name: 'updateSettings',
      event: CLIENT_EVENTS.CHAT_UPDATE_SETTINGS,
      payload: { chatId: 'c1', settings: { model: 'sonnet', permissions: 'default' } },
      invoke: (e) =>
        e.updateSettings({ chatId: 'c1', settings: { model: 'sonnet', permissions: 'default' } }),
    },
    {
      name: 'submitSecrets',
      event: CLIENT_EVENTS.SECRETS_SUBMIT,
      payload: { chatId: 'c1', secrets: { API_KEY: 'x' } },
      invoke: (e) => e.submitSecrets({ chatId: 'c1', secrets: { API_KEY: 'x' } }),
    },
    {
      name: 'cancelSecrets',
      event: CLIENT_EVENTS.SECRETS_CANCEL,
      payload: { chatId: 'c1' },
      invoke: (e) => e.cancelSecrets({ chatId: 'c1' }),
    },
  ];

  it.each(ackCases)(
    '$name emits $event with its payload and resolves on ack',
    async ({ event, payload, invoke }) => {
      const { socket, emitted } = createMockSocket();
      const emitters = createSocketEmitters(() => socket);

      await expect(invoke(emitters)).resolves.toBeDefined();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe(event);
      expect(emitted[0].payload).toEqual(payload);
    }
  );

  it('binds emitters lazily to the current socket (survives socket swap)', async () => {
    let current: SocketLike | null = null;
    const emitters = createSocketEmitters(() => current);

    await expect(emitters.ping()).rejects.toThrow('Socket not connected');

    const { socket, emitted } = createMockSocket();
    current = socket;
    await expect(emitters.ping()).resolves.toEqual({ success: true });
    expect(emitted[0].event).toBe(CLIENT_EVENTS.PING);
  });
});

describe('fire-and-forget helpers', () => {
  it('answerUserQuestion emits answer_user_question without an ack', () => {
    const { socket, emitted } = createMockSocket();
    const emitters = createSocketEmitters(() => socket);

    const payload = {
      type: 'answer_user_question' as const,
      request_id: 'r1',
      chat_id: 'c1',
      answers: { '0': ['Yes'] },
    };
    const sent = emitters.answerUserQuestion(payload);

    expect(sent).toBe(true);
    expect(emitted).toEqual([{ event: CLIENT_EVENTS.ANSWER_USER_QUESTION, payload }]);
    // No ack callback was passed.
    expect((socket.emit as jest.Mock).mock.calls[0]).toHaveLength(2);
  });
});

describe('injected platform-lifecycle dedup/consolidation', () => {
  it('consolidateToolMessages attaches tool_result to its tool_use and drops orphans', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash' }],
      },
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_result', id: 't1', content: 'done', is_error: false }],
      },
    ] as unknown as ChatMessage[];

    const out = consolidateToolMessages(messages);

    // The orphaned tool_result-only message is dropped.
    expect(out).toHaveLength(1);
    const toolUse = out[0].blocks?.[0] as unknown as {
      type: string;
      result?: { content: unknown };
    };
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.result?.content).toBe('done');
  });

  it('isSequentialDuplicate flags identical consecutive messages only', () => {
    const a: ChatMessage = { role: 'user', content: 'hi', timestamp: 1000 };
    const dup: ChatMessage = { role: 'user', content: 'hi', timestamp: 1000 };
    const different: ChatMessage = { role: 'user', content: 'hi', timestamp: 1001 };

    expect(isSequentialDuplicate(a, dup)).toBe(true);
    expect(isSequentialDuplicate(a, different)).toBe(false);
  });

  it('a platform resume hook re-consolidates buffered messages and dedups the tail', () => {
    // Simulate the injected lifecycle: on resume/reconnect the platform layer
    // re-syncs buffered messages, consolidating tool blocks and skipping a
    // sequential duplicate of the last visible message.
    const existing: ChatMessage[] = [{ role: 'user', content: 'run it', timestamp: 1 }];

    const buffered = [
      { role: 'user', content: 'run it', timestamp: 1 }, // sequential duplicate of existing tail
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_use', id: 'tx', name: 'Bash' }],
      },
      {
        role: 'assistant',
        content: '',
        blocks: [{ type: 'tool_result', id: 'tx', content: 'ok' }],
      },
    ] as unknown as ChatMessage[];

    const onResume = (current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
      const consolidated = consolidateToolMessages(incoming);
      const merged = [...current];
      for (const msg of consolidated) {
        const last = merged[merged.length - 1];
        if (last && isSequentialDuplicate(last, msg)) continue;
        merged.push(msg);
      }
      return merged;
    };

    const result = onResume(existing, buffered);

    // duplicate "run it" skipped + orphan tool_result dropped → existing + 1 tool_use msg
    expect(result).toHaveLength(2);
    const toolUse = result[1].blocks?.[0] as unknown as {
      type: string;
      result?: { content: unknown };
    };
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.result?.content).toBe('ok');
  });
});
