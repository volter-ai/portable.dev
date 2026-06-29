/**
 * Sandbox health monitor (5s poll, 90s threshold, lifecycle-aware).
 *
 * Exercises the framework-free `SandboxHealthMonitor` (`@vgit2/shared/sandbox`)
 * AND its RN ViewModel (`useSandboxHealthMonitor`) with a DETERMINISTIC manual
 * clock + interval scheduler (no real/fake jest timers, so the async health
 * `fetch` promises flush normally) and a mocked `GET {sandbox}/api/health`:
 *
 *   1. continuous network-connected failures do NOT trip ConnectionFailed
 *      before 90s, and trip EXACTLY at 90s;
 *   2. `setNetworkConnected(false)` (offline) FREEZES the accumulator — no trip
 *      while the offline gap covers the remaining window — and reconnecting
 *      RESUMES it so the trip lands 90s of *connected* failure in;
 *   3. via the hook: a backgrounded AppState FREEZES the accumulator (polling
 *      stops, no trip), and foregrounding `active` RESETS it and RESUMES the 5s
 *      polling (a fresh 90s window).
 */

// The health barrel re-exports StartupHealthGate/ConnectionFailedScreen, which now
// consume useAppTheme → themeStore → MMKV. Mock it (in-memory) so importing the
// barrel never loads the native module.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string>();
  const instance = {
    set: (k: string, v: string) => store.set(k, String(v)),
    getString: (k: string) => store.get(k),
    remove: (k: string) => store.delete(k),
    clearAll: () => store.clear(),
  };
  return { __store: store, createMMKV: () => instance, MMKV: class {} };
});

// The health feature imports the provisioning sandbox-URL store, which loads
// expo-secure-store at module scope. Mock it so the import doesn't touch the
// native keychain (the hook injects its own getRelayUrl anyway).
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
});

import { act, render } from '@testing-library/react-native';
import {
  CONNECTION_FAILED_THRESHOLD_MS,
  HEALTH_POLL_INTERVAL_MS,
  SandboxHealthMonitor,
  type SandboxHealthMonitorOptions,
} from '@vgit2/shared/sandbox';

import {
  useSandboxHealthMonitor,
  useSandboxHealthStore,
  type SandboxHealthMonitorDeps,
} from '../src/features/health';
import type { AppStateLike, NetInfoLike, AppStateStatus } from '../src/features/socket';

const SANDBOX_URL = 'https://sandbox.example.modal.run';

/** Flush pending microtasks so an awaited `fetch` inside `checkHealth` settles. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Deterministic clock + interval scheduler injected into the monitor. `advance`
 * fires every due interval in order, flushing microtasks after each tick so the
 * monitor's async health check resolves before the next tick.
 */
