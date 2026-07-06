/**
 * socketLog — lightweight observability for the Socket.IO lifecycle.
 *
 * Funnels every step (build → E2E handshake → connect / disconnect / connect_error)
 * to (1) the JS console — visible in Metro / Xcode / logcat on a dev build — and
 * (2) a Sentry breadcrumb, so a release/TestFlight report carries the same trail.
 * Grep the device log for `[socket]` to follow a single connection attempt. Never
 * throws (Sentry may be uninitialized in a plain `expo start` with no DSN).
 */
import * as Sentry from '@sentry/react-native';

export type SocketLogLevel = 'info' | 'warning' | 'error';

/** Suppress the console channel under Jest only — keep it in dev + release builds. */
const IS_TEST = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';

export function socketLog(
  event: string,
  data?: Record<string, unknown>,
  level: SocketLogLevel = 'info'
): void {
  const tag = `[socket] ${event}`;
  // Console — the primary channel while debugging a dev build (Metro / Xcode /
  // logcat). Silenced only under Jest so the test suite stays clean.
  if (!IS_TEST) {
    if (level === 'error') console.error(tag, data ?? '');
    else if (level === 'warning') console.warn(tag, data ?? '');
    else console.log(tag, data ?? '');
  }
  // Sentry breadcrumb — so the trail survives into a release build's reports.
  try {
    Sentry.addBreadcrumb({ category: 'socket', message: event, level, data });
  } catch {
    // Sentry not initialized (plain `expo start` with no DSN) — the console suffices.
  }
}

/** Redact an id/token to a short, non-sensitive prefix for logs (never log the whole thing). */
export function shortId(id: string | null | undefined): string {
  if (!id) return 'none';
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
