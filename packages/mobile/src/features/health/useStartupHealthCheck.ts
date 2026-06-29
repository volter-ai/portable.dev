/**
 * useStartupHealthCheck — the RN ViewModel for the cold-start boot check.
 *
 * Wires the framework-free {@link startupHealthCheck} to the React Native
 * lifecycle and the {@link useStartupHealthStore}:
 *
 *   - On mount it resolves the mutable sandbox base URL and runs
 *     the backoff check, folding progress into the store: `checking` (loading)
 *     while probing, `ready` on the first `200`, `failed` once the budget is
 *     exhausted.
 *   - On unmount (navigate away / sign out) it ABORTS the in-flight check via an
 *     `AbortController`: the pending backoff delay and the in-flight probe both
 *     cancel, and the abort is swallowed (NOT surfaced as `failed`) — the gate
 *     is being torn down, so there is nothing to show. This is the required
 *     cleanup path.
 *
 * Every seam (sandbox URL, fetch, the runner itself, the backoff delay) is
 * injectable so the hook is driven deterministically in tests with no device,
 * no native runtime, and mocked timers.
 */

import { useEffect } from 'react';

import { getRelayUrl as defaultGetRelayUrl } from '../api/relayUrlStore';
import {
  isStartupAbort,
  startupHealthCheck as defaultStartupHealthCheck,
  type StartupHealthCheckDeps,
} from './startupHealthCheck';
import { useStartupHealthStore, type StartupHealthPhase } from './startupHealthStore';

export interface UseStartupHealthCheckDeps {
  /** Resolve the mutable sandbox base URL (default: SecureStore). */
  getRelayUrl?: () => Promise<string | null>;
  /** `fetch` used for the probe (default: global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Abortable backoff delay (forwarded to the runner). Injected in tests. */
  delay?: StartupHealthCheckDeps['delay'];
  /** The check runner (default {@link startupHealthCheck}). Injected in tests. */
  runCheck?: (deps: StartupHealthCheckDeps) => Promise<void>;
  /**
   * Fired once when the attempt budget is exhausted (the `failed` flip) — the
   * app-shell wires this into the sandbox-death handler so a new sandbox whose
   * server never boots re-provisions (guard-capped) instead of dead-ending on
   * the static failed screen. An ABORT never fires it.
   */
  onUnhealthy?: () => void;
}

export interface UseStartupHealthCheckHandle {
  /** Current boot phase (drives the gate). */
  phase: StartupHealthPhase;
}

export function useStartupHealthCheck(
  deps: UseStartupHealthCheckDeps = {}
): UseStartupHealthCheckHandle {
  const getRelayUrl = deps.getRelayUrl ?? defaultGetRelayUrl;
  const runCheck = deps.runCheck ?? defaultStartupHealthCheck;
  const phase = useStartupHealthStore((s) => s.phase);

  useEffect(() => {
    const controller = new AbortController();
    const store = useStartupHealthStore.getState();
    store.markChecking();

    void (async () => {
      const url = await getRelayUrl();
      // Aborted while resolving the URL (e.g. fast sign-out) → nothing to do.
      if (controller.signal.aborted) return;
      // No sandbox yet means provisioning has not completed — that is the
      // provisioning flow's loading UX, not a cold-start failure. Stay
      // `checking` and let the composition layer route there.
      if (!url) return;

      try {
        await runCheck({
          sandboxUrl: url,
          fetchImpl: deps.fetchImpl,
          signal: controller.signal,
          delay: deps.delay,
          onAttempt: (attempt) => useStartupHealthStore.getState().setAttempt(attempt),
        });
        if (!controller.signal.aborted) useStartupHealthStore.getState().markReady();
      } catch (err) {
        // Abort = teardown/cleanup; never flip the UI into a failed state.
        if (isStartupAbort(err) || controller.signal.aborted) return;
        useStartupHealthStore.getState().markFailed();
        deps.onUnhealthy?.();
      }
    })();

    // Cleanup: cancel the in-flight check (in-flight probe + pending backoff).
    return () => controller.abort();
    // Run exactly once per mount. The seams are read at mount (parity with the
    // health monitor / socket provider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { phase };
}
