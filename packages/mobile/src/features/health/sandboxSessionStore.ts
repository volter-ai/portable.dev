/**
 * sandboxSessionStore — the sandbox-session EPOCH model.
 *
 * One "sandbox session" = one provisioned sandbox URL + the authenticated
 * subtree built on it (StartupHealthGate → ApiProvider → SocketProvider → app).
 * The app-shell keys that subtree on {@link SandboxSessionState.epoch}: when a
 * confirmed sandbox DEATH bumps the epoch, the whole subtree unmounts (the old
 * socket's io manager is stopped and every in-memory store resets via the
 * socket-provider cleanup) and remounts THROUGH the full-screen provisioning
 * gate — the same flow as a cold start. This replaces the old in-place
 * "recovery overlay + socket repoint" machinery, which left paths that kept
 * hammering the DEAD sandbox URL.
 *
 * `requestReprovision()` is the single death transition:
 *   1. set `reprovisioning` (synchronously — mutes further death signals and
 *      the socket lifecycle reconnect handlers while the switch happens);
 *   2. CLEAR the persisted sandbox URL (+ the authStore mirror) and reset the
 *      health stores — BEFORE the epoch bump, so the remounted provisioning
 *      gate never sees a stored URL pointing at the dead sandbox (no
 *      `fallthroughOnError` against a corpse);
 *   3. bump `epoch` → the keyed subtree remounts into the provisioning gate.
 *
 * The kept `authToken` is deliberate: sandbox death does not invalidate the
 * 72h Portable JWT, so re-provisioning needs NO Clerk re-exchange (the
 * provisioning gate's `auth-dead` path still handles a genuinely-revoked
 * token). `markSessionLive()` flips `reprovisioning` off once the provisioning
 * gate hands the tree back (the shell's `SessionLiveMarker`).
 *
 * In-memory zustand (NOT persisted): an app relaunch is epoch 0 by definition.
 */

import { create } from 'zustand';

import { clearRelayUrl } from '../api/relayUrlStore';
import { useSandboxHealthStore } from './healthStore';
import { useStartupHealthStore } from './startupHealthStore';

/**
 * Clear the authStore's sandbox-URL mirror via a LAZY require (the
 * forceSignOut/devModeStore pattern): this store sits in the socket feature's
 * import graph (`useNativeSocket` reads `reprovisioning`), and a static
 * `authStore` import would drag `state/storage`'s module-scope
 * `react-native-mmkv` import into every socket-importing Jest graph.
 */
function clearAuthStoreSandboxUrlMirror(): void {
  try {
    const { useAuthStore } = require('../state/authStore') as typeof import('../state/authStore');
    useAuthStore.getState().setSandboxUrl(null);
  } catch {
    // The mirror is non-authoritative — never block re-provisioning on it.
  }
}

export interface SandboxSessionState {
  /** Keys the app-shell's remount boundary — bumped once per re-provision. */
  epoch: number;
  /**
   * True from a death transition until the provisioning gate hands the tree
   * back. Mutes further death signals (single-flight) and the socket
   * lifecycle's AppState/NetInfo reconnect handlers.
   */
  reprovisioning: boolean;
  /**
   * True once a LIVE sandbox has been provisioned + verified in THIS epoch by
   * onboarding's concurrent provisioning. The app-shell's auto provisioning gate
   * reads it to SKIP a redundant re-provision pass right after onboarding — so a
   * first-time user lands straight in the app instead of sitting on a second
   * "Verifying your account…" screen. Reset on every re-provision (a death must
   * provision the new epoch from scratch), so it can never let a dead sandbox
   * slip through the verify-before-reuse.
   */
  provisioned: boolean;

  /**
   * The death transition: clear the dead sandbox URL (SecureStore + the
   * authStore mirror), reset the health stores, and bump the epoch so the
   * keyed subtree remounts through the provisioning gate. Single-flight — a
   * call while already `reprovisioning` is a no-op.
   */
  requestReprovision: () => Promise<void>;
  /** Provisioning handed the tree back — re-arm death handling. */
  markSessionLive: () => void;
  /**
   * Onboarding's concurrent provisioning landed a live sandbox this epoch — the
   * auto provisioning gate may skip its redundant pass.
   */
  markProvisioned: () => void;
  /** Test-only: back to the initial state (epoch 0, not reprovisioning). */
  reset: () => void;
}

export const useSandboxSessionStore = create<SandboxSessionState>()((set, get) => ({
  epoch: 0,
  reprovisioning: false,
  provisioned: false,

  requestReprovision: async () => {
    if (get().reprovisioning) return;
    // Mute death signals SYNCHRONOUSLY — the clears below are async and the
    // monitor/coordinator may fire again in between. Clearing `provisioned`
    // here guarantees the remounted gate re-provisions the new epoch (never
    // trusts the dead sandbox).
    set({ reprovisioning: true, provisioned: false });

    try {
      // Clears ONLY the LEGACY sandbox URL. Local-first: the connected PC id +
      // its device token are deliberately PRESERVED, so the
      // remounted gate resolves the SAME stable per-PC base (`<gatewayBase>/t/<pcId>`)
      // and RECONNECTS — a QR re-link happens only when the gateway reports the PC is
      // truly gone / unowned (the picker), never on a routine rotation/death.
      await clearRelayUrl();
    } catch {
      // A failed keychain delete must not block re-provisioning: the gate
      // overwrites the URL on completion anyway.
    }
    clearAuthStoreSandboxUrlMirror();
    useSandboxHealthStore.getState().reset();
    useStartupHealthStore.getState().reset();

    // The bump LAST: by now the dead URL is gone, so the remounted
    // provisioning gate resolves with `hasStoredUrl: false`.
    set((s) => ({ epoch: s.epoch + 1 }));
  },

  markSessionLive: () => set({ reprovisioning: false }),

  markProvisioned: () => set({ provisioned: true }),

  reset: () => set({ epoch: 0, reprovisioning: false, provisioned: false }),
}));
