/**
 * Fork-on-first-write — `ChatExecutionService.handleChatMessage` fork branch.
 *
 * When the first message targets a Claude-Code-originated chat (a *discovered*
 * transcript with no Portable row), `handleChatMessage` must:
 *   - mint a NEW Portable chat id,
 *   - claim a real row carrying `forkSourceSessionId` (+ repoPath = the source cwd,
 *     repoFullName) with session_id still null,
 *   - emit `chat:created` + `chat:forked` and join the user to the new room,
 *   - buffer the user message + return the NEW chat id.
 * A normal (sqlite-origin) chat is untouched: same id, no fork emits.
 *
 * Boundary: a fake ChatService + emitter only — handleChatMessage touches no DB / SDK.
 */
import { describe, it, expect } from 'bun:test';

import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import type { ChatOrigin } from '../../../src/db/DbAdapter';
import type { ExecutionContext } from '../../../src/services/types/ExecutionContext';

function makeService(origin: ChatOrigin) {
  const saveChatCalls: any[] = [];
  const bufferCalls: any[] = [];
  const fakeChatService: any = {
    getChatOrigin: async () => origin,
    saveChat: async (opts: any) => {
      saveChatCalls.push(opts);
      return true;
    },
    // After a claim, getChat(newId) returns a minimal row (no autopilot).
    getChat: async (chatId: string) => ({
      id: chatId,
      model: 'opus',
      permissions: 'default',
      agent_setup_id: 'freestyle',
    }),
    bufferMessage: async (...args: any[]) => {
      bufferCalls.push(args);
    },
  };

  const emitted: Array<{ event: string; payload: any }> = [];
  const joinedRooms: string[] = [];
  const emitter: any = {
    emit: () => {},
    emitToUser: (_userId: string, event: string, payload: any) => emitted.push({ event, payload }),
    joinUserToRoom: (_userId: string, room: string) => joinedRooms.push(room),
  };

  const svc = new ChatExecutionService(
    fakeChatService,
    {} as any, // claudeService — unused by handleChatMessage
    {} as any, // gitLocalService
    {} as any, // messageDeduplicationService
    undefined, // tunnelService
    undefined, // processTrackerService
    undefined, // dbAdapter
    undefined, // pushNotificationService
    undefined // sopService
  );

  const context = {
    chatId: 'ignored',
    userId: 'user-1',
    username: 'user-1',
    authToken: 'tok',
    emitter,
  } as unknown as ExecutionContext;

  return { svc, context, saveChatCalls, bufferCalls, emitted, joinedRooms };
}

describe('fork-on-first-write — handleChatMessage', () => {
  it('forks a discovered Claude Code chat into a new Portable chat', async () => {
    const { svc, context, saveChatCalls, bufferCalls, emitted, joinedRooms } = makeService({
      origin: 'discovered',
      sourceSessionId: 'src-sess',
      cwd: '/ws/clock-app',
      repoPath: '/ws/clock-app',
      repoFullName: 'me/clock-app',
      title: 'Existing CC chat',
    });

    const result = await svc.handleChatMessage(context, {
      chatId: 'src-sess', // the discovered chat == its session id
      content: 'continue please',
    });

    expect(result.success).toBe(true);
    // A NEW Portable id, distinct from the original CC session id.
    expect(result.chatId).toBeDefined();
    expect(result.chatId).not.toBe('src-sess');
    expect(result.chatId!.startsWith('chat-')).toBe(true);

    // The claim row carries the fork source + repo identity, session_id left unset.
    expect(saveChatCalls).toHaveLength(1);
    const claim = saveChatCalls[0];
    expect(claim.chatId).toBe(result.chatId);
    expect(claim.forkSourceSessionId).toBe('src-sess');
    expect(claim.repoPath).toBe('/ws/clock-app');
    expect(claim.repoFullName).toBe('me/clock-app');
    expect(claim.sessionId).toBeUndefined();

    // The client is told to navigate (chat:forked) + the new chat appears (chat:created).
    const events = emitted.map((e) => e.event);
    expect(events).toContain('chat:created');
    expect(events).toContain('chat:forked');
    const forked = emitted.find((e) => e.event === 'chat:forked')!;
    expect(forked.payload).toEqual({ oldChatId: 'src-sess', newChatId: result.chatId });
    expect(joinedRooms).toContain(result.chatId);

    // The user message is buffered under the NEW id (not the original CC id).
    expect(bufferCalls.length).toBeGreaterThan(0);
    expect(bufferCalls[0][1]).toBe(result.chatId); // (userId, chatId, type, …)
  });

  it('does NOT fork a normal Portable chat (sqlite origin)', async () => {
    const { svc, context, saveChatCalls, bufferCalls, emitted } = makeService({ origin: 'sqlite' });

    const result = await svc.handleChatMessage(context, {
      chatId: 'chat-existing',
      content: 'hello',
    });

    expect(result.success).toBe(true);
    expect(result.chatId).toBe('chat-existing'); // unchanged
    expect(saveChatCalls).toHaveLength(0); // no claim
    expect(emitted.map((e) => e.event)).not.toContain('chat:forked');
    expect(bufferCalls[0][1]).toBe('chat-existing');
  });
});

