/**
 * GitHub-offline resilience: fetchWithTimeout + isUpstreamUnreachableError +
 * handleGitHubApiError's network-error branch.
 *
 * Native `fetch` has no default timeout, so a request to an offline GitHub hangs
 * forever, piling up requests until the app appears frozen. These tests lock in:
 *   - fetchWithTimeout aborts past its budget and surfaces a typed FetchTimeoutError,
 *   - isUpstreamUnreachableError recognizes timeout/DNS/connection failures but NOT
 *     HTTP-status errors (401/403),
 *   - handleGitHubApiError maps an unreachable GitHub to a retryable 503 while
 *     still routing real 401s to token-expired (the new branch must not shadow it).
 */
import { describe, it, expect, afterEach } from 'bun:test';

import { handleGitHubApiError } from '../../../src/services/GitHubApiService/utils/GitHubUtils.js';
import {
  fetchWithTimeout,
  FetchTimeoutError,
  isUpstreamUnreachableError,
} from '../../../src/utils/fetchWithTimeout.js';

describe('fetchWithTimeout', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('rejects with FetchTimeoutError when the request exceeds the timeout', async () => {
    // A fetch that only settles when its abort signal fires (mimics a hung socket).
    globalThis.fetch = ((_url: any, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          (e as any).name = 'AbortError';
          reject(e);
        });
      })) as any;

    let err: unknown;
    try {
      await fetchWithTimeout('https://api.github.com/user', {}, 20);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FetchTimeoutError);
  });

  it('passes a successful response straight through', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any;
    const res = await fetchWithTimeout('https://api.github.com/user', {}, 1000);
    expect(res.status).toBe(200);
  });

  it('rethrows a non-timeout error unchanged', async () => {
    const boom = new Error('boom');
    globalThis.fetch = (async () => {
      throw boom;
    }) as any;

    let err: unknown;
    try {
      await fetchWithTimeout('https://x', {}, 1000);
    } catch (e) {
      err = e;
    }
    expect(err).toBe(boom);
  });
});

describe('isUpstreamUnreachableError', () => {
  it('is true for timeout / DNS / connection failures', () => {
    expect(isUpstreamUnreachableError(new FetchTimeoutError('u', 1))).toBe(true);
    expect(isUpstreamUnreachableError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(
      true
    );
    expect(isUpstreamUnreachableError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(
      true
    );
    expect(
      isUpstreamUnreachableError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))
    ).toBe(true);
    expect(
      isUpstreamUnreachableError(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
      )
    ).toBe(true);
    expect(isUpstreamUnreachableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('is false for HTTP-status errors and non-errors', () => {
    expect(
      isUpstreamUnreachableError(
        Object.assign(new Error('Bad credentials'), { status: 401, name: 'HttpError' })
      )
    ).toBe(false);
    expect(isUpstreamUnreachableError(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe(
      false
    );
    expect(isUpstreamUnreachableError(null)).toBe(false);
    expect(isUpstreamUnreachableError('nope')).toBe(false);
  });
});

describe('handleGitHubApiError — GitHub offline', () => {
  const makeRes = () => {
    const r: any = { statusCode: 0, body: null };
    r.status = (n: number) => {
      r.statusCode = n;
      return r;
    };
    r.json = (b: any) => {
      r.body = b;
      return r;
    };
    return r;
  };

  it('maps an unreachable GitHub to a retryable 503', () => {
    const res = makeRes();
    const handled = handleGitHubApiError(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
      {} as any,
      res as any
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('GITHUB_UNAVAILABLE');
    expect(res.body.retryable).toBe(true);
  });

  it('still routes a real 401 to token-expired (network branch does not shadow it)', () => {
    const res = makeRes();
    const handled = handleGitHubApiError(
      Object.assign(new Error('Bad credentials'), { status: 401 }),
      {} as any,
      res as any
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it('returns false for an unrecognized error', () => {
    const res = makeRes();
    const handled = handleGitHubApiError(new Error('weird'), {} as any, res as any);
    expect(handled).toBe(false);
  });
});
