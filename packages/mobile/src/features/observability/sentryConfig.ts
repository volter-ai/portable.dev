/**
 * Sentry runtime configuration resolution for the native RN app.
 *
 * Framework-free (NO `@sentry/*` import) so it stays unit-testable and out of the
 * native-module graph. Uses this package's `EXPO_PUBLIC_*` env convention (the
 * `gatewayConfig` pattern: a pure resolver + an env reader, never mutate
 * `process.env` in tests — babel-preset-expo inlines `EXPO_PUBLIC_*`).
 */

/**
 * Sentry DSN — a PUBLIC client identifier (safe to bundle; it only authorizes
 * SENDING events to this project, never reading them). Sentry org
 * `oliver-volter-maybe`, project `4511016585199616`, so RN
 * events land bucketed by the `service: 'mobile'` tag and the
 * `ios`/`android` environment. CI may override it with `EXPO_PUBLIC_SENTRY_DSN`;
 * otherwise this bundled value is used so a release build reports with zero env
 * setup.
 */
export const MOBILE_SENTRY_DSN =
  'https://3698ef423005e5ccbcdda38f9d30795f@o4507742853070848.ingest.us.sentry.io/4511016585199616';

/** Env snapshot consumed by the pure resolvers (injectable for tests). */
export interface SentryEnv {
  /** `EXPO_PUBLIC_SENTRY_DSN` — CI override; always wins when set. */
  dsn?: string;
  /** `EXPO_PUBLIC_ENABLE_SENTRY_TEST === 'true'` — turn Sentry on in a dev build. */
  enableTest: boolean;
  /** `EXPO_PUBLIC_SENTRY_ENVIRONMENT` — explicit environment override (else `Platform.OS`). */
  environment?: string;
}

/**
 * Read the specific `EXPO_PUBLIC_*` keys DIRECTLY so babel-preset-expo can inline
 * them at build time. The pure resolvers below accept an injected `SentryEnv` so
 * tests never touch `process.env`.
 */
export function readSentryEnv(): SentryEnv {
  return {
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    enableTest: process.env.EXPO_PUBLIC_ENABLE_SENTRY_TEST === 'true',
    environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
  };
}

/** Whether this build opted into Sentry-test mode. */
export function isSentryTestEnabled(env: SentryEnv = readSentryEnv()): boolean {
  return env.enableTest;
}

/**
 * Resolve which DSN (if any) the runtime SDK initializes with — the pure core.
 *
 *   1. `EXPO_PUBLIC_SENTRY_DSN` (CI override) always wins.
 *   2. Else, in a RELEASE build (`dev === false`) OR a dedicated Sentry-test build
 *      (`EXPO_PUBLIC_ENABLE_SENTRY_TEST=true`), fall back to the bundled DSN — so
 *      TestFlight/Play builds report automatically AND a local test build can opt in.
 *   3. Else (plain `expo start` dev) → `undefined` → `Sentry.init` is SKIPPED, so
 *      everyday Metro dev never floods Sentry (`buildSentryConfig` returns null).
 */
export function resolveSentryDsn(
  dev: boolean,
  env: SentryEnv = readSentryEnv()
): string | undefined {
  if (env.dsn && env.dsn.trim() !== '') return env.dsn;
  if (!dev || env.enableTest) return MOBILE_SENTRY_DSN;
  return undefined;
}

/** DSN for the current build (consults the live `__DEV__` + env). */
export function getSentryDsn(): string | undefined {
  return resolveSentryDsn(__DEV__);
}

/** Explicit Sentry environment override, if the build set one. */
export function getSentryEnvironment(env: SentryEnv = readSentryEnv()): string | undefined {
  return env.environment;
}
