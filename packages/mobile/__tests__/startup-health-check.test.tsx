/**
 * Cold-start startup health check (backoff).
 *
 * Two layers, all with MOCKED timers (an injected, deterministic `delay` seam):
 *
 *   1. `startupHealthCheck` core (no React): a health endpoint that fails then
 *      succeeds retries on the front-loaded `[0.5,1,2,3,5]s` backoff (capped 15s)
 *      for the SHORT local-first 6-attempt budget (~11.5s — rides out a cloudflared
 *      tunnel rotation, not a Modal container cold boot); an all-failing endpoint
 *      exhausts the budget and throws `StartupHealthCheckError`; firing the abort
 *      signal cancels the in-flight check (rejects `AbortError`) and stops probing.
 *   2. `StartupHealthGate` integration (RNTL): the gate renders a LOADING state
 *      (never an error) throughout boot while the sandbox warms up, then renders
 *      its children on the first `200`; unmounting (navigate away / sign out)
 *      ABORTS the in-flight check and runs cleanup (no further probes, no flip
 *      to the failed state).
 */

// The gate now renders the branded LoadingSplash → useAppTheme → themeStore → MMKV.
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

// The health barrel imports the provisioning sandbox-URL store, which loads
// expo-secure-store at module scope. Mock it (in-memory) so the import never
// touches the native keychain.
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

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  isStartupAbort,
  StartupHealthCheckError,
  StartupHealthGate,
  startupHealthCheck,
  STARTUP_MAX_ATTEMPTS,
  useStartupHealthStore,
} from '../src/features/health';

const SANDBOX_URL = 'https://sandbox.example.modal.run';

/** Flush pending microtasks + a macrotask turn so awaited probes settle. */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** An `AbortError`-tagged error (matches what the check throws on abort). */
function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A controllable "mocked timer": records every requested delay (ms) and lets the
 * test resolve them on demand. Abort-aware — rejects a pending delay when the
 * passed signal fires (so the cleanup path is exercised).
 */
