/**
 * Startup-health store.
 *
 * Surfaces the cold-start `startupHealthCheck` progress to the UI as plain
 * Zustand state (there is no DOM / event bus in React Native). The boot gate
 * (`StartupHealthGate`) reads `phase`:
 *
 *   - `checking` → the sandbox is warming up; show the LOADING state.
 *   - `ready`    → the sandbox answered `200`; render the app.
 *   - `failed`   → the attempt budget was exhausted; hand off to the recovery /
 *                  ConnectionFailed UX. An ABORT (navigate away / sign out) does
 *                  NOT move to `failed` — it leaves `checking` and lets the gate
 *                  unmount.
 *
 * NOT persisted: the boot check re-runs on every cold launch (mirrors
 * `healthStore` / `socketStore`).
 */

import { create } from 'zustand';

/** Coarse cold-start boot phase. */
export type StartupHealthPhase = 'checking' | 'ready' | 'failed';

export interface StartupHealthState {
  /** Current boot phase. Starts `checking` (optimistic loading on launch). */
  phase: StartupHealthPhase;
  /** 1-based number of the latest probe attempt (for an optional "attempt N" UI). */
  attempt: number;

  /** Begin a fresh cold-start check (loading). */
  markChecking: () => void;
  /** Record the current probe attempt number. */
  setAttempt: (attempt: number) => void;
  /** Sandbox answered `200` — boot complete. */
  markReady: () => void;
  /** Attempt budget exhausted — hand off to recovery / ConnectionFailed. */
  markFailed: () => void;
  /** Reset to the initial loading phase (new sandbox / re-check). */
  reset: () => void;
}

const initialPhase: StartupHealthPhase = 'checking';

export const useStartupHealthStore = create<StartupHealthState>()((set) => ({
  phase: initialPhase,
  attempt: 0,
  markChecking: () => set({ phase: 'checking', attempt: 0 }),
  setAttempt: (attempt) => set({ attempt }),
  markReady: () => set({ phase: 'ready' }),
  markFailed: () => set({ phase: 'failed' }),
  reset: () => set({ phase: initialPhase, attempt: 0 }),
}));