describe('fork-on-first-write — executeMessage chokepoint (non-socket callers)', () => {
  it('forks a discovered chat before resuming, retargeting downstream to the new id', async () => {
    // The durability guard: a caller that BYPASSES handleChatMessage (e.g. the
    // portable_execute cross-chat send) must still never resume a CC transcript.
    const saveChatCalls: any[] = [];
    let restoreCalledWith: string | null = null;

    const fakeChatService: any = {
      getChatOrigin: async (): Promise<ChatOrigin> => ({
        origin: 'discovered',
        sourceSessionId: 'cc-src',
        cwd: '/ws/app',
        repoPath: '/ws/app',
        repoFullName: 'me/app',
        title: 'CC chat',
      }),
      saveChat: async (opts: any) => {
        saveChatCalls.push(opts);
        return true;
      },
      getChat: async (chatId: string) => ({
        id: chatId,
        model: 'opus',
        permissions: 'default',
        agent_setup_id: 'freestyle',
      }),
      bufferMessage: async () => {},
    };

    const emitted: string[] = [];
    const emitter: any = {
      emit: () => {},
      emitToUser: (_userId: string, event: string) => emitted.push(event),
      joinUserToRoom: () => {},
    };

    // Stop the flow right after retargeting (before the heavy startNewSession path) by
    // throwing a sentinel from the first downstream call, capturing the chatId it saw.
    const fakeClaudeService: any = {
      restoreSessionFromDatabase: async (chatId: string) => {
        restoreCalledWith = chatId;
        throw new Error('__STOP__');
      },
    };
    const fakeDedup: any = { isDuplicate: () => false, addHash: () => {} };

    const svc = new ChatExecutionService(
      fakeChatService,
      fakeClaudeService,
      {} as any, // gitLocalService
      fakeDedup,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );

    const context = {
      chatId: 'cc-src',
      userId: 'user-1',
      username: 'user-1',
      authToken: 'tok',
      emitter,
    } as unknown as ExecutionContext;

    await expect(svc.executeMessage(context, { content: 'hi' }, {})).rejects.toThrow('__STOP__');

    // A new Portable chat was claimed from the CC source...
    expect(saveChatCalls).toHaveLength(1);
    const newId = saveChatCalls[0].chatId as string;
    expect(newId.startsWith('chat-')).toBe(true);
    expect(saveChatCalls[0].forkSourceSessionId).toBe('cc-src');
    // ...and every downstream step targets the NEW id, never the CC session id.
    expect(restoreCalledWith).toBe(newId);
    expect(restoreCalledWith).not.toBe('cc-src');
    expect(emitted).toContain('chat:forked');
  });
});