function makeControlledDelay() {
  const ms: number[] = [];
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const delay = (delayMs: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      ms.push(delayMs);
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const entry = { resolve, reject };
      pending.push(entry);
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  return {
    ms,
    delay,
    /** Resolve the oldest pending delay (advance to the next attempt). */
    releaseNext() {
      pending.shift()?.resolve();
    },
    /** Resolve every pending delay (run to completion). */
    releaseAll() {
      while (pending.length) pending.shift()?.resolve();
    },
    pendingCount: () => pending.length,
  };
}

/**
 * A `fetch` whose probes return the given `ok` queue (last value repeats). An
 * `ok: true` probe carries the REAL JSON health body — the check validates the
 * body, so a bare 200 would no longer count as healthy.
 */
function makeFetch(okQueue: boolean[]) {
  const fetchImpl = jest.fn(async () => {
    const ok = okQueue.length > 1 ? okQueue.shift()! : (okQueue[0] ?? false);
    return { ok, json: async () => ({ status: 'ok' }) } as unknown as Response;
  });
  return fetchImpl as unknown as typeof fetch & jest.Mock;
}

/** A `fetch` that answers 200 with an HTML page (a dead Modal tunnel's edge). */
function makeHtmlFetch() {
  const fetchImpl = jest.fn(async () => {
    return {
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    } as unknown as Response;
  });
  return fetchImpl as unknown as typeof fetch & jest.Mock;
}

beforeEach(() => {
  useStartupHealthStore.getState().reset();
});

// ─────────────────────────── Layer 1: core backoff ───────────────────────────

describe('startupHealthCheck core', () => {
  it('retries on the front-loaded [0.5,1,2,3,5]s backoff (capped 15s) until the PC is healthy', async () => {
    // Fail the first 4 probes, succeed on the 5th.
    const fetchImpl = makeFetch([false, false, false, false, true]);
    const timer = makeControlledDelay();

    const result = startupHealthCheck({
      sandboxUrl: SANDBOX_URL,
      fetchImpl,
      delay: timer.delay,
      timeoutSignal: () => undefined,
    });
    // Resolve every backoff gap as soon as it is scheduled.
    const drain = (async () => {
      for (let i = 0; i < 10; i++) {
        await flush();
        timer.releaseAll();
      }
    })();
    await expect(result).resolves.toBeUndefined();
    await drain;

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl).toHaveBeenCalledWith(`${SANDBOX_URL}/api/health`, expect.anything());
    // 4 failures → 4 inter-attempt gaps, the front-loaded sub-second start.
    expect(timer.ms).toEqual([500, 1000, 2000, 3000]);
  });

  it('treats a 200 without the JSON health body (dead-tunnel HTML page) as a failed attempt', async () => {
    // A zombie Modal tunnel answers 200+HTML forever — the probe must keep
    // retrying (and ultimately exhaust), never read it as "booted".
    const fetchImpl = makeHtmlFetch();
    const timer = makeControlledDelay();

    const result = startupHealthCheck({
      sandboxUrl: SANDBOX_URL,
      fetchImpl,
      delay: timer.delay,
      timeoutSignal: () => undefined,
      maxAttempts: 3,
    });
    const drain = (async () => {
      for (let i = 0; i < 10; i++) {
        await flush();
        timer.releaseAll();
      }
    })();
    await expect(result).rejects.toBeInstanceOf(StartupHealthCheckError);
    await drain;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('exhausts the SHORT local-first 6-attempt budget then throws StartupHealthCheckError', async () => {
    const fetchImpl = makeFetch([false]); // always fail
    const timer = makeControlledDelay();

    const result = startupHealthCheck({
      sandboxUrl: SANDBOX_URL,
      fetchImpl,
      delay: timer.delay,
      timeoutSignal: () => undefined,
    });
    const drain = (async () => {
      for (let i = 0; i < 14; i++) {
        await flush();
        timer.releaseAll();
      }
    })();

    await expect(result).rejects.toBeInstanceOf(StartupHealthCheckError);
    await drain;

    expect(STARTUP_MAX_ATTEMPTS).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(STARTUP_MAX_ATTEMPTS);
    // 6 attempts → 5 gaps: front-loaded [0.5,1,2,3,5] (~11.5s — no Modal cold boot).
    expect(timer.ms).toEqual([500, 1000, 2000, 3000, 5000]);
  });

  it('aborts the in-flight check (rejects AbortError) and stops probing', async () => {
    const fetchImpl = makeFetch([false]); // always fail → would keep retrying
    const timer = makeControlledDelay();
    const controller = new AbortController();

    const result = startupHealthCheck({
      sandboxUrl: SANDBOX_URL,
      fetchImpl,
      delay: timer.delay,
      signal: controller.signal,
      timeoutSignal: () => undefined,
    });
    const guarded = result.catch((err: unknown) => err);

    // Let the first probe run and the first backoff delay become pending.
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.pendingCount()).toBe(1);

    // Fire the abort: the pending delay rejects, the loop unwinds.
    controller.abort();
    const err = await guarded;
    expect(isStartupAbort(err)).toBe(true);

    // No further probes after the abort.
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────── Layer 2: StartupHealthGate (RNTL) ─────────────────────

describe('StartupHealthGate', () => {
  it('shows a loading state (not an error) throughout boot, then renders children when healthy', async () => {
    const fetchImpl = makeFetch([false, false, true]); // warm up on the 3rd probe
    const timer = makeControlledDelay();

    render(
      <StartupHealthGate
        deps={{
          getRelayUrl: async () => SANDBOX_URL,
          fetchImpl,
          delay: timer.delay,
        }}
      >
        <Text testID="app-children">app</Text>
      </StartupHealthGate>
    );

    // Boot: loading, never an error, children not yet shown.
    expect(screen.getByTestId('startup-health-loading')).toBeTruthy();
    expect(screen.queryByTestId('startup-health-failed')).toBeNull();
    expect(screen.queryByTestId('app-children')).toBeNull();

    // Step through the two failed probes; loading must persist throughout boot.
    await act(async () => {
      await flush();
      timer.releaseNext();
    });
    expect(screen.getByTestId('startup-health-loading')).toBeTruthy();
    expect(screen.queryByTestId('startup-health-failed')).toBeNull();

    await act(async () => {
      await flush();
      timer.releaseNext();
    });

    // The 3rd probe succeeds → children render, loading gone, never an error.
    await waitFor(() => expect(screen.getByTestId('app-children')).toBeTruthy());
    expect(screen.queryByTestId('startup-health-loading')).toBeNull();
    expect(screen.queryByTestId('startup-health-failed')).toBeNull();
  });

  it('aborts the in-flight check and runs cleanup on unmount (no further probes, no failed state)', async () => {
    const fetchImpl = makeFetch([false]); // always fail → would keep retrying
    const timer = makeControlledDelay();

    const view = render(
      <StartupHealthGate
        deps={{
          getRelayUrl: async () => SANDBOX_URL,
          fetchImpl,
          delay: timer.delay,
        }}
      >
        <Text testID="app-children">app</Text>
      </StartupHealthGate>
    );

    // First probe runs, first backoff delay is pending — still loading.
    await act(async () => {
      await flush();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.pendingCount()).toBe(1);
    expect(screen.getByTestId('startup-health-loading')).toBeTruthy();

    // Navigate away / sign out → unmount aborts the in-flight check (cleanup).
    view.unmount();
    await act(async () => {
      await flush();
    });

    // No further probes, and the abort did NOT flip the UI into a failed state.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(useStartupHealthStore.getState().phase).toBe('checking');
  });
});
