/**
 * Initialize `@sentry/react-native` for the native app.
 *
 * Captures BOTH native iOS/Android crashes (sentry-cocoa / sentry-android, linked
 * by `expo prebuild` via the `@sentry/react-native/expo` config plugin) AND
 * uncaught/handled JS errors through ONE client.
 *
 * No-op when no DSN resolves (plain `expo start` dev), via the shared
 * `buildSentryConfig` → null gate, so everyday Metro dev never floods Sentry. The
 * shared builder is reused so every client shares one `beforeSend` contract
 * (error/fatal only) + the `service` tag.
 *
 * ⚠️ RELEASE & DIST are deliberately LEFT UNSET. `@sentry/react-native`
 * auto-detects them from the native build (`bundleId@version+build`, `dist=build`),
 * and the config-plugin source-map upload tags the maps with those SAME values, so
 * runtime events and uploaded maps match with zero coordination AND they track the
 * CI-injected build number (`release-mobile.yml`). Passing a CUSTOM release
 * would BREAK the automatic source-map upload (it only detects auto values).
 */

import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';

import { buildSentryConfig } from '@vgit2/shared/sentry';

import { getSentryDsn, getSentryEnvironment } from './sentryConfig';

let initialized = false;

/**
 * Initialize Sentry once. Safe to call repeatedly (guarded). Returns whether a
 * client was actually started (a DSN resolved).
 */
export function initSentry(service = 'mobile'): boolean {
  if (initialized) return Boolean(Sentry.getClient());

  // Bucket events by platform (ios|android) when no explicit environment is set
  // (the CI pipeline sets `VITE_SENTRY_ENVIRONMENT=android`).
  const environment = getSentryEnvironment() ?? Platform.OS;

  const config = buildSentryConfig({ service, dsn: getSentryDsn(), environment });
  if (!config) return false; // No DSN → skip (plain dev).

  initialized = true;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    initialScope: config.initialScope,
    sendDefaultPii: false,
    // Crash/error reporting only — no tracing, no Session Replay, no navigation
    // instrumentation (omit `tracesSampleRate`, `release`, `dist`).
    beforeSend(event) {
      // Only forward error/fatal; drop `extra` but KEEP breadcrumbs for debugging
      // context.
      if (event.level !== 'error' && event.level !== 'fatal') return null;
      delete event.extra;
      return event;
    },
  });
  return true;
}

/**
 * The release/dist/environment the active client resolved (release/dist are
 * auto-detected from the native build, so they may be undefined in the JS options
 * — surfaced for the dev-mode test page).
 */
export function getSentryRuntimeInfo(): {
  active: boolean;
  environment?: string;
  release?: string;
  dist?: string;
} {
  const options = Sentry.getClient()?.getOptions();
  return {
    active: Boolean(options),
    environment: options?.environment,
    release: options?.release,
    dist: options?.dist,
  };
}
