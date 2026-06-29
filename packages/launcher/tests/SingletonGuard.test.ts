/**
 * SingletonGuard tests — the single-instance takeover that makes a second
 * `portable` stop the first and boot fresh. Every effect (health probe, lock fs,
 * tree-kill, port-owner lookup, sleep, clock) is injected, so no real process is
 * killed, no real port is probed, and no real lock file is written.
 */
import { describe, expect, it } from 'bun:test';

import { acquireSingleton, type LauncherLock } from '../src/SingletonGuard.js';

/** A fake in-memory lock file + the seam set wired to it. */
function harness(opts: {
  initialLock?: LauncherLock | null;
  healthSequence: boolean[]; // probeHealth returns these in order, last value sticks
  portOwner?: number | null;
}) {
  let lock: LauncherLock | null = opts.initialLock ?? null;
  const log: string[] = [];
  const killed: number[] = [];
  let probeIdx = 0;
  const seq = opts.healthSequence;

  const deps = {
    selfPid: 999,
    lockPath: '/fake/launcher.lock',
    port: 4200,
    env: {} as NodeJS.ProcessEnv,
    probeHealth: async () => {
      const v = seq[Math.min(probeIdx, seq.length - 1)];
      probeIdx++;
      return v;
    },
    readLock: () => lock,
    writeLock: (_p: string, l: LauncherLock) => {
      lock = l;
    },
    removeLock: () => {
      lock = null;
    },
    // Treat any lock pid as alive so the lock-pid kill path is exercised; the
    // port-owner fallback is tested explicitly via initialLock:null.
    isProcessAlive: () => true,
    findPortOwner: async () => opts.portOwner ?? null,
    terminateTree: async (pid: number) => {
      killed.push(pid);
    },
    sleep: async () => {},
    nowIso: () => '2026-06-28T00:00:00.000Z',
    log: (line: string) => log.push(line),
    portFreeTimeoutMs: 1000,
  };

  return {
    deps,
    getLock: () => lock,
    log,
    killed,
  };
}

describe('acquireSingleton', () => {
  it('claims the lock when nothing is running (no kill)', async () => {
    const h = harness({ initialLock: null, healthSequence: [false] });
    const handle = await acquireSingleton(h.deps);

    expect(h.killed).toEqual([]);
    expect(h.getLock()).toEqual({
      pid: 999,
      port: 4200,
      startedAt: '2026-06-28T00:00:00.000Z',
    });
    // release() removes our own lock.
    handle.release();
    expect(h.getLock()).toBeNull();
  });

  it('drops a STALE lock when the port is not serving health', async () => {
    const stale: LauncherLock = { pid: 111, port: 4200, startedAt: 'old' };
    const h = harness({ initialLock: stale, healthSequence: [false] });
    await acquireSingleton(h.deps);

    expect(h.killed).toEqual([]); // nothing alive to kill
    expect(h.getLock()?.pid).toBe(999); // overwritten with ours
  });

  it('tree-kills the running portable (pid from the lock) then takes over', async () => {
    const running: LauncherLock = { pid: 222, port: 4200, startedAt: 'old' };
    // running at first probe; after the kill the port frees (false).
    const h = harness({ initialLock: running, healthSequence: [true, false] });
    await acquireSingleton(h.deps);

    expect(h.killed).toEqual([222]);
    expect(h.getLock()?.pid).toBe(999);
    expect(h.log.join('\n')).toContain('stopping it to take over');
    expect(h.log.join('\n')).toContain('taking over');
  });

  it('falls back to the port owner when the lock has no usable pid', async () => {
    // Port serves health but there is NO lock file (crash) — use the port owner.
    const h = harness({ initialLock: null, healthSequence: [true, false], portOwner: 333 });
    await acquireSingleton(h.deps);

    expect(h.killed).toEqual([333]);
    expect(h.getLock()?.pid).toBe(999);
  });

  it('warns (no kill) when the port serves health but no owner pid is found', async () => {
    const h = harness({ initialLock: null, healthSequence: [true], portOwner: null });
    await acquireSingleton(h.deps);

    expect(h.killed).toEqual([]);
    expect(h.log.join('\n')).toContain('owner pid is unknown');
    expect(h.getLock()?.pid).toBe(999); // we still claim the lock
  });

  it('warns when the old runtime never releases the port within the timeout', async () => {
    const running: LauncherLock = { pid: 222, port: 4200, startedAt: 'old' };
    // Always true → port never frees; the deadline loop gives up.
    const h = harness({ initialLock: running, healthSequence: [true] });
    await acquireSingleton(h.deps);

    expect(h.killed).toEqual([222]);
    expect(h.log.join('\n')).toContain('still holding');
  });

  it('release() does NOT remove a lock a later takeover overwrote with its pid', async () => {
    const h = harness({ initialLock: null, healthSequence: [false] });
    const handle = await acquireSingleton(h.deps);
    expect(h.getLock()?.pid).toBe(999);

    // Simulate a newer instance claiming the lock.
    h.deps.writeLock('/fake/launcher.lock', { pid: 1234, port: 4200, startedAt: 'newer' });
    handle.release();
    // Ours released over theirs would be wrong — the newer lock must survive.
    expect(h.getLock()?.pid).toBe(1234);
  });
});
