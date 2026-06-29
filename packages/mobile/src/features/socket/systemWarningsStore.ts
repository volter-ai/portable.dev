/**
 * System-warning store — warnings + lifecycle routing.
 *
 * The server emits `system:*` / `session:expired` lifecycle events before (or as)
 * a sandbox is torn down. There is no DOM in React Native, so the provider folds
 * these events into this Zustand store and the `SystemWarnings` component renders
 * them as native modals/banners — and the RN client NEVER navigates via
 * `window.location.href`.
 *
 * Two distinct concerns live here:
 *   - **Warnings** (`idleWarning`) are advisory: the session is still alive and
 *     the user can act ("I'm still here" extends it).
 *   - **Session ended** (`sessionEnded`) is terminal: the sandbox session is gone
 *     (`system:idle_shutdown` / `session:expired`) and the app routes to a
 *     re-provision / loading state.
 *
 * `system:shutdown_warning` is deliberately NOT held here — the RN client has no
 * pending-shutdown banner (sandbox death recovers transparently).
 *
 * NOT persisted: warnings are transient and rebuilt from live socket events on
 * every mount (mirrors `socketStore` / `runtimeStore`).
 */

import { create } from 'zustand';

/** Idle warning ("Are you still there?") with a server-provided countdown. */
export interface IdleWarning {
  message: string;
  /** Seconds remaining before idle shutdown (server-provided). */
  timeRemaining: number;
}

/** What ended the session and dropped the user into the re-provision/loading state. */
export type SessionEndReason = 'idle_shutdown' | 'session_expired';

/** Terminal lifecycle state: the session is gone, routing to re-provision/loading. */
export interface SessionEnded {
  reason: SessionEndReason;
  message: string;
}

export interface SystemWarningsState {
  /** Active idle warning, or `null` when none / cleared. */
  idleWarning: IdleWarning | null;
  /**
   * Terminal "session is gone → re-provision/loading" state, or `null` while the
   * session is live. Set by `system:idle_shutdown` or `session:expired`.
   */
  sessionEnded: SessionEnded | null;

  /** Show the idle warning (`system:idle_warning`). */
  setIdleWarning: (warning: IdleWarning) => void;
  /** Clear the idle warning (`system:idle_warning_cleared` or "I'm still here"). */
  clearIdleWarning: () => void;
  /**
   * Enter the terminal re-provision/loading state; clears all advisory warnings
   * (the session is gone — the "are you still there?" surface no longer applies).
   */
  setSessionEnded: (ended: SessionEnded) => void;
  /** Leave the re-provision/loading state (recovery succeeded / aborted). */
  clearSessionEnded: () => void;
  /** Reset all warnings + lifecycle (socket unmount). */
  reset: () => void;
}

const initialState = {
  idleWarning: null as IdleWarning | null,
  sessionEnded: null as SessionEnded | null,
};

export const useSystemWarningsStore = create<SystemWarningsState>()((set) => ({
  ...initialState,
  setIdleWarning: (idleWarning) => set({ idleWarning }),
  clearIdleWarning: () => set({ idleWarning: null }),
  // The terminal notice supersedes every advisory warning.
  setSessionEnded: (sessionEnded) => set({ sessionEnded, idleWarning: null }),
  clearSessionEnded: () => set({ sessionEnded: null }),
  reset: () => set({ ...initialState }),
}));
