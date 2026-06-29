/**
 * connectionFailedStore — drives the native ConnectionFailed screen.
 *
 * When automatic recovery is exhausted (3 recoveries in a 5-minute window, see
 * {@link RecoveryLoopGuard}) the ViewModel STOPS auto-recovery and raises this
 * terminal "connection failed" state, which the `ConnectionFailedScreen` reads.
 * It is distinct from the transient `useSandboxHealthStore` `failed` phase
 * (a single 90s trip) — this one means "we've stopped trying; over to you".
 *
 * The {@link ConnectionFailedReason} keys the copy: `pc-down` ("we can't
 * reach your workspace") vs `offline` ("you're offline"), chosen from the live
 * NetInfo state. In-memory only (not persisted) — same as the other recovery stores.
 */

import { create } from 'zustand';

/** Why the connection failed — selects the screen copy. */
export type ConnectionFailedReason = 'pc-down' | 'offline';

export interface ConnectionFailedState {
  /** Whether the terminal ConnectionFailed screen should be shown. */
  visible: boolean;
  /** The reason for the failure (drives the copy). */
  reason: ConnectionFailedReason;

  /** Show the ConnectionFailed screen with the given reason (auto-recovery stopped). */
  show: (reason: ConnectionFailedReason) => void;
  /** Update the reason while the screen stays visible (NetInfo changed). */
  setReason: (reason: ConnectionFailedReason) => void;
  /** Hide the screen (recovered, or the user tapped "Try again"). */
  hide: () => void;
}

export const useConnectionFailedStore = create<ConnectionFailedState>()((set) => ({
  visible: false,
  reason: 'pc-down',
  show: (reason) => set({ visible: true, reason }),
  setReason: (reason) => set({ reason }),
  hide: () => set({ visible: false }),
}));
