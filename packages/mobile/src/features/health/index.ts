/**
 * Sandbox health monitor feature — barrel.
 *
 * Proactive 5s/90s health-poll liveness detection on top of the framework-free
 * `SandboxHealthMonitor` (`@vgit2/shared/sandbox`). The relay `/api/health`
 * accumulator is the SOLE liveness signal in local-first — the gateway
 * `/sandbox/status` "authoritative liveness" coordinator was deleted (the
 * gateway only relays; it cannot tell whether the PC's backend is up).
 * Death → clear the dead sandbox URL → bump the session epoch → the app-shell
 * remounts the subtree through the full-screen provisioning gate
 * (`sandboxSessionStore` + `useSandboxDeathHandler`; no re-login — the
 * authToken is preserved).
 */

export { useSandboxHealthStore } from './healthStore';
export type { SandboxHealthPhase, SandboxHealthState } from './healthStore';
export { useSandboxHealthMonitor } from './useSandboxHealthMonitor';
export type {
  SandboxHealthMonitorDeps,
  SandboxHealthMonitorHandle,
} from './useSandboxHealthMonitor';

// The sandbox-session epoch model — death → clear the dead sandbox URL → bump
// the epoch → the app-shell's keyed subtree remounts through the full-screen
// provisioning gate (replaces the old recoverSandbox/repoint flow).
export { useSandboxSessionStore } from './sandboxSessionStore';
export type { SandboxSessionState } from './sandboxSessionStore';
export { useSandboxDeathHandler } from './useSandboxDeathHandler';
export type { SandboxDeathHandle, UseSandboxDeathHandlerDeps } from './useSandboxDeathHandler';

// Cold-start startup health check (backoff).
export {
  startupHealthCheck,
  startupBackoffDelayMs,
  isStartupAbort,
  StartupHealthCheckError,
  STARTUP_BACKOFF_SECONDS,
  STARTUP_BACKOFF_CAP_SECONDS,
  STARTUP_MAX_ATTEMPTS,
  STARTUP_HEALTH_TIMEOUT_MS,
} from './startupHealthCheck';
export type { StartupHealthCheckDeps } from './startupHealthCheck';
export { useStartupHealthStore } from './startupHealthStore';
export type { StartupHealthPhase, StartupHealthState } from './startupHealthStore';
export { useStartupHealthCheck } from './useStartupHealthCheck';
export type {
  UseStartupHealthCheckDeps,
  UseStartupHealthCheckHandle,
} from './useStartupHealthCheck';
export { StartupHealthGate } from './StartupHealthGate';
export type { StartupHealthGateProps } from './StartupHealthGate';

// Recovery-loop guard + ConnectionFailed UX.
export {
  RecoveryLoopGuard,
  MAX_RECOVERIES_PER_WINDOW,
  RECOVERY_WINDOW_MS,
} from './recoveryLoopGuard';
export type { RecoveryLoopGuardOptions } from './recoveryLoopGuard';
export { useConnectionFailedStore } from './connectionFailedStore';
export type { ConnectionFailedReason, ConnectionFailedState } from './connectionFailedStore';
export { ConnectionFailedScreen } from './ConnectionFailedScreen';
export type { ConnectionFailedScreenProps } from './ConnectionFailedScreen';
