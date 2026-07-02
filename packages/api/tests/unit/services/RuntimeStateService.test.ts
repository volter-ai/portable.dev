/**
 * RuntimeStateService Unit Tests
 *
 * Focus: the always-emit-a-snapshot fix. When nothing is active, `getRuntimeState`
 * still returns null (so `hasActiveRuntimeState` works), but `getRuntimeStateForBroadcast`
 * returns a well-formed EMPTY snapshot so a broadcast ALWAYS overwrites the client's
 * view — clearing a stale (dead) tunnel left over from before a restart instead of
 * leaving it "stuck" because nothing was sent.
 */

import { describe, it, expect } from 'bun:test';

import { RuntimeStateService } from '../../../src/services/RuntimeStateService.js';

const emptyDeps = () =>
  new RuntimeStateService(
    { getUserTunnels: () => [] } as any,
    { getAllProcesses: () => [], getCachedOutput: () => undefined } as any,
    undefined as any,
    { getClaudeSessionInfos: () => [] } as any
  );

describe('RuntimeStateService', () => {
  describe('getRuntimeStateForBroadcast (always non-null)', () => {
    it('returns a well-formed EMPTY snapshot when nothing is active', async () => {
      const svc = emptyDeps();

      const snapshot = await svc.getRuntimeStateForBroadcast('user@example.com');

      expect(snapshot).not.toBeNull();
      expect(snapshot.tunnels).toEqual([]);
      expect(snapshot.backgroundProcesses).toEqual([]);
      expect(snapshot.claudeSessions).toEqual([]);
      expect(typeof snapshot.claudeSessionIdleTtlMs).toBe('number');
    });

    it('preserves the nullable contract of getRuntimeState / hasActiveRuntimeState when empty', async () => {
      const svc = emptyDeps();

      // The nullable accessor still returns null (so the "is anything active?" check works)…
      expect(await svc.getRuntimeState('user@example.com')).toBeNull();
      expect(await svc.hasActiveRuntimeState('user@example.com')).toBe(false);
      // …but the broadcast accessor never does.
      expect(await svc.getRuntimeStateForBroadcast('user@example.com')).not.toBeNull();
    });

    it('returns the live snapshot when a tunnel IS active', async () => {
      const svc = new RuntimeStateService(
        {
          getUserTunnels: () => [
            {
              id: 't1',
              port: 3000,
              url: 'https://abc.trycloudflare.com',
              name: 'app',
              createdAt: 1,
              active: true,
            },
          ],
        } as any,
        { getAllProcesses: () => [], getCachedOutput: () => undefined } as any,
        undefined as any,
        { getClaudeSessionInfos: () => [] } as any
      );

      const snapshot = await svc.getRuntimeStateForBroadcast('user@example.com');
      expect(snapshot.tunnels.length).toBe(1);
      expect(snapshot.tunnels[0].port).toBe(3000);
      expect(await svc.hasActiveRuntimeState('user@example.com')).toBe(true);
    });
  });

  describe('terminal-session fold (rev12 D55)', () => {
    const apiSession = {
      chatId: 'chat-1',
      repoPath: '/repo',
      status: 'running',
      isProcessing: true,
      lastActivityAt: 100,
      idleMs: 0,
      resumable: true,
    };
    const externalRows = [
      {
        sessionId: 'sess-terminal',
        transcriptPath: '/t.jsonl',
        cwd: '/repo2',
        pid: 5,
        pidConfirmed: true,
        state: 'live-running',
        updatedAt: 200,
      },
    ];

    const build = (apiSessions: any[], liveRows: any[]) =>
      new RuntimeStateService(
        { getUserTunnels: () => [] } as any,
        { getAllProcesses: () => [], getCachedOutput: () => undefined } as any,
        undefined as any,
        { getClaudeSessionInfos: () => apiSessions } as any,
        { getLiveSessions: () => liveRows } as any
      );

    it('folds terminal sessions in with origin:"terminal" and chatId = session id', async () => {
      const svc = build([apiSession], externalRows);
      const snapshot = await svc.getRuntimeStateForBroadcast('user@example.com');

      expect(snapshot.claudeSessions).toHaveLength(2);
      const [api, terminal] = snapshot.claudeSessions;
      expect(api.origin).toBe('portable');
      expect(terminal).toMatchObject({
        chatId: 'sess-terminal',
        repoPath: '/repo2',
        status: 'running',
        isProcessing: true,
        resumable: true,
        origin: 'terminal',
      });
    });

    it('a live-idle terminal session surfaces as idle with a real idleMs', async () => {
      const svc = build([], [{ ...externalRows[0], state: 'live-idle' }]);
      const snapshot = await svc.getRuntimeStateForBroadcast('user@example.com');
      expect(snapshot.claudeSessions).toHaveLength(1);
      expect(snapshot.claudeSessions[0].status).toBe('idle');
      expect(snapshot.claudeSessions[0].isProcessing).toBe(false);
      expect(snapshot.claudeSessions[0].idleMs).toBeGreaterThan(0);
    });

    it('drops a terminal session whose id collides with an api-spawned chat (adopted chat)', async () => {
      const svc = build(
        [{ ...apiSession, chatId: 'sess-terminal' }],
        externalRows // same id — the api is running the adopted session
      );
      const snapshot = await svc.getRuntimeStateForBroadcast('user@example.com');
      expect(snapshot.claudeSessions).toHaveLength(1);
      expect(snapshot.claudeSessions[0].origin).toBe('portable');
    });

    it('terminal sessions alone make the runtime state active', async () => {
      const svc = build([], externalRows);
      expect(await svc.hasActiveRuntimeState('user@example.com')).toBe(true);
    });
  });
});
