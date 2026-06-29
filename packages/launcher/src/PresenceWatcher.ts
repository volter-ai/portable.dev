import { DevicePresenceStore, type DeviceInfo } from '@vgit2/shared/secrets';

/**
 * Live device-presence watcher (connected menu's right-hand column).
 *
 * The api rewrites `<DATA_DIR>/device-presence.json` on every Socket.IO
 * connect/disconnect; this polls it (~1.5s) and calls back with the current device
 * list WHENEVER it changes (including back to empty on disconnect). Unlike the
 * one-shot {@link startConnectionWatch}, this runs for the whole session so the box
 * tracks devices coming and going. The timer is `unref`'d so it never holds the
 * process open. All effects are injectable for tests.
 */

export interface PresenceWatcherHandle {
  /** Stop polling. Idempotent. */
  stop(): void;
}

export interface StartPresenceWatchOptions {
  /** Presence reader seam. Defaults to reading the real device-presence.json. */
  read?: () => DeviceInfo[];
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

/** A stable signature for a device list, to detect changes between polls. */
function signature(devices: DeviceInfo[]): string {
  return devices
    .map((d) => `${d.id}:${d.appVersion ?? ''}:${d.connectedAt}`)
    .sort()
    .join('|');
}

/**
 * Start polling device presence. Calls {@link onPresence} immediately with the
 * current list, then again every time it changes. Returns a handle whose `stop()`
 * cancels the poll.
 */
export function startPresenceWatch(
  onPresence: (devices: DeviceInfo[]) => void,
  options: StartPresenceWatchOptions = {}
): PresenceWatcherHandle {
  const read = options.read ?? (() => new DevicePresenceStore().read().devices);
  const intervalMs = options.intervalMs ?? 1500;
  const setI = options.setIntervalImpl ?? setInterval;
  const clearI = options.clearIntervalImpl ?? clearInterval;

  let last: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    let devices: DeviceInfo[];
    try {
      devices = read();
    } catch {
      return; // transient read error → wait for the next tick
    }
    const sig = signature(devices);
    if (sig !== last) {
      last = sig;
      onPresence(devices);
    }
  };

  // Emit the initial state right away so the column isn't blank until the first tick.
  poll();

  timer = setI(poll, intervalMs);
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      if (timer !== null) {
        try {
          clearI(timer);
        } catch {
          // ignore
        }
        timer = null;
      }
    },
  };
}