function createManualScheduler() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { cb: () => void; ms: number; next: number }>();

  return {
    seams: {
      now: () => now,
      setIntervalImpl: (cb: () => void, ms: number) => {
        const id = nextId++;
        intervals.set(id, { cb, ms, next: now + ms });
        return id;
      },
      clearIntervalImpl: (handle: unknown) => {
        intervals.delete(handle as number);
      },
      // No real abort signal in tests — fetch resolves/rejects synchronously.
      timeoutSignal: () => undefined,
    } satisfies Partial<SandboxHealthMonitorOptions>,
    /** Advance the clock by `ms`, firing + flushing every interval tick in order. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      // Repeatedly fire the earliest-due interval until none remain before target.
      for (;;) {
        let dueId: number | null = null;
        let dueTime = Infinity;
        for (const [id, iv] of intervals) {
          if (iv.next <= target && iv.next < dueTime) {
            dueId = id;
            dueTime = iv.next;
          }
        }
        if (dueId === null) break;
        now = dueTime;
        const iv = intervals.get(dueId)!;
        iv.next += iv.ms;
        await act(async () => {
          iv.cb();
          await flushMicrotasks();
        });
      }
      now = target;
    },
  };
}

/** A `fetch` that always reports the sandbox as down (network error). */
function failingFetch(): jest.Mock {
  return jest.fn(async () => {
    throw new Error('ECONNREFUSED');
  });
}

/** Imperatively-driven AppState mock (mirrors the socket-provider test helper). */
function createAppStateController(): { appState: AppStateLike; emit: (s: AppStateStatus) => void } {
  let listener: ((s: AppStateStatus) => void) | null = null;
  return {
    appState: {
      currentState: 'active',
      addEventListener: (_type, l) => {
        listener = l;
        return { remove: () => (listener = null) };
      },
    },
    emit: (s) => listener?.(s),
  };
}

/** Imperatively-driven NetInfo mock. */
function createNetInfoController(): { netInfo: NetInfoLike; emit: (isConnected: boolean) => void } {
  let listener: ((s: { isConnected: boolean | null }) => void) | null = null;
  return {
    netInfo: {
      addEventListener: (l) => {
        listener = l;
        return () => (listener = null);
      },
    },
    emit: (isConnected) => listener?.({ isConnected }),
  };
}

describe('SandboxHealthMonitor (shared core)', () => {
  it('does not trip before 90s of continuous failure and trips exactly at 90s', async () => {
    const sched = createManualScheduler();
    const onConnectionFailed = jest.fn();
    const monitor = new SandboxHealthMonitor({
      ...sched.seams,
      fetchImpl: failingFetch() as unknown as typeof fetch,
      onConnectionFailed,
    });

    // Immediate check fires synchronously on start (an async fetch).
    await act(async () => {
      monitor.startHealthPolling(SANDBOX_URL);
      await flushMicrotasks();
    });

    // 85s in: 18 failed polls (0,5,…,85s) but still under the threshold.
    await sched.advance(CONNECTION_FAILED_THRESHOLD_MS - HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).not.toHaveBeenCalled();
    expect(monitor.isConnectionFailed).toBe(false);

    // The 90s poll trips it.
    await sched.advance(HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).toHaveBeenCalledTimes(1);
    expect(monitor.isConnectionFailed).toBe(true);
  });

  it('treats a 200 without the JSON health body (dead-tunnel HTML page) as a FAILURE', async () => {
    // A dead Modal sandbox's tunnel host keeps answering HTTP 200 with an HTML
    // edge page. That must count as a failed check (and eventually trip the 90s
    // threshold) — `response.ok` alone is NOT proof of life.
    const sched = createManualScheduler();
    const onConnectionFailed = jest.fn();
    const onHealthFailure = jest.fn();
    const onHealthSuccess = jest.fn();
    const htmlFetch = jest.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    }));
    const monitor = new SandboxHealthMonitor({
      ...sched.seams,
      fetchImpl: htmlFetch as unknown as typeof fetch,
      onConnectionFailed,
      onHealthFailure,
      onHealthSuccess,
    });

    await act(async () => {
      monitor.startHealthPolling(SANDBOX_URL);
      await flushMicrotasks();
    });
    expect(onHealthFailure).toHaveBeenCalledWith(1);
    expect(onHealthSuccess).not.toHaveBeenCalled();

    // The zombie 200s accumulate like any other failure → 90s trips it.
    await sched.advance(CONNECTION_FAILED_THRESHOLD_MS);
    expect(onConnectionFailed).toHaveBeenCalledTimes(1);
    expect(monitor.isConnectionFailed).toBe(true);
  });

  it('accepts ONLY the real JSON health body (2xx + status:"ok") as success', async () => {
    const sched = createManualScheduler();
    const onHealthSuccess = jest.fn();
    const onHealthFailure = jest.fn();
    const okFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', uptime: 1.23 }),
    }));
    const monitor = new SandboxHealthMonitor({
      ...sched.seams,
      fetchImpl: okFetch as unknown as typeof fetch,
      onHealthSuccess,
      onHealthFailure,
    });

    await act(async () => {
      monitor.startHealthPolling(SANDBOX_URL);
      await flushMicrotasks();
    });
    expect(onHealthSuccess).toHaveBeenCalledTimes(1);
    expect(onHealthFailure).not.toHaveBeenCalled();
  });

  it('freezes the accumulator while offline and resumes on reconnect', async () => {
    const sched = createManualScheduler();
    const onConnectionFailed = jest.fn();
    const monitor = new SandboxHealthMonitor({
      ...sched.seams,
      fetchImpl: failingFetch() as unknown as typeof fetch,
      onConnectionFailed,
    });

    await act(async () => {
      monitor.startHealthPolling(SANDBOX_URL);
      await flushMicrotasks();
    });

    // 60s of connected failure.
    await sched.advance(60_000);
    expect(monitor.isConnectionFailed).toBe(false);

    // Go offline; the accumulator FREEZES — a long offline gap accrues no time.
    monitor.setNetworkConnected(false);
    await sched.advance(60_000);
    expect(onConnectionFailed).not.toHaveBeenCalled();
    expect(monitor.isConnectionFailed).toBe(false);

    // Back online: accumulation RESUMES from 60s; 25s later still under threshold…
    monitor.setNetworkConnected(true);
    await sched.advance(25_000);
    expect(monitor.isConnectionFailed).toBe(false);

    // …and 5s after that (90s of *connected* failure total) it trips.
    await sched.advance(HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).toHaveBeenCalledTimes(1);
    expect(monitor.isConnectionFailed).toBe(true);
  });
});

