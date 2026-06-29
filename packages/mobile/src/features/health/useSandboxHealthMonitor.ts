/**
 * useSandboxHealthMonitor — the RN ViewModel for the PC health monitor
 * (local-first).
 *
 * Wires the framework-free `SandboxHealthMonitor` (`@vgit2/shared/sandbox`) to
 * React Native's lifecycle, which the shared core deliberately does NOT know
 * about:
 *
 *   - NetInfo → `setNetworkConnected(isConnected)`. Going offline FREEZES the
 *     90s failure accumulator; coming back online RESUMES it.
 *   - AppState → background/inactive: `stopHealthPolling()` (freeze + stop
 *     polling so a backgrounded app neither drains the battery nor accrues
 *     bogus failure time); foreground `active`: `reset()` then re-`start` so a
 *     returning user gets a fresh 90s window AND polling resumes immediately.
 *
 * It polls `GET {pcUrl}/api/health` through the relay (the stable base resolved by
 * `getRelayUrl`). The signals fold into `useSandboxHealthStore`: `onStatusChange`
 * → reconnecting/healthy, `onConnectionFailed` (90s of CONTINUOUS, network-connected
 * failure) → `failed` AND the death handler (`onSandboxDead`).
 *
 * **Local-first:** there is no "authoritative liveness" gateway endpoint — the
 * gateway only relays, so it cannot tell whether the PC's backend is up. The relay
 * `/api/health` accumulator IS the liveness signal (the old `SandboxLivenessCoordinator`
 * + gateway `/sandbox/status` check were retired and deleted). A mid-session PC
 * death is therefore detected by the 90s trip, which hands off to the epoch-remount
 * recovery (StartupHealthGate re-checks the same relay; on failure → ConnectionFailed
 * with the "Connect PC" re-scan exit).
 *
 * All seams (PC URL, fetch, AppState, NetInfo, the monitor itself, the clock +
 * timers it uses) are injectable so the thresholds are exercised deterministically
 * in tests without real timers.
 */

import { SandboxHealthMonitor } from '@vgit2/shared/sandbox';
import { useEffect, useRef } from 'react';

import { getRelayUrl as defaultGetRelayUrl } from '../api/relayUrlStore';
import {
  defaultAppState,
  defaultNetInfo,
  type AppStateLike,
  type NetInfoLike,
} from '../socket/lifecycle';
import { useSandboxHealthStore } from './healthStore';

export interface SandboxHealthMonitorDeps {
  /** Resolve the mutable PC relay base URL (default: SecureStore). Polling waits until non-null. */
  getRelayUrl?: () => Promise<string | null>;
  /** `fetch` used for the health probe (default: global `fetch`). */
  fetchImpl?: typeof fetch;
  /** AppState source (default: React Native `AppState`). */
  appState?: AppStateLike;
  /** NetInfo source (default: `@react-native-community/netinfo`). */
  netInfo?: NetInfoLike;
  /**
   * Provide a pre-built monitor (tests inject deterministic clock/timer seams).
   * When omitted, one is constructed wired to {@link fetchImpl} + the health store.
   */
  createMonitor?: () => SandboxHealthMonitor;
  /**
   * Fired on a CONFIRMED death — 90s of continuous, network-connected health-poll
   * failure. Default: trip ConnectionFailed on the monitor (→ store `failed`); the
   * app-shell wires it to the session-boundary death handler (epoch remount).
   */
  onSandboxDead?: () => void;
}

export interface SandboxHealthMonitorHandle {
  /** The underlying monitor (exposed for foreground re-point / diagnostics). */
  monitor: SandboxHealthMonitor;
  /**
   * Re-read the PC URL and restart polling with a FRESH 90s window — the foreground
   * `active` transition's reset path. (A death re-provision REMOUNTS this hook per
   * session epoch, so a fresh monitor reads the new URL at mount.)
   */
  restartPolling: () => Promise<void>;
}

export function useSandboxHealthMonitor(
  deps: SandboxHealthMonitorDeps = {}
): SandboxHealthMonitorHandle {
  const getRelayUrl = deps.getRelayUrl ?? defaultGetRelayUrl;

  // Latest deps for the once-built closures below (the useNativeSocket pattern).
  const depsRef = useRef(deps);
  depsRef.current = deps;

  // Build the monitor exactly once. Status/failure signals fold into the store;
  // a confirmed failure (90s trip) is also the death signal in local-first.
  const monitorRef = useRef<SandboxHealthMonitor | null>(null);
  if (monitorRef.current === null) {
    monitorRef.current =
      deps.createMonitor?.() ??
      new SandboxHealthMonitor({
        fetchImpl: deps.fetchImpl,
        onStatusChange: (status) => {
          const store = useSandboxHealthStore.getState();
          if (status === 'connected') store.markHealthy();
          else store.markReconnecting();
        },
        onConnectionFailed: () => {
          useSandboxHealthStore.getState().markFailed();
          // 90s of continuous failure = the PC is unreachable → hand off to recovery.
          (depsRef.current.onSandboxDead ?? (() => {}))();
        },
      });
  }
  const monitor = monitorRef.current;

  // Resolve the PC URL and (re)start polling.
  const startPolling = useRef(async () => {
    const url = await getRelayUrl();
    if (url) monitor.startHealthPolling(url);
  });

  // Fresh window + re-read URL — shared by the foreground `active` transition.
  // `startHealthPolling` with a NEW URL releases the death latch and moves the poll target.
  const restartPolling = useRef(async () => {
    monitor.reset();
    useSandboxHealthStore.getState().reset();
    await startPolling.current();
  });

  // --- Start polling on mount; stop + freeze on unmount ---
  useEffect(() => {
    void startPolling.current();
    return () => monitor.stopHealthPolling();
  }, [monitor]);

  // --- NetInfo: freeze the accumulator while offline, resume on reconnect ---
  useEffect(() => {
    const netInfo = deps.netInfo ?? defaultNetInfo;
    const unsub = netInfo.addEventListener((state) => {
      // `isConnected` may be `null` (unknown) early on — treat only an explicit
      // `false` as offline so we never freeze on an indeterminate state.
      monitor.setNetworkConnected(state.isConnected !== false);
    });
    return unsub;
    // deps.netInfo is read once on mount (parity with the socket provider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitor]);

  // --- AppState: freeze while backgrounded, fresh 90s window on foreground ---
  useEffect(() => {
    const appState = deps.appState ?? defaultAppState;
    const sub = appState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Returning user gets a clean slate AND polling resumes immediately.
        void restartPolling.current();
      } else if (next === 'background' || next === 'inactive') {
        // Freeze the accumulator and stop draining the battery in the background.
        monitor.stopHealthPolling();
      }
    });
    return () => sub.remove();
    // deps.appState is read once on mount (parity with the socket provider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitor]);

  return { monitor, restartPolling: restartPolling.current };
}
