/**
 * SandboxSessionBoundary — the epoch-keyed remount boundary for the
 * authenticated subtree.
 *
 * Sits ABOVE the provisioning gate in the app-shell ladder and owns the two
 * pieces of death handling that must SURVIVE a re-provision:
 *
 *   - the {@link useSandboxDeathHandler} (RecoveryLoopGuard window + the
 *     terminal ConnectionFailed state), exposed to the subtree through
 *     {@link SandboxDeathContext} so the health monitor, the socket
 *     `onReprovision` hand-off, and the startup gate all funnel into ONE
 *     handler;
 *   - the `<Fragment key={epoch}>` remount line: a death bumps the session
 *     epoch (see `sandboxSessionStore`), which unmounts EVERYTHING below —
 *     the old socket's io manager is stopped and the in-memory stores reset by
 *     the socket-provider cleanup; nothing is left to hammer the dead URL —
 *     and remounts it through the full-screen provisioning gate, exactly like
 *     a cold start.
 *
 * When the guard window is exhausted the boundary REPLACES the subtree with
 * `ConnectionFailedScreen` (the dead socket unmounts with it); "Try again"
 * resets the window and re-provisions.
 */

import { createContext, Fragment, useContext, type ReactNode } from 'react';

import { ConnectionFailedScreen } from '../health/ConnectionFailedScreen';
import {
  useSandboxDeathHandler,
  type UseSandboxDeathHandlerDeps,
} from '../health/useSandboxDeathHandler';
import { useSandboxSessionStore } from '../health/sandboxSessionStore';

/**
 * The death handler for the CURRENT shell. Default no-op so primitives mounted
 * outside the boundary (unit tests) stay inert.
 */
const SandboxDeathContext = createContext<() => void>(() => {});

/** The boundary's death handler — every death signal below funnels into it. */
export function useSandboxDeath(): () => void {
  return useContext(SandboxDeathContext);
}

export interface SandboxSessionBoundaryProps extends UseSandboxDeathHandlerDeps {
  /** Full override of the death handler (router-level tests inject a spy). */
  onDeath?: () => void;
  children: ReactNode;
}

export function SandboxSessionBoundary({
  onDeath: onDeathOverride,
  children,
  ...handlerDeps
}: SandboxSessionBoundaryProps) {
  const epoch = useSandboxSessionStore((s) => s.epoch);
  const handler = useSandboxDeathHandler(handlerDeps);
  const onDeath = onDeathOverride ?? handler.onDeath;

  if (handler.failed) {
    return (
      <ConnectionFailedScreen
        reason={handler.reason}
        onTryAgain={() => void handler.retry()}
        retrying={handler.retrying}
      />
    );
  }

  return (
    <SandboxDeathContext.Provider value={onDeath}>
      <Fragment key={epoch}>{children}</Fragment>
    </SandboxDeathContext.Provider>
  );
}
