/**
 * ConnectionWatcher tests (live connected-aware CLI transition).
 *
 * Polls the pairing marker; fires the callback ONCE on the false→true flip of
 * firstConnectedAt, then stops. All timers + the marker reader are injected, so a
 * tick is driven manually (no real 2s waits).
 */
import { describe, expect, it } from 'bun:test';

import { startConnectionWatch } from '../src/ConnectionWatcher.js';

import type { PairingStateData } from '@vgit2/shared/secrets';

/** A manual interval seam: capture the callback so the test ticks it on demand. */
function manualTimer() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    setIntervalImpl: ((fn: () => void) => {
      cb = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as StartArgs['setIntervalImpl'],
    clearIntervalImpl: (() => {
      cleared++;
    }) as StartArgs['clearIntervalImpl'],
    tick: () => cb?.(),
    cleared: () => cleared,
  };
}

type StartArgs = NonNullable<Parameters<typeof startConnectionWatch>[1]>;

describe('startConnectionWatch', () => {
  it('fires once when firstConnectedAt appears, then clears the timer', () => {
    let state: PairingStateData = {};
    const t = manualTimer();
    const fired: PairingStateData[] = [];

    startConnectionWatch((s) => fired.push(s), {
      read: () => state,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });

    // Not connected yet → tick does nothing.
    t.tick();
    expect(fired).toHaveLength(0);
    expect(t.cleared()).toBe(0);

    // Marker flips → next tick fires once + clears the timer.
    state = {
      firstConnectedAt: '2026-06-27T10:00:00.000Z',
      lastConnectedAt: '2026-06-27T10:00:00.000Z',
    };
    t.tick();
    expect(fired).toHaveLength(1);
    expect(fired[0].lastConnectedAt).toBe('2026-06-27T10:00:00.000Z');
    expect(t.cleared()).toBe(1);

    // Further ticks never fire again.
    t.tick();
    expect(fired).toHaveLength(1);
  });

  it('swallows a read error and waits for the next tick', () => {
    let throwOnce = true;
    const t = manualTimer();
    const fired: PairingStateData[] = [];

    startConnectionWatch((s) => fired.push(s), {
      read: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('transient read error');
        }
        return { firstConnectedAt: 'x' };
      },
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });

    t.tick(); // throws internally → no fire, no crash
    expect(fired).toHaveLength(0);
    t.tick(); // now returns connected → fires
    expect(fired).toHaveLength(1);
  });

  it('stop() cancels the poll before any connection', () => {
    const t = manualTimer();
    const fired: PairingStateData[] = [];
    const handle = startConnectionWatch((s) => fired.push(s), {
      read: () => ({ firstConnectedAt: 'x' }),
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });

    handle.stop();
    expect(t.cleared()).toBe(1);
    t.tick(); // already stopped → never fires
    expect(fired).toHaveLength(0);
  });
});
