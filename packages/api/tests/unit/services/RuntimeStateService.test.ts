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
});
