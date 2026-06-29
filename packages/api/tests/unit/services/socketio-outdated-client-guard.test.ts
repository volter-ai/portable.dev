/**
 * Integration of the outdated-build kill switch INTO the Socket.IO
 * `chat:message` handler (SocketIOService.setupChatHandlers).
 *
 * The service primitives (`shouldBlockOutdatedClient`, `emitOutdatedClientNotice`)
 * are unit-tested in chat-session-lifecycle.test.ts. This file covers the thin —
 * but load-bearing — glue that the kill switch exists to drive:
 *   - the guard genuinely AWAITS the (async) flag check before deciding. A dropped
 *     `await` would make `if (Promise)` always truthy and block EVERY client; the
 *     "gate OFF ⇒ proceeds normally" case below fails loudly if the await is lost.
 *   - when blocked: the socket JOINS the room BEFORE the notice is emitted (else the
 *     sender never receives it), the ephemeral notice fires, `handleChatMessage`
 *     (persistence / user_message echo / execution) NEVER runs, and the ack succeeds.
 *   - when not blocked: `handleChatMessage` proceeds and NO notice is emitted.
 *
 * We capture the real handler by calling the private `setupChatHandlers` on a
 * prototype instance (no constructor → no io server / intervals) with a fake socket
 * that records `socket.on(...)` registrations, then invoke `chat:message` directly.
 */
import { describe, expect, it, mock } from 'bun:test';

import { SocketIOService } from '../../../src/services/SocketIOService';

/**
 * Build a SocketIOService whose `chat:message` handler is reachable, with the
 * collaborators the guard touches stubbed. `gateBlocks` drives
 * `shouldBlockOutdatedClient` (returned as a Promise so the test also exercises
 * the `await`). Returns the captured handler + spies + an ordered call log.
 */
function harness(gateBlocks: boolean) {
  const order: string[] = [];

  const shouldBlockOutdatedClient = mock(async () => gateBlocks);
  const emitOutdatedClientNotice = mock(() => {
    order.push('notice');
  });
  const handleChatMessage = mock(async () => {
    order.push('handleChatMessage');
    return {
      success: true,
      effectiveContent: 'hi',
      effectiveModel: 'sonnet',
      effectivePermissions: 'default',
      effectiveAgentSetupId: 'setup-1',
    };
  });
  const executeMessage = mock(async () => {});

  const chatExecutionService = {
    shouldBlockOutdatedClient,
    emitOutdatedClientNotice,
    handleChatMessage,
    executeMessage,
  } as any;

  const emit = mock(() => {});
  const io = { to: () => ({ emit }) } as any;

  // Prototype instance: real methods, no constructor (no io server, no intervals).
  const service: any = Object.create(SocketIOService.prototype);
  service.io = io;
  service.chatExecutionService = chatExecutionService;
  service.idleTimerService = undefined;
  // Own-property stubs shadow the prototype methods the handler calls.
  service.updateSocketActivity = () => {};
  service.buildExecutionContext = (_socket: any, chatId: string) => ({
    chatId,
    userId: 'alice@example.com',
    username: 'alice',
    authToken: 't',
    emitter: { emit: () => {} },
  });

  // Fake socket: records `on` registrations, tracks room membership + join order.
  const rooms = new Set<string>();
  const joined: string[] = [];
  const registrations: Record<string, (...args: any[]) => any> = {};
  const socket = {
    id: 'sock-1',
    data: { userEmail: 'alice@example.com', username: 'alice' },
    rooms,
    join: mock((room: string) => {
      order.push('join');
      joined.push(room);
      rooms.add(room);
    }),
    on: (event: string, handler: (...args: any[]) => any) => {
      registrations[event] = handler;
    },
  };

  service.setupChatHandlers(socket);
  const chatMessage = registrations['chat:message'];
  if (!chatMessage) throw new Error('chat:message handler was not registered');

  return {
    chatMessage,
    joined,
    order,
    spies: { shouldBlockOutdatedClient, emitOutdatedClientNotice, handleChatMessage, emit },
  };
}

describe('SocketIOService chat:message — kill-switch guard', () => {
  it('blocks an outdated client when the kill switch is ON: joins room → notice → no Claude run → ack', async () => {
    const h = harness(/* gateBlocks */ true);
    const callback = mock(() => {});

    await h.chatMessage({ chatId: 'chat-1', content: 'hello' }, callback);

    expect(h.spies.shouldBlockOutdatedClient).toHaveBeenCalledTimes(1);
    expect(h.spies.emitOutdatedClientNotice).toHaveBeenCalledTimes(1);
    // The block must NOT persist / echo / execute anything.
    expect(h.spies.handleChatMessage).not.toHaveBeenCalled();
    // Room joined so the ephemeral notice actually reaches the sender, BEFORE the emit.
    expect(h.joined).toEqual(['chat-1']);
    expect(h.order).toEqual(['join', 'notice']);
    expect(callback).toHaveBeenCalledWith({ success: true });
  });

  it('proceeds normally when the kill switch is OFF (catches a dropped await / inverted guard)', async () => {
    const h = harness(/* gateBlocks */ false);
    const callback = mock(() => {});

    await h.chatMessage({ chatId: 'chat-1', messageId: 'm1', content: 'hello' }, callback);

    expect(h.spies.shouldBlockOutdatedClient).toHaveBeenCalledTimes(1);
    // A dropped `await` would make `if (Promise)` truthy and wrongly block here.
    expect(h.spies.emitOutdatedClientNotice).not.toHaveBeenCalled();
    expect(h.spies.handleChatMessage).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ success: true });
  });
});
