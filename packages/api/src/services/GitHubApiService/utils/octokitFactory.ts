import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';

import type { ThrottlingOptions } from '@octokit/plugin-throttling';

/** plugin-retry has no exported options type; mirror the ones we use. */
interface RetryOptions {
  enabled?: boolean;
  retries?: number;
  retryAfterBaseValue?: number;
  doNotRetry?: number[];
}

export interface CreateUserOctokitOptions {
  /**
   * Called on the first 401 of a request. Should invalidate the token caches
   * and return a freshly-fetched token (or undefined when none is available).
   * If the returned token differs from the one that failed, the request is
   * replayed exactly once with the new authorization header.
   */
  refreshToken?: () => Promise<string | undefined>;
  /** Extra Octokit request options (tests inject a fake fetch here) */
  request?: Record<string, unknown>;
  /** Overrides merged over the default plugin-retry config (tests shrink backoff) */
  retry?: RetryOptions;
  /** Overrides merged over the default plugin-throttling config (tests shrink retry-after) */
  throttle?: Partial<ThrottlingOptions>;
}

let hardenedCache: { base: unknown; hardened: typeof Octokit } | null = null;

/**
 * Octokit hardened with @octokit/plugin-retry + plugin-throttling:
 * transient 5xx errors get a bounded exponential retry, and primary/secondary
 * rate limits (403/429) wait out the server-provided retry-after instead of
 * failing the burst immediately. 401 and 403 are in plugin-retry's doNotRetry
 * list, so the fresh-token 401 hook below stays the only 401 handler.
 *
 * Applied lazily against the CURRENT `Octokit` binding instead of at module
 * top-level: the lifecycle tests hot-swap '@octokit/rest' via mock.module
 * AFTER this module is evaluated, so a top-level `.plugin()` call either
 * crashes module load (the mock class has no `plugin` static) or freezes the
 * real class and bypasses the mock entirely. Test doubles without `.plugin`
 * are returned as-is; the real class is hardened once and memoized.
 */
function getHardenedOctokit(): typeof Octokit {
  if (typeof Octokit.plugin !== 'function') {
    return Octokit;
  }
  if (!hardenedCache || hardenedCache.base !== Octokit) {
    hardenedCache = { base: Octokit, hardened: Octokit.plugin(retry, throttling) };
  }
  return hardenedCache.hardened;
}

/** Same prefix rule as @octokit/auth-token: JWTs get `bearer`, tokens get `token`. */
function authorizationHeader(token: string): string {
  return token.split('.').length === 3 ? `bearer ${token}` : `token ${token}`;
}

/**
 * Shared per-user Octokit factory, used by both GitHubApiService and
 * TokenPermissionHandler so 401 handling is identical everywhere.
 *
 * The token is injected via our own `hook.wrap('request')` instead of the
 * Octokit `auth` option: the built-in token-auth hook overwrites the
 * authorization header with the construction-time token on EVERY request,
 * which would defeat the replay-with-fresh-token below.
 *
 * On a 401: refreshToken() runs once (per request); a different token →
 * one replay with the new header; same/missing token or a second 401 → the
 * original 401 propagates. No loops (`_freshTokenRetried` flag), and the
 * refreshed token is kept for all subsequent requests of this instance.
 */
export function createUserOctokit(token: string, options: CreateUserOctokitOptions = {}): Octokit {
  const HardenedOctokit = getHardenedOctokit();
  const octokit = new HardenedOctokit({
    request: {
      // 30s request timeout so a call never hangs forever when GitHub is
      // offline (canonical config shared by all per-user Octokit instances).
      timeout: 30000,
      ...options.request,
    },
    retry: options.retry,
    throttle: {
      // Retry exactly once per request when GitHub rate-limits us; a second
      // limit on the same request propagates as the usual 403 (which
      // handleGitHubApiError maps to RATE_LIMIT_EXCEEDED for the client).
      // Each sandbox is single-user, so the per-instance queue this creates
      // cannot starve other users.
      onRateLimit: (retryAfter, requestOptions, _octokitInstance, retryCount) => {
        console.warn(
          `[github] primary rate limit hit, retryAfter=${retryAfter}s route=${requestOptions.method} ${requestOptions.url} retryCount=${retryCount}`
        );
        return retryCount < 1;
      },
      onSecondaryRateLimit: (retryAfter, requestOptions, _octokitInstance, retryCount) => {
        console.warn(
          `[github] secondary rate limit hit, retryAfter=${retryAfter}s route=${requestOptions.method} ${requestOptions.url} retryCount=${retryCount}`
        );
        return retryCount < 1;
      },
      ...options.throttle,
    },
  });

  // Test doubles for '@octokit/rest' (hot-swapped via mock.module in the
  // lifecycle suites) usually lack the before-after-hook API. Skip the
  // auth/401 wiring for them — previously these flowed through a bare
  // `new Octokit(...)` untouched, and the real Octokit always has hooks.
  if (typeof octokit.hook?.wrap !== 'function') {
    return octokit;
  }

  let currentToken = token;

  octokit.hook.wrap('request', async (request, requestOptions: any) => {
    requestOptions.headers.authorization = authorizationHeader(currentToken);
    try {
      return await request(requestOptions);
    } catch (error: any) {
      if (error?.status !== 401 || !options.refreshToken || requestOptions._freshTokenRetried) {
        throw error;
      }
      requestOptions._freshTokenRetried = true;

      let newToken: string | undefined;
      try {
        newToken = await options.refreshToken();
      } catch (refreshError) {
        console.warn('[octokitFactory] Token refresh after 401 failed:', refreshError);
        throw error; // propagate the original 401, not the refresh failure
      }

      if (!newToken || newToken === currentToken) {
        throw error;
      }

      currentToken = newToken;
      requestOptions.headers.authorization = authorizationHeader(newToken);
      return request(requestOptions);
    }
  });

  return octokit;
}