describe('useSandboxHealthMonitor (RN lifecycle)', () => {
  beforeEach(() => {
    act(() => useSandboxHealthStore.getState().reset());
  });

  function renderMonitor(extra: Partial<SandboxHealthMonitorDeps> = {}) {
    const sched = createManualScheduler();
    const fetchImpl = failingFetch();
    const onConnectionFailed = jest.fn();
    const appCtl = createAppStateController();
    const netCtl = createNetInfoController();

    const deps: SandboxHealthMonitorDeps = {
      getRelayUrl: async () => SANDBOX_URL,
      appState: appCtl.appState,
      netInfo: netCtl.netInfo,
      createMonitor: () =>
        new SandboxHealthMonitor({
          ...sched.seams,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          // Spy AND fold into the store, mirroring the hook's default wiring.
          onConnectionFailed: () => {
            onConnectionFailed();
            useSandboxHealthStore.getState().markFailed();
          },
          onStatusChange: (status) => {
            const store = useSandboxHealthStore.getState();
            if (status === 'connected') store.markHealthy();
            else store.markReconnecting();
          },
        }),
      ...extra,
    };

    const handles: { handle?: ReturnType<typeof useSandboxHealthMonitor> } = {};
    function Harness() {
      handles.handle = useSandboxHealthMonitor(deps);
      return null;
    }
    const utils = render(<Harness />);
    return { sched, fetchImpl, onConnectionFailed, appCtl, netCtl, utils, handles };
  }

  it('freezes when backgrounded and gets a fresh 90s window + resumed polling on foreground active', async () => {
    const { sched, fetchImpl, onConnectionFailed, appCtl, handles } = renderMonitor();

    // Let mount resolve the URL + start polling (immediate check runs).
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchImpl).toHaveBeenCalled();
    const callsAfterStart = fetchImpl.mock.calls.length;

    // Accrue 60s of failure, then background → freeze (polling stops).
    await sched.advance(60_000);
    act(() => appCtl.emit('background'));
    const callsAtBackground = fetchImpl.mock.calls.length;

    // While backgrounded, time passes but NOTHING happens (no polls, no trip).
    await sched.advance(120_000);
    expect(fetchImpl.mock.calls.length).toBe(callsAtBackground);
    expect(onConnectionFailed).not.toHaveBeenCalled();
    expect(handles.handle?.monitor.isConnectionFailed).toBe(false);

    // Foreground `active`: RESET (fresh window) + RESUME polling.
    await act(async () => {
      appCtl.emit('active');
      await flushMicrotasks();
    });
    expect(useSandboxHealthStore.getState().status).toBe('reconnecting');
    // Polling resumed: a new immediate check fired.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAtBackground);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterStart);

    // Because the window RESET, it takes a full fresh 90s to trip (the prior 60s
    // does not count): 85s in, still healthy…
    await sched.advance(CONNECTION_FAILED_THRESHOLD_MS - HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).not.toHaveBeenCalled();

    // …and the 90s poll (of the fresh window) trips → store reflects `failed`.
    await sched.advance(HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).toHaveBeenCalledTimes(1);
    expect(useSandboxHealthStore.getState().status).toBe('failed');
  });

  it('restartPolling() re-reads the sandbox URL and polls the NEW one with a fresh window', async () => {
    // After a recovery persists a NEW sandbox URL, the monitor must move to it —
    // the mount-time closure must not keep polling the dead URL forever.
    const NEW_URL = 'https://fresh-sandbox.example.modal.run';
    let url = SANDBOX_URL;
    const { sched, fetchImpl, onConnectionFailed, handles } = renderMonitor({
      getRelayUrl: async () => url,
    });

    // Mount: polling starts against the OLD URL.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${SANDBOX_URL}/api/health`);

    // 60s of failure accrue against the dead URL, then recovery re-points.
    await sched.advance(60_000);
    url = NEW_URL;
    await act(async () => {
      await handles.handle!.restartPolling();
      await flushMicrotasks();
    });

    // The immediate post-restart check hits the NEW URL.
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(`${NEW_URL}/api/health`);

    // The restart granted a FRESH 90s window (the prior 60s did not carry over):
    // 85s in, still no trip…
    await sched.advance(CONNECTION_FAILED_THRESHOLD_MS - HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).not.toHaveBeenCalled();

    // …and the 90s poll of the fresh window trips.
    await sched.advance(HEALTH_POLL_INTERVAL_MS);
    expect(onConnectionFailed).toHaveBeenCalledTimes(1);
  });
});
