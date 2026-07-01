/**
 * Unit tests for the chat process lifecycle feature:
 *   - SessionReaperService: time-based idle reaping.
 *   - SessionHandler.getClaudeSessionInfos: runtime-panel enumeration.
 *   - ChatExecutionService.handleKillSession: user-initiated kill + ownership.
 *
 * These are pure-logic tests over in-memory session maps + spies — they live in
 * the `unit` shard (scripts/test-shard.sh).
 */
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';

import { OUTDATED_APP_MESSAGE } from '../../../src/constants/outdatedClient';
import { ChatExecutionService } from '../../../src/services/ChatExecutionService';
import { SessionHandler } from '../../../src/services/ClaudeService/handlers/SessionHandler';
import {
  SessionReaperService,
  getClaudeSessionIdleTtlMs,
} from '../../../src/services/SessionReaperService';

const NOW = 1_000_000_000_000;
const TTL = 10 * 60 * 1000; // 10 minutes

/** A live, idle (between-turns) session — the reap target. */
function liveIdleSession(overrides: Record<string, any> = {}) {
  return {
    userId: 'alice@example.com',
    repo_path: '/ws/acme/widget',
    session_id: 'sid-1',
    query: {}, // truthy → live subprocess
    inputQueue: {}, // truthy → live subprocess
    isProcessing: false,
    signal: { stopped: false },
    lastActivityAt: NOW - TTL - 5000, // idle past the TTL
    ...overrides,
  };
}

describe('SessionReaperService', () => {
  function makeReaper(sessions: Map<string, any>) {
    const stopSession = mock(async (_chatId: string, _userId?: string) => true);
    const onReap = mock((_userId: string, _chatId: string, _idleMs: number) => {});
    const reaper = new SessionReaperService({
      claudeService: { getAllSessions: () => sessions, stopSession },
      onReap,
      ttlMs: TTL,
      now: () => NOW,
    });
    return { reaper, stopSession, onReap };
  }

  it('reaps a live session idle beyond the TTL (and preserves it via stopSession, not delete)', async () => {
    const sessions = new Map([['chat-1', liveIdleSession()]]);
    const { reaper, stopSession, onReap } = makeReaper(sessions);

    const reaped = await reaper.reapOnce();

    expect(reaped).toEqual(['chat-1']);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith('chat-1', 'alice@example.com');
    // stopSession (not removeSession) → session_id is preserved for resume.
    expect(sessions.has('chat-1')).toBe(true);
    expect(onReap).toHaveBeenCalledTimes(1);
    const [userId, chatId, idleMs] = onReap.mock.calls[0];
    expect(userId).toBe('alice@example.com');
    expect(chatId).toBe('chat-1');
    expect(idleMs).toBeGreaterThan(TTL);
  });

  it('does NOT reap a session that is actively processing (running/waiting)', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ isProcessing: true })]]);
    const { reaper, stopSession } = makeReaper(sessions);

    expect(await reaper.reapOnce()).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('does NOT reap a session idle for less than the TTL', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ lastActivityAt: NOW - (TTL - 1000) })]]);
    const { reaper, stopSession } = makeReaper(sessions);

    expect(await reaper.reapOnce()).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('does NOT reap a torn-down (non-live) session — only a session_id string remains', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ query: null, inputQueue: undefined })]]);
    const { reaper, stopSession } = makeReaper(sessions);

    expect(await reaper.reapOnce()).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('does NOT reap a session already stopping (signal.stopped)', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ signal: { stopped: true } })]]);
    const { reaper, stopSession } = makeReaper(sessions);

    expect(await reaper.reapOnce()).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('does NOT reap a session with no recorded lastActivityAt', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ lastActivityAt: undefined })]]);
    const { reaper, stopSession } = makeReaper(sessions);

    expect(await reaper.reapOnce()).toEqual([]);
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('reaps multiple eligible sessions and skips ineligible ones in one pass', async () => {
    const sessions = new Map<string, any>([
      ['idle-old', liveIdleSession()],
      ['running', liveIdleSession({ isProcessing: true })],
      ['idle-old-2', liveIdleSession({ userId: 'bob@example.com' })],
      ['fresh', liveIdleSession({ lastActivityAt: NOW - 1000 })],
    ]);
    const { reaper, stopSession } = makeReaper(sessions);

    const reaped = await reaper.reapOnce();

    expect(reaped.sort()).toEqual(['idle-old', 'idle-old-2']);
    expect(stopSession).toHaveBeenCalledTimes(2);
  });
});

