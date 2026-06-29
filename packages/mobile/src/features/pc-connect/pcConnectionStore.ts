/**
 * pcConnectionStore — the in-memory signal that returns the app to the PC-connect
 * QR scanner.
 *
 * The boot-time PC-connect gate ({@link PcConnectGateHost}) checks the stored pcId
 * ONCE on mount: a persisted pcId renders the authenticated tree, none mounts the
 * scanner. Once a PC is connected there is no built-in way back to the scanner — but
 * the Runtime tab's "Disconnect" action needs exactly that: drop this device's pairing
 * and return to the connection page so the user can pair a (new) PC.
 *
 * This store is that one-way signal. {@link disconnectPc} clears the stored pcId + the
 * per-PC data-path JWT, then calls `signalDisconnected()`, which bumps a monotonic
 * counter; `PcConnectGateHost` watches the counter and flips back to the scanner the
 * moment it CHANGES (deliberately NOT "when it is > 0" — so a host remount while
 * already reconnected can never spuriously re-open the scanner).
 *
 * It is the disconnect counterpart of `sandboxSessionStore.requestReprovision()`, but
 * the two are opposites: a sandbox death PRESERVES the connected PC + token (it must
 * not lose the pairing) and bumps the epoch BELOW `PcConnectGateHost` (the session
 * boundary), so it can never return to the scanner; disconnect deliberately DROPS the
 * pairing and signals the gate itself. Hence a separate signal.
 *
 * In-memory zustand (NOT persisted): an app relaunch starts at 0 and the boot gate's
 * own stored-pcId check decides the initial screen.
 */

import { create } from 'zustand';

export interface PcConnectionState {
  /**
   * Monotonic counter bumped once per explicit disconnect. `PcConnectGateHost`
   * returns to the QR scanner when this value CHANGES.
   */
  disconnectSignal: number;
  /** Signal an explicit disconnect (called AFTER the stored pcId + JWT are cleared). */
  signalDisconnected: () => void;
  /** Reset to the initial state (test hygiene). */
  reset: () => void;
}

export const usePcConnectionStore = create<PcConnectionState>((set) => ({
  disconnectSignal: 0,
  signalDisconnected: () => set((s) => ({ disconnectSignal: s.disconnectSignal + 1 })),
  reset: () => set({ disconnectSignal: 0 }),
}));
