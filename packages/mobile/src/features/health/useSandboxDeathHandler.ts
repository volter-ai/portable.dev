/**
 * useSandboxDeathHandler — the guard-capped sandbox-death handler.
 *
 * `onDeath` is the ONE handler every death signal funnels into (the health
 * monitor's `onSandboxDead` / `onReprovisionNeeded`, the `system:idle_shutdown`
 * / `session:expired` re-provision hand-off, and the startup gate's boot
 * exhaustion):
 *
 *   - while a re-provision is already in flight (`reprovisioning`), further
 *     signals are expected noise → no-op, no guard slot;
 *   - {@link RecoveryLoopGuard} caps automatic re-provisions (3 per 5-minute
 *     window). An exhausted window raises the terminal ConnectionFailed state
 *     (`useConnectionFailedStore`) — the app-shell's session boundary then
 *     UNMOUNTS the authenticated subtree and shows `ConnectionFailedScreen`;
 *   - otherwise → `requestReprovision()` (clear the dead sandbox URL + bump
 *     the session epoch → the subtree remounts through the full-screen
 *     provisioning gate; see `sandboxSessionStore`).
 *
 * `retry` is the screen's "Try again": reset the guard window, hide the
 * screen, and re-provision. There is NO Gateway-status pre-check anymore —
 * the gateway-authoritative provisioning pass (which now verifies an existing
 * sandbox is genuinely alive before reusing it) IS the status check: a live
 * sandbox returns a near-immediate `sandbox-ready`.
 *
 * The failure copy ("can't reach your workspace" vs "you're offline") is
 * chosen from the live NetInfo state and kept current while the screen is up.
 * Every seam (guard clock, NetInfo, the re-provision action) is injectable so
 * the guard contract runs deterministically in Jest.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultNetInfo, type NetInfoLike } from '../socket/lifecycle';
import { useConnectionFailedStore, type ConnectionFailedReason } from './connectionFailedStore';
import { RecoveryLoopGuard } from './recoveryLoopGuard';
import { useSandboxSessionStore } from './sandboxSessionStore';

export interface UseSandboxDeathHandlerDeps {
  /** Pre-built guard (tests inject a deterministic clock). Default: real clock. */
  guard?: RecoveryLoopGuard;
  /** NetInfo source for the offline-vs-pc-down copy (default: RN NetInfo). */
  netInfo?: NetInfoLike;
  /** The re-provision action (default: the session store's `requestReprovision`). */
  requestReprovision?: () => Promise<void>;
}

export interface SandboxDeathHandle {
  /** THE death handler — wire every death signal into this. */
  onDeath: () => void;
  /** "Try again" — reset the guard window, hide the screen, re-provision. */
  retry: () => Promise<void>;
  /** Whether a "Try again" re-provision kick is in flight. */
  retrying: boolean;
  /** Whether the terminal ConnectionFailed screen should be shown. */
  failed: boolean;
  /** The failure reason driving the screen copy. */
  reason: ConnectionFailedReason;
}

export function useSandboxDeathHandler(deps: UseSandboxDeathHandlerDeps = {}): SandboxDeathHandle {
  // The guard is built once (a re-render must not reset the sliding window).
  const guardRef = useRef<RecoveryLoopGuard | null>(null);
  if (guardRef.current === null) {
    guardRef.current = deps.guard ?? new RecoveryLoopGuard();
  }
  const guard = guardRef.current;

  // Latest known connectivity (default: connected — `null`/unknown is NOT offline).
  const connectedRef = useRef(true);

  const store = useConnectionFailedStore();
  const [retrying, setRetrying] = useState(false);

  // Track NetInfo so the failure copy reflects the live connectivity state.
  useEffect(() => {
    const netInfo = deps.netInfo ?? defaultNetInfo;
    const unsub = netInfo.addEventListener((state) => {
      // Only an explicit `false` is offline (`null` = unknown ≠ offline).
      const connected = state.isConnected !== false;
      connectedRef.current = connected;
      // Keep the copy correct if connectivity flips while the screen is up.
      if (useConnectionFailedStore.getState().visible) {
        useConnectionFailedStore.getState().setReason(connected ? 'pc-down' : 'offline');
      }
    });
    return unsub;
    // deps.netInfo is read once on mount (parity with the other recovery ViewModels).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reasonFromNetwork = (): ConnectionFailedReason =>
    connectedRef.current ? 'pc-down' : 'offline';

  const requestReprovisionRef = useRef(deps.requestReprovision);
  requestReprovisionRef.current = deps.requestReprovision;
  const requestReprovision = useCallback(async () => {
    const action =
      requestReprovisionRef.current ??
      (() => useSandboxSessionStore.getState().requestReprovision());
    await action();
  }, []);

  const onDeath = useCallback(() => {
    // A re-provision is already in flight — further death signals are expected
    // noise (the dead URL keeps failing until the subtree remounts). No slot.
    if (useSandboxSessionStore.getState().reprovisioning) return;
    // Window exhausted → stop automatic re-provisioning and raise the terminal
    // screen (the session boundary unmounts the subtree underneath it).
    if (!guard.tryConsume()) {
      useConnectionFailedStore.getState().show(reasonFromNetwork());
      return;
    }
    void requestReprovision();
    // guard is a stable ref; reasonFromNetwork only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestReprovision]);

  const retry = useCallback(async () => {
    // Re-arm automatic re-provisioning, drop the screen, and go again. The
    // provisioning pass is gateway-authoritative — if the sandbox is actually
    // alive it answers near-immediately, so no separate status pre-check.
    guard.reset();
    setRetrying(true);
    try {
      useConnectionFailedStore.getState().hide();
      await requestReprovision();
    } finally {
      setRetrying(false);
    }
    // guard is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestReprovision]);

  return {
    onDeath,
    retry,
    retrying,
    failed: store.visible,
    reason: store.reason,
  };
}