describe('SessionReaperService.start() — runs unconditionally', () => {
  // Unlike the idle-shutdown / OOM-kill guards (which self-terminated the host and
  // were deleted in local-first), SessionReaper is a SAFE reclaim — stopSession
  // preserves session_id for instant resume — so it always runs. The earlier
  // sandbox gate was removed; start() reads no deployment mode and arms
  // its timer unconditionally.
  function makeReaper() {
    return new SessionReaperService({
      claudeService: { getAllSessions: () => new Map(), stopSession: async () => true },
      onReap: () => {},
      ttlMs: TTL,
      now: () => NOW,
    });
  }

  it('start() arms the reaper timer', () => {
    const reaper = makeReaper();

    reaper.start();

    expect((reaper as any).timer).not.toBeNull();
    reaper.stop();
  });
});

describe('getClaudeSessionIdleTtlMs', () => {
  const original = process.env.CLAUDE_SESSION_IDLE_TTL_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_SESSION_IDLE_TTL_MS;
    else process.env.CLAUDE_SESSION_IDLE_TTL_MS = original;
  });

  it('defaults to 10 minutes when unset', () => {
    delete process.env.CLAUDE_SESSION_IDLE_TTL_MS;
    expect(getClaudeSessionIdleTtlMs()).toBe(10 * 60 * 1000);
  });

  it('reads a valid positive env override', () => {
    process.env.CLAUDE_SESSION_IDLE_TTL_MS = '120000';
    expect(getClaudeSessionIdleTtlMs()).toBe(120000);
  });

  it('falls back to the default for an invalid/non-positive value', () => {
    process.env.CLAUDE_SESSION_IDLE_TTL_MS = 'nope';
    expect(getClaudeSessionIdleTtlMs()).toBe(10 * 60 * 1000);
    process.env.CLAUDE_SESSION_IDLE_TTL_MS = '0';
    expect(getClaudeSessionIdleTtlMs()).toBe(10 * 60 * 1000);
  });
});

describe('SessionHandler.getClaudeSessionInfos', () => {
  function makeHandler(sessions: Map<string, any>, permissionRequests = new Map<string, any>()) {
    return new SessionHandler(
      { chatService: {} } as any,
      sessions as any,
      permissionRequests as any,
      new Map()
    );
  }

  it('maps a between-turns session to status "idle" with computed idleMs', () => {
    const sessions = new Map([['chat-1', liveIdleSession()]]);
    const infos = makeHandler(sessions).getClaudeSessionInfos('alice@example.com', NOW);

    expect(infos).toHaveLength(1);
    const info = infos[0];
    expect(info.chatId).toBe('chat-1');
    expect(info.status).toBe('idle');
    expect(info.isProcessing).toBe(false);
    expect(info.repoPath).toBe('/ws/acme/widget');
    expect(info.resumable).toBe(true);
    expect(info.idleMs).toBe(NOW - (NOW - TTL - 5000));
  });

  it('maps an actively-generating session to status "running" with idleMs 0', () => {
    const sessions = new Map([['chat-1', liveIdleSession({ isProcessing: true })]]);
    const infos = makeHandler(sessions).getClaudeSessionInfos('alice@example.com', NOW);

    expect(infos[0].status).toBe('running');
    expect(infos[0].isProcessing).toBe(true);
    expect(infos[0].idleMs).toBe(0);
  });

  it('maps a permission-blocked session to status "waiting"', () => {
    const sessions = new Map([['chat-1', liveIdleSession({ isProcessing: true })]]);
    const permissionRequests = new Map([
      [
        'req-1',
        { chatId: 'chat-1', toolName: 'Bash', toolInput: {}, timestamp: NOW, resolve: () => {} },
      ],
    ]);
    const infos = makeHandler(sessions, permissionRequests).getClaudeSessionInfos(
      'alice@example.com',
      NOW
    );

    expect(infos[0].status).toBe('waiting');
  });

  it('only returns sessions belonging to the requesting user', () => {
    const sessions = new Map<string, any>([
      ['mine', liveIdleSession()],
      ['theirs', liveIdleSession({ userId: 'bob@example.com' })],
    ]);
    const infos = makeHandler(sessions).getClaudeSessionInfos('alice@example.com', NOW);

    expect(infos.map((i) => i.chatId)).toEqual(['mine']);
  });

  it('excludes torn-down (non-live) and stopping sessions', () => {
    const sessions = new Map<string, any>([
      ['dormant', liveIdleSession({ query: null, inputQueue: undefined })],
      ['stopping', liveIdleSession({ signal: { stopped: true } })],
      ['live', liveIdleSession()],
    ]);
    const infos = makeHandler(sessions).getClaudeSessionInfos('alice@example.com', NOW);

    expect(infos.map((i) => i.chatId)).toEqual(['live']);
  });

  it('reports resumable=false when there is no session_id yet', () => {
    const sessions = new Map([['chat-1', liveIdleSession({ session_id: null })]]);
    const infos = makeHandler(sessions).getClaudeSessionInfos('alice@example.com', NOW);

    expect(infos[0].resumable).toBe(false);
  });
});

