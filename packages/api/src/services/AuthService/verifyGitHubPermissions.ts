import type { GitHubPermissionStatus } from './types.js';

/**
 * Post-connect "refresh" verification for GET /auth/check-github-permissions.
 *
 * A user who just completed GitHub OAuth / App-install expects the permission
 * gate to drop on the FIRST tap. But the connection is created by the GATEWAY
 * (stored in Clerk), and two things make a single fresh read miss it — so the
 * gate only dropped on the SECOND tap:
 *   1. a NEGATIVE cache re-population: even though /auth/github flushes the
 *      sandbox cache at OAuth initiation, a check that runs during the OAuth
 *      window (e.g. a repos query refetching on app-foreground) can re-cache
 *      "no connection" (45s) before the post-connect check runs; and
 *   2. Clerk read-after-write lag right after the store.
 *
 * This helper INVALIDATES the user's ActiveGitHubConnectionCache entry before
 * EACH read (so a re-cached negative can't stick) and briefly RETRIES until the
 * connection appears or the budget is spent — turning "works on the 2nd tap"
 * into "works on the 1st". It only runs for the explicit `?refresh=1` request
 * the client sends right after a connect flow settles, NOT the periodic checks,
 * so the anti-flood cache is untouched on hot paths.
 */
export const REFRESH_VERIFY_ATTEMPTS = 4;
export const REFRESH_VERIFY_DELAY_MS = 800;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface VerifyRefreshOptions {
  /** Max read attempts (default 4 → up to ~2.4s with the default delay). */
  attempts?: number;
  /** Delay between attempts in ms (default 800). */
  delayMs?: number;
  /** Sleep seam (default real setTimeout) — injected as a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Invalidate-then-check, retrying until `hasPermissions` (or the budget is
 * spent). `invalidate` drops the user's cache entry so each attempt refetches
 * fresh from Clerk; `check` runs the (now cache-flushed) permission lookup.
 * Returns the status as soon as the connection appears, else the final result.
 */
export async function verifyGitHubPermissionsWithRefresh(
  check: () => Promise<GitHubPermissionStatus>,
  invalidate: () => void,
  options: VerifyRefreshOptions = {}
): Promise<GitHubPermissionStatus> {
  const attempts = Math.max(1, options.attempts ?? REFRESH_VERIFY_ATTEMPTS);
  const delayMs = options.delayMs ?? REFRESH_VERIFY_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

  let status: GitHubPermissionStatus | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    invalidate();
    status = await check();
    if (status.hasPermissions) break;
  }
  return status as GitHubPermissionStatus;
}
