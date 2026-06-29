/**
 * Sandbox-health store.
 *
 * Surfaces the `SandboxHealthMonitor` (`@vgit2/shared/sandbox`) phase to the UI
 * as plain Zustand state (there is no DOM / event bus in React Native, unlike a
 * client that emits `sandbox-monitor-status` / `sandbox-connection-failed` on a
 * window bus). A reconnecting banner reads `status === 'reconnecting'`; the
 * ConnectionFailed UX reads `status === 'failed'`.
 *
 * NOT persisted: liveness is rebuilt from live health polls on every mount
 * (mirrors `socketStore` / `systemWarningsStore`).
 */

import { create } from 'zustand';

/** Coarse sandbox health phase. */
export type SandboxHealthPhase = 'healthy' | 'reconnecting' | 'failed';

export interface SandboxHealthState {
  /** Current health phase. Starts `healthy` (optimistic until a failure run). */
  status: SandboxHealthPhase;

  /** Health checks are passing (or just recovered). */
  markHealthy: () => void;
  /** Health checks are failing but the 90s threshold has not tripped yet. */
  markReconnecting: () => void;
  /** 90s of continuous network-connected failure — sandbox declared down. */
  markFailed: () => void;
  /** Reset to the optimistic initial phase (foreground `active` / new sandbox). */
  reset: () => void;
}

const initialStatus: SandboxHealthPhase = 'healthy';

export const useSandboxHealthStore = create<SandboxHealthState>()((set) => ({
  status: initialStatus,
  markHealthy: () => set({ status: 'healthy' }),
  markReconnecting: () => set({ status: 'reconnecting' }),
  markFailed: () => set({ status: 'failed' }),
  reset: () => set({ status: initialStatus }),
}));
