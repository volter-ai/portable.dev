import { PairingStateStore, type PairingStateData } from '@vgit2/shared/secrets';

/**
 * Live "a device just connected" watcher (connected-aware CLI).
 *
 * The api stamps `<DATA_DIR>/pairing-state.json` the instant an authenticated
 * device connects, but that's a SEPARATE process — so when the launcher is
 * showing the pairing QR it has to learn about the connection out-of-band to swap
 * to the connected menu WITHOUT a restart. Rather than wire an api→launcher
 * channel, the launcher just polls the shared marker file: cheap, decoupled, and
 * robust on Windows (the marker is written via tmp+rename, which `fs.watch` reports
 * unreliably). The FIRST connection always writes the marker immediately (the api's
 * 60s throttle only applies to later reconnects), so a ~2s poll catches it fast.
 *
 * It fires the callback EXACTLY ONCE — the false→true flip of `firstConnectedAt` —
 * then stops its own timer. The timer is `unref`'d so it never keeps the process
 * alive. All effects are injectable for tests.
 */

export interface ConnectionWatcherHandle {
  /** Stop polling. Idempotent; a no-op if the watcher already fired. */
  stop(): void;
}

export interface StartConnectionWatchOptions {
  /** Marker reader seam. Defaults to reading the real `<DATA_DIR>/pairing-state.json`. */
  read?: () => PairingStateData;
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** setInterval seam (tests). */
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** clearInterval seam (tests). */
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Start polling the pairing marker. Calls {@link onConnected} once with the marker
 * state when a device has connected (`firstConnectedAt` appears), then stops.
 * Returns a handle whose `stop()` cancels the poll.
 */
export function startConnectionWatch(
  onConnected: (state: PairingStateData) => void,
  options: StartConnectionWatchOptions = {}
): ConnectionWatcherHandle {
  const read = options.read ?? (() => new PairingStateStore().read());
  const intervalMs = options.intervalMs ?? 2000;
  const setI = options.setIntervalImpl ?? setInterval;
  const clearI = options.clearIntervalImpl ?? clearInterval;

  let fired = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const cancel = () => {
    if (timer !== null) {
      try {
        clearI(timer);
      } catch {
        // ignore
      }
      timer = null;
    }
  };

  timer = setI(() => {
    if (fired) return;
    let state: PairingStateData;
    try {
      state = read();
    } catch {
      return; // best-effort — a transient read error just waits for the next tick
    }
    if (typeof state.firstConnectedAt === 'string') {
      fired = true;
      cancel();
      onConnected(state);
    }
  }, intervalMs);

  // Never let the poll timer hold the event loop open.
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      fired = true;
      cancel();
    },
  };
}
