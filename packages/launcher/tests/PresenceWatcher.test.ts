/**
 * PresenceWatcher tests — polls device presence and reports the list on CHANGE.
 * Timers + the reader are injected so ticks are driven manually.
 */
import { describe, expect, it } from 'bun:test';

import { startPresenceWatch } from '../src/PresenceWatcher.js';

import type { DeviceInfo } from '@vgit2/shared/secrets';

function manualTimer() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    setIntervalImpl: ((fn: () => void) => {
      cb = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as NonNullable<Parameters<typeof startPresenceWatch>[1]>['setIntervalImpl'],
    clearIntervalImpl: (() => {
      cleared++;
    }) as NonNullable<Parameters<typeof startPresenceWatch>[1]>['clearIntervalImpl'],
    tick: () => cb?.(),
    cleared: () => cleared,
  };
}

const dev = (id: string, v?: string): DeviceInfo => ({
  id,
  appVersion: v,
  connectedAt: '2026-06-27T10:00:00.000Z',
});

describe('startPresenceWatch', () => {
  it('emits the initial state immediately, then only on change', () => {
    let devices: DeviceInfo[] = [];
    const t = manualTimer();
    const emits: DeviceInfo[][] = [];

    startPresenceWatch((d) => emits.push(d), {
      read: () => devices,
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });

    // Initial emit (empty) happens at start.
    expect(emits).toHaveLength(1);
    expect(emits[0]).toEqual([]);

    // No change → no emit.
    t.tick();
    expect(emits).toHaveLength(1);

    // A device connects → emit.
    devices = [dev('sock1', '1.0.27')];
    t.tick();
    expect(emits).toHaveLength(2);
    expect(emits[1]).toHaveLength(1);

    // Same set → no emit.
    t.tick();
    expect(emits).toHaveLength(2);

    // Disconnect (back to empty) → emit.
    devices = [];
    t.tick();
    expect(emits).toHaveLength(3);
    expect(emits[2]).toEqual([]);
  });

  it('swallows a read error and keeps polling', () => {
    let fail = true;
    const t = manualTimer();
    const emits: DeviceInfo[][] = [];
    startPresenceWatch((d) => emits.push(d), {
      read: () => {
        if (fail) {
          fail = false;
          throw new Error('transient');
        }
        return [dev('s1')];
      },
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });
    // Initial poll threw → no emit yet.
    expect(emits).toHaveLength(0);
    t.tick();
    expect(emits).toHaveLength(1);
  });

  it('stop() cancels the poll', () => {
    const t = manualTimer();
    const handle = startPresenceWatch(() => {}, {
      read: () => [],
      setIntervalImpl: t.setIntervalImpl,
      clearIntervalImpl: t.clearIntervalImpl,
    });
    handle.stop();
    expect(t.cleared()).toBe(1);
  });
});