describe('SessionHandler.switchSessionModel', () => {
  function makeHandler(sessions: Map<string, any>) {
    return new SessionHandler({ chatService: {} } as any, sessions as any, new Map(), new Map());
  }

  it('calls the live query.setModel() and updates session.model, without stopping the session', async () => {
    const setModel = mock(async (_model?: string) => {});
    const sessions = new Map([
      ['chat-1', liveIdleSession({ model: 'sonnet', query: { setModel } })],
    ]);
    const handler = makeHandler(sessions);

    const switched = await handler.switchSessionModel('chat-1', 'haiku');

    expect(switched).toBe(true);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('haiku');
    // Session stays live in the map — no stop/removal.
    expect(sessions.get('chat-1')!.query).toBeDefined();
    expect(sessions.get('chat-1')!.model).toBe('haiku');
  });

  it('returns false for a chat with no session', async () => {
    const handler = makeHandler(new Map());

    expect(await handler.switchSessionModel('missing-chat', 'haiku')).toBe(false);
  });

  it('returns false for a torn-down (non-live) session — only a session_id string remains', async () => {
    const sessions = new Map([
      ['chat-1', liveIdleSession({ model: 'sonnet', query: null, inputQueue: undefined })],
    ]);
    const handler = makeHandler(sessions);

    expect(await handler.switchSessionModel('chat-1', 'haiku')).toBe(false);
    expect(sessions.get('chat-1')!.model).toBe('sonnet'); // unchanged
  });

  it('returns false when the live query has no setModel control method (older SDK)', async () => {
    const sessions = new Map([['chat-1', liveIdleSession({ model: 'sonnet', query: {} })]]);
    const handler = makeHandler(sessions);

    expect(await handler.switchSessionModel('chat-1', 'haiku')).toBe(false);
    expect(sessions.get('chat-1')!.model).toBe('sonnet'); // unchanged
  });

  it('returns false and leaves session.model unchanged when the SDK call throws', async () => {
    const setModel = mock(async (_model?: string) => {
      throw new Error('control request failed');
    });
    const sessions = new Map([
      ['chat-1', liveIdleSession({ model: 'sonnet', query: { setModel } })],
    ]);
    const handler = makeHandler(sessions);

    expect(await handler.switchSessionModel('chat-1', 'haiku')).toBe(false);
    expect(sessions.get('chat-1')!.model).toBe('sonnet'); // unchanged — caller falls back to restart
  });

  it('serializes overlapping calls for the same chat — the second returns false instead of racing a conflicting setModel()', async () => {
    // Two devices switch the same chat's model within the same tick. The
    // first setModel() call is held open; the second call must not fire its
    // own conflicting setModel() while the first is still in flight.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const setModel = mock(async (_model?: string) => {
      await gate;
    });
    const sessions = new Map([
      ['chat-1', liveIdleSession({ model: 'sonnet', query: { setModel } })],
    ]);
    const handler = makeHandler(sessions);

    const first = handler.switchSessionModel('chat-1', 'haiku');
    const second = await handler.switchSessionModel('chat-1', 'opus');

    expect(second).toBe(false); // rejected immediately — no second setModel call
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('haiku');
    expect(sessions.get('chat-1')!.model).toBe('sonnet'); // not yet switched — first still pending

    releaseFirst();
    expect(await first).toBe(true);
    expect(sessions.get('chat-1')!.model).toBe('haiku');
  });

  it('returns false without stamping session.model when a concurrent stop replaces the session mid-switch', async () => {
    // Simulate SessionReaperService / chat:kill-session tearing this exact
    // session down (a brand-new session object takes its place in the map,
    // as a fresh CREATE/RESUME would) WHILE the SDK round-trip is in flight.
    const sessions = new Map<string, any>();
    const setModel = mock(async (_model?: string) => {
      sessions.set('chat-1', liveIdleSession({ model: 'sonnet', session_id: 'sid-replacement' }));
    });
    sessions.set('chat-1', liveIdleSession({ model: 'sonnet', query: { setModel } }));
    const handler = makeHandler(sessions);

    const switched = await handler.switchSessionModel('chat-1', 'haiku');

    expect(switched).toBe(false);
    // The replacement session's model is untouched by the stale switch.
    expect(sessions.get('chat-1')!.model).toBe('sonnet');
  });
});

