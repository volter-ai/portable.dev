/**
 * Observability feature barrel — Sentry error monitoring.
 *
 * NOTE on import hygiene: `app/_layout.tsx` imports `initSentry` + `AppErrorBoundary`
 * from their FILES (not this barrel) so the root layout's graph doesn't pull in
 * `SentryTestScreen` → settings chrome → `useAppTheme`/MMKV. The barrel is for the
 * route shell + tests.
 */

export { initSentry, getSentryRuntimeInfo } from './initSentry';
export { AppErrorBoundary, ErrorFallback } from './AppErrorBoundary';
export { SentryTestScreen } from './SentryTestScreen';
export { useSentryTest } from './useSentryTest';
export type { SentryTestDeps, SentryTestViewModel } from './useSentryTest';
export {
  MOBILE_SENTRY_DSN,
  resolveSentryDsn,
  getSentryDsn,
  isSentryTestEnabled,
  getSentryEnvironment,
  readSentryEnv,
} from './sentryConfig';
export type { SentryEnv } from './sentryConfig';
