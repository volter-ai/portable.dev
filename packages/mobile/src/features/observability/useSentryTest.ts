/**
 * ViewModel for the dev-mode Sentry test page.
 *
 * Lets a
 * developer fire the three classes of error and confirm Sentry is live on a real
 * device build: (1) an UNCAUGHT async throw → the RN global handler; (2) a RENDER
 * error caught by a scoped `Sentry.ErrorBoundary`; (3) a manual
 * `Sentry.captureException`.
 *
 * Every I/O seam is injectable so the VM is unit-testable WITHOUT actually
 * throwing (the default `scheduleUncaught` records-then-`setTimeout`s the throw; a
 * test injects a spy that never invokes it, so the suite doesn't crash).
 */

import { useCallback, useMemo, useState } from 'react';
import * as Sentry from '@sentry/react-native';

import { getSentryRuntimeInfo } from './initSentry';

export interface SentryTestDeps {
  /** Manual capture (default `Sentry.captureException`). Returns the event id. */
  captureException?: (error: unknown) => string | undefined;
  /** Schedule the uncaught throw (default `setTimeout(fn, 0)`). Tests inject a spy. */
  scheduleUncaught?: (throwFn: () => void) => void;
  /** Runtime client info (default reads the live client). */
  runtimeInfo?: () => ReturnType<typeof getSentryRuntimeInfo>;
  /** Deterministic timestamp for the error messages (default `() => new Date().toISOString()`). */
  now?: () => string;
}

export interface SentryTestViewModel {
  /** Free-text status of the last action. */
  status: string;
  /** Whether a Sentry client is active (DSN resolved + init ran). */
  sentryActive: boolean;
  /** Display string for the active environment + release/dist. */
  runtimeLabel: string;
  /** Whether the render bomb is armed (the screen throws while true). */
  bombArmed: boolean;
  /** Fire an uncaught async error → the RN global handler → Sentry. */
  throwUncaught: () => void;
  /** Arm the render bomb (the next render throws, caught by the scoped boundary). */
  armBomb: () => void;
  /** Reset the render bomb (the boundary fallback's "Reset"). */
  resetBomb: () => void;
  /** Called by the scoped boundary's `onError` once it catches the render throw. */
  onBombCaught: (eventId?: string) => void;
  /** Explicit `Sentry.captureException`. */
  captureManually: () => void;
}

export function useSentryTest(deps: SentryTestDeps = {}): SentryTestViewModel {
  const {
    captureException = (error: unknown) => Sentry.captureException(error) as string | undefined,
    scheduleUncaught = (throwFn: () => void) => {
      setTimeout(throwFn, 0);
    },
    runtimeInfo = getSentryRuntimeInfo,
    now = () => new Date().toISOString(),
  } = deps;

  const info = useMemo(() => runtimeInfo(), [runtimeInfo]);
  const [status, setStatus] = useState('Ready — pick a test below.');
  const [bombArmed, setBombArmed] = useState(false);

  const runtimeLabel = useMemo(() => {
    const parts = [`env: ${info.environment ?? '(unset)'}`];
    parts.push(`release: ${info.release ?? '(native auto)'}`);
    if (info.dist) parts.push(`dist: ${info.dist}`);
    return parts.join('  ·  ');
  }, [info]);

  const throwUncaught = useCallback(() => {
    setStatus('Threw an UNCAUGHT async error → should reach Sentry via the global handler.');
    // setTimeout guarantees a genuinely uncaught exception that reaches the RN
    // ErrorUtils global handler (and thus Sentry's default integration).
    scheduleUncaught(() => {
      throw new Error(`[Sentry Test] Uncaught async error @ ${now()}`);
    });
  }, [scheduleUncaught, now]);

  const captureManually = useCallback(() => {
    const eventId = captureException(new Error(`[Sentry Test] Manual captureException @ ${now()}`));
    setStatus(`Sentry.captureException → event id: ${eventId || '(none — Sentry inactive)'}`);
  }, [captureException, now]);

  const armBomb = useCallback(() => {
    setStatus('Armed a render error → a child will throw, caught by the scoped ErrorBoundary.');
    setBombArmed(true);
  }, []);

  const resetBomb = useCallback(() => setBombArmed(false), []);

  const onBombCaught = useCallback((eventId?: string) => {
    setStatus(`Render error CAUGHT by the ErrorBoundary → reported to Sentry (event ${eventId}).`);
  }, []);

  return {
    status,
    sentryActive: info.active,
    runtimeLabel,
    bombArmed,
    throwUncaught,
    armBomb,
    resetBomb,
    onBombCaught,
    captureManually,
  };
}