describe('ChatExecutionService.executeMessage — live model switch (no restart)', () => {
  function makeService(
    overrides: {
      session?: any;
      isRunning?: boolean;
      isSessionRunningImpl?: () => boolean;
      canResume?: boolean;
      switchSessionModel?: ReturnType<typeof mock>;
    } = {}
  ) {
    const session = overrides.session ?? { model: 'sonnet', permissions: 'default' };
    const switchSessionModel = overrides.switchSessionModel ?? mock(async () => true);
    const stopSession = mock(async (_chatId: string, _userId?: string) => true);
    const addMessageToSession = mock(
      (_chatId: string, _content: string | any[], _userId: string) => true
    );

    const claudeService = {
      restoreSessionFromDatabase: mock(async () => false),
      isSessionRunning: mock(overrides.isSessionRunningImpl ?? (() => overrides.isRunning ?? true)),
      canResumeSession: mock(() => overrides.canResume ?? false),
      getSession: mock(() => session),
      switchSessionModel,
      stopSession,
      addMessageToSession,
    } as any;

    const chatService = {
      getChatOrigin: mock(async () => ({ origin: 'sqlite' })),
      bufferMessage: mock(async () => {}),
    } as any;

    const messageDeduplicationService = {
      isDuplicate: mock(() => false),
      addHash: mock(() => {}),
    } as any;

    const service = new ChatExecutionService(
      chatService,
      claudeService,
      {} as any, // gitLocalService
      messageDeduplicationService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );

    return { service, session, switchSessionModel, stopSession, addMessageToSession };
  }

  function ctx() {
    return {
      chatId: 'chat-1',
      userId: 'alice@example.com',
      username: 'alice',
      authToken: 't',
      emitter: {
        emit: mock(() => {}),
        broadcastRuntimeStateToUser: mock(() => {}),
      } as any,
    } as any;
  }

  it('live-switches the model instead of restarting when only the model changed', async () => {
    const { service, switchSessionModel, stopSession, addMessageToSession } = makeService({
      session: { model: 'sonnet', permissions: 'default' },
    });

    await service.executeMessage(
      ctx(),
      { content: 'hi' },
      { model: 'haiku', permissions: 'default' }
    );

    expect(switchSessionModel).toHaveBeenCalledWith('chat-1', 'haiku');
    expect(stopSession).not.toHaveBeenCalled();
    expect(addMessageToSession).toHaveBeenCalledWith('chat-1', 'hi', 'alice@example.com');
  });

  it('injects directly (no switch, no restart) when neither model nor permissions changed', async () => {
    const { service, switchSessionModel, stopSession, addMessageToSession } = makeService({
      session: { model: 'sonnet', permissions: 'default' },
    });

    await service.executeMessage(
      ctx(),
      { content: 'hi' },
      { model: 'sonnet', permissions: 'default' }
    );

    expect(switchSessionModel).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
    expect(addMessageToSession).toHaveBeenCalledWith('chat-1', 'hi', 'alice@example.com');
  });

  it('falls back to stopSession when the live model switch is unavailable', async () => {
    const { service, switchSessionModel, stopSession } = makeService({
      session: { model: 'sonnet', permissions: 'default' },
      switchSessionModel: mock(async () => false),
    });

    // Downstream session recreation (startNewSession) isn't stubbed here — only
    // the restart DECISION is asserted.
    await service
      .executeMessage(ctx(), { content: 'hi' }, { model: 'haiku', permissions: 'default' })
      .catch(() => {});

    expect(switchSessionModel).toHaveBeenCalledWith('chat-1', 'haiku');
    expect(stopSession).toHaveBeenCalledWith('chat-1', 'alice@example.com');
  });

  it('does NOT re-stop when a concurrent teardown already stopped the session during a failed live switch', async () => {
    // A concurrent idle-reap / chat:kill-session / racing restart may have
    // already torn this exact session down while switchSessionModel() was
    // awaiting the SDK. Re-stopping an already-stopped session would delete
    // it outright (losing session_id) instead of leaving it resumable.
    let callCount = 0;
    const { service, switchSessionModel, stopSession } = makeService({
      session: { model: 'sonnet', permissions: 'default' },
      switchSessionModel: mock(async () => false),
      // 1st call = the top-of-executeMessage isRunning check (session was
      // running when the message arrived); 2nd call = the post-failed-switch
      // recheck (a concurrent stop already tore it down in the meantime).
      isSessionRunningImpl: () => {
        callCount += 1;
        return callCount === 1;
      },
    });

    await service
      .executeMessage(ctx(), { content: 'hi' }, { model: 'haiku', permissions: 'default' })
      .catch(() => {});

    expect(switchSessionModel).toHaveBeenCalledWith('chat-1', 'haiku');
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('still restarts (stopSession) when permissions change, regardless of the model', async () => {
    const { service, switchSessionModel, stopSession } = makeService({
      session: { model: 'sonnet', permissions: 'default' },
    });

    await service
      .executeMessage(
        ctx(),
        { content: 'hi' },
        { model: 'sonnet', permissions: 'bypass_permissions' }
      )
      .catch(() => {});

    expect(stopSession).toHaveBeenCalledWith('chat-1', 'alice@example.com');
    expect(switchSessionModel).not.toHaveBeenCalled();
  });
});

describe('ChatExecutionService.handleKillSession', () => {
  let stopSession: ReturnType<typeof mock>;
  let getSession: ReturnType<typeof mock>;
  let emit: ReturnType<typeof mock>;
  let broadcastRuntimeStateToUser: ReturnType<typeof mock>;

  function makeService(session: any) {
    stopSession = mock(async (_chatId: string, _userId?: string) => true);
    getSession = mock((_chatId: string) => session);
    const claudeService = { getSession, stopSession } as any;
    return new ChatExecutionService(
      {} as any, // chatService
      claudeService,
      {} as any, // gitLocalService
      {} as any, // messageDeduplicationService
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
  }

  function ctx() {
    emit = mock(() => {});
    broadcastRuntimeStateToUser = mock(() => {});
    return {
      chatId: 'chat-1',
      userId: 'alice@example.com',
      username: 'alice',
      authToken: 't',
      emitter: { emit, broadcastRuntimeStateToUser } as any,
    } as any;
  }

  it('kills the owner’s session, rebroadcasts runtime state, and signals the chat UI', async () => {
    const service = makeService({ userId: 'alice@example.com' });
    const result = await service.handleKillSession(ctx(), { chatId: 'chat-1' });

    expect(result).toEqual({ success: true });
    expect(stopSession).toHaveBeenCalledWith('chat-1', 'alice@example.com');
    expect(broadcastRuntimeStateToUser).toHaveBeenCalledWith('alice@example.com');
    expect(emit).toHaveBeenCalledWith('claude:interrupted', { chatId: 'chat-1' });
  });

  it('refuses to kill a session owned by a different user', async () => {
    const service = makeService({ userId: 'bob@example.com' });
    const result = await service.handleKillSession(ctx(), { chatId: 'chat-1' });

    expect(result).toEqual({ success: false, error: 'Not authorized' });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('returns "Session not found" when there is no session', async () => {
    const service = makeService(undefined);
    const result = await service.handleKillSession(ctx(), { chatId: 'chat-1' });

    expect(result).toEqual({ success: false, error: 'Session not found' });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('reports "Session not running" when stopSession finds nothing to stop', async () => {
    const service = makeService({ userId: 'alice@example.com' });
    stopSession.mockImplementation(async () => false);
    const result = await service.handleKillSession(ctx(), { chatId: 'chat-1' });

    expect(result).toEqual({ success: false, error: 'Session not running' });
    // Runtime state is still refreshed so a stale row clears on every device.
    expect(broadcastRuntimeStateToUser).toHaveBeenCalledWith('alice@example.com');
  });
});

/**
 * Outdated-client notice: a client that sends NO `appVersion` in its
 * handshake (a pre-handshake native build) gets the ephemeral "update your app"
 * message INSTEAD of a Claude run. Up-to-date clients (the native app reports a
 * version) are never flagged (absence-only). Headless /
 * routine execution is unaffected: it never reaches `shouldBlockOutdatedClient`
 * (only the socket `chat:message` handler calls it).
 */
describe('ChatExecutionService outdated-client notice', () => {
  // chatService is `{}`: emitOutdatedClientNotice must NEVER touch it (no
  // persistence) — a stray bufferMessage call would throw on the empty object.
  function makeService() {
    return new ChatExecutionService(
      {} as any, // chatService
      {} as any, // claudeService
      {} as any, // gitLocalService
      {} as any, // messageDeduplicationService
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
  }

  function ctx(overrides: Record<string, any> = {}) {
    const events: Array<{ event: string; data: any }> = [];
    const emit = overrides.emit ?? ((event: string, data: any) => events.push({ event, data }));
    return {
      context: {
        chatId: 'chat-1',
        userId: 'alice@example.com',
        username: 'alice',
        authToken: 't',
        emitter: { emit } as any,
        ...overrides,
      } as any,
      events,
    };
  }

  it('flags a client that sends NO appVersion as outdated (absence-only)', () => {
    const service = makeService();
    expect(service.isOutdatedNativeClient(ctx({ appVersion: undefined }).context)).toBe(true);
  });

  it('does NOT flag a client that reports an appVersion', () => {
    const service = makeService();
    expect(service.isOutdatedNativeClient(ctx({ appVersion: '1.5.0' }).context)).toBe(false);
  });

  it('emits the update notice as an ephemeral text block + completed status, persisting nothing', () => {
    const service = makeService();
    const { context, events } = ctx({ appVersion: undefined });

    service.emitOutdatedClientNotice(context);

    const stream = events.find((e) => e.event === 'claude:stream');
    expect(stream).toBeDefined();
    expect(stream!.data.chatId).toBe('chat-1');
    expect(stream!.data.block.type).toBe('text');
    expect(stream!.data.block.text).toBe(OUTDATED_APP_MESSAGE);

    const status = events.find((e) => e.event === 'claude:status');
    expect(status!.data).toEqual({ chatId: 'chat-1', status: 'completed' });
  });

  /**
   * shouldBlockOutdatedClient (kill switch): the block only fires when it
   * is BOTH an outdated native client AND the gateway VERIFY_HANDSHAKE flag is on
   * (via the injected HandshakeVerificationGate). With no gate wired, or the flag
   * off, it never blocks — the safe default.
   */
  function gateStub(enabled: boolean) {
    let calls = 0;
    return {
      gate: { isEnabled: async () => ((calls += 1), enabled) } as any,
      calls: () => calls,
    };
  }

  function makeServiceWithGate(gate: any) {
    return new ChatExecutionService(
      {} as any, // chatService
      {} as any, // claudeService
      {} as any, // gitLocalService
      {} as any, // messageDeduplicationService
      undefined, // tunnelService
      undefined, // processTrackerService
      undefined, // dbAdapter
      undefined, // pushNotificationService
      undefined, // sopService
      undefined, // claudeCodeSessions
      undefined, // reposCacheService
      gate // handshakeVerificationGate
    );
  }

  it('blocks an outdated native client when the kill switch is ON', async () => {
    const { gate } = gateStub(true);
    const service = makeServiceWithGate(gate);
    expect(await service.shouldBlockOutdatedClient(ctx({ appVersion: undefined }).context)).toBe(
      true
    );
  });

  it('does NOT block an outdated native client when the kill switch is OFF', async () => {
    const { gate } = gateStub(false);
    const service = makeServiceWithGate(gate);
    expect(await service.shouldBlockOutdatedClient(ctx({ appVersion: undefined }).context)).toBe(
      false
    );
  });

  it('does NOT block when no gate is wired (safe default — kill switch treated as OFF)', async () => {
    const service = makeService(); // constructed without a gate
    expect(await service.shouldBlockOutdatedClient(ctx({ appVersion: undefined }).context)).toBe(
      false
    );
  });

  it('never consults the kill switch for an up-to-date client (cheap short-circuit, no network)', async () => {
    const { gate, calls } = gateStub(true);
    const service = makeServiceWithGate(gate);
    // Up-to-date native build (reports an appVersion) → not outdated → gate untouched.
    expect(await service.shouldBlockOutdatedClient(ctx({ appVersion: '1.5.0' }).context)).toBe(
      false
    );
    expect(calls()).toBe(0);
  });
});
