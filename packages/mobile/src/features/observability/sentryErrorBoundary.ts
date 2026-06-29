/**
 * React-19-typed alias of `@sentry/react-native`'s `ErrorBoundary`.
 *
 * `@sentry/react-native` (via its bundled `@sentry/react`) types `ErrorBoundary`'s
 * `children`/`fallback` against React 18's `ReactNode`, but this package is React 19
 * (whose `ReactNode` adds `bigint`), so a direct pass-through fails `tsc` with
 * TS2322 ("Type 'bigint' is not assignable…"). Re-type it to a React-19 component —
 * the SAME fix `ClerkAuthProvider` applies to `ClerkProvider`. Runtime behavior is
 * identical (this is a pure type cast). Both `AppErrorBoundary` and the dev-mode
 * `SentryTestScreen` consume this so the cast lives in ONE place.
 */

import * as Sentry from '@sentry/react-native';
import type { ComponentType, ReactNode } from 'react';

/** The subset of `@sentry/react-native` ErrorBoundary props this app uses. */
export interface SentryErrorBoundaryProps {
  children?: ReactNode;
  fallback?: (errorData: {
    error: unknown;
    componentStack: string | undefined;
    eventId: string;
    resetError: () => void;
  }) => ReactNode;
  onError?: (error: unknown, componentStack: string | undefined, eventId: string) => void;
}

export const SentryErrorBoundary =
  Sentry.ErrorBoundary as unknown as ComponentType<SentryErrorBoundaryProps>;
