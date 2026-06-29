/**
 * octokitFactory Unit Tests
 *
 * createUserOctokit builds the shared per-user Octokit used by both
 * GitHubApiService and TokenPermissionHandler. On a 401 it invokes the
 * injected refreshToken callback ONCE; if a *different* token comes back the
 * request is replayed once with the new authorization header. Same token or a
 * second 401 → the original 401 propagates (no loops, no credential deletion).
 *
 * The factory is hardened with @octokit/plugin-retry + plugin-throttling:
 * primary/secondary rate limits are retried once after the
 * server-provided retry-after, transient 5xx errors are retried a bounded
 * number of times, and the 401 fresh-token hook composes with both (401/403
 * are in plugin-retry's doNotRetry list).
 *
 * A fake fetch is injected via Octokit's `request: { fetch }` option.
 */

import { describe, it, expect, mock, spyOn } from 'bun:test';

import { createUserOctokit } from '../../../src/services/GitHubApiService/utils/octokitFactory';

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Build a fake fetch that returns the queued responses in order and records
 * every request's authorization header.
 */
function makeFakeFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const fakeFetch = mock(async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const next = responses.shift();
    if (!next) throw new Error('fake fetch: no more queued responses');
    return next;
  });
  return { fakeFetch, requests };
}

describe('createUserOctokit', () => {
  it('sends the initial token on the first request', async () => {
    const { fakeFetch, requests } = makeFakeFetch([jsonResponse(200, { login: 'octocat' })]);

    const octokit = createUserOctokit('gho_initial', {
      request: { fetch: fakeFetch },
    });

    const response = await octokit.request('GET /user');

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('token gho_initial');
  });

  it('on 401: invokes refreshToken, replays once with the NEW token, and succeeds', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const refreshToken = mock(async () => 'gho_fresh');

    const octokit = createUserOctokit('gho_stale', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    const response = await octokit.request('GET /user');

    expect(response.status).toBe(200);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBe('token gho_stale');
    expect(requests[1].authorization).toBe('token gho_fresh');
  });

  it('on 401: when refreshToken returns the SAME token, does not replay and the 401 propagates', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
    ]);
    const refreshToken = mock(async () => 'gho_same');

    const octokit = createUserOctokit('gho_same', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 401 });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('on 401: when refreshToken returns undefined, does not replay and the 401 propagates', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
    ]);
    const refreshToken = mock(async () => undefined);

    const octokit = createUserOctokit('gho_stale', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 401 });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it('on a second 401 after the replay: propagates without looping (refreshToken called once)', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
      jsonResponse(401, { message: 'Bad credentials' }),
    ]);
    const refreshToken = mock(async () => 'gho_fresh');

    const octokit = createUserOctokit('gho_stale', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 401 });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  });

  it('without a refreshToken callback: a 401 propagates immediately (single request)', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
    ]);

    const octokit = createUserOctokit('gho_stale', {
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 401 });
    expect(requests).toHaveLength(1);
  });

  it('if refreshToken itself throws, the original 401 propagates (no unhandled rejection)', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
    ]);
    const refreshToken = mock(async () => {
      throw new Error('gateway unreachable');
    });

    const octokit = createUserOctokit('gho_stale', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 401 });
    expect(requests).toHaveLength(1);
  });

  it('non-401 errors are untouched by the retry hook', async () => {
    const { fakeFetch, requests } = makeFakeFetch([jsonResponse(404, { message: 'Not Found' })]);
    const refreshToken = mock(async () => 'gho_fresh');

    const octokit = createUserOctokit('gho_token', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await expect(octokit.request('GET /repos/a/b')).rejects.toMatchObject({ status: 404 });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('after a successful refresh, subsequent requests keep using the new token', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
      jsonResponse(200, { login: 'octocat' }),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const refreshToken = mock(async () => 'gho_fresh');

    const octokit = createUserOctokit('gho_stale', {
      refreshToken,
      request: { fetch: fakeFetch },
    });

    await octokit.request('GET /user');
    await octokit.request('GET /user');

    expect(requests).toHaveLength(3);
    expect(requests[2].authorization).toBe('token gho_fresh');
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('createUserOctokit — rate-limit hardening', () => {
  /**
   * Scale both plugins' second→ms conversion down to 1ms so the
   * server-provided retry-after / backoff waits don't slow the test file.
   */
  const FAST_PLUGINS = {
    retry: { retryAfterBaseValue: 1 },
    throttle: { retryAfterBaseValue: 1 },
  };

  function secondaryRateLimitResponse(): Response {
    return new Response(
      JSON.stringify({
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      }),
      {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' },
      }
    );
  }

  function primaryRateLimitResponse(): Response {
    return new Response(JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }), {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
      },
    });
  }

  it('on a secondary rate limit (403 + retry-after): retries once after the server-provided delay and succeeds', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      secondaryRateLimitResponse(),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const octokit = createUserOctokit('gho_token', {
        request: { fetch: fakeFetch },
        ...FAST_PLUGINS,
      });

      const response = await octokit.request('GET /user');

      expect(response.status).toBe(200);
      expect(requests).toHaveLength(2);
      // The retried request keeps the auth header set by the factory hook
      expect(requests[1].authorization).toBe('token gho_token');
      const logLines = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(logLines.some((line) => line.includes('[github] secondary rate limit hit'))).toBe(
        true
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('on a second secondary rate limit after the retry: gives up (retry-once policy) and the 403 propagates', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      secondaryRateLimitResponse(),
      secondaryRateLimitResponse(),
    ]);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const octokit = createUserOctokit('gho_token', {
        request: { fetch: fakeFetch },
        ...FAST_PLUGINS,
      });

      await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 403 });
      expect(requests).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('on a primary rate limit (403 + x-ratelimit-remaining: 0): retries once after the reset and succeeds', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      primaryRateLimitResponse(),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const octokit = createUserOctokit('gho_token', {
        request: { fetch: fakeFetch },
        ...FAST_PLUGINS,
      });

      const response = await octokit.request('GET /user');

      expect(response.status).toBe(200);
      expect(requests).toHaveLength(2);
      const logLines = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(logLines.some((line) => line.includes('[github] primary rate limit hit'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('on persistent 500s: retries a bounded number of times (plugin-retry default), then the error propagates', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(500, { message: 'Server Error' }),
      jsonResponse(500, { message: 'Server Error' }),
      jsonResponse(500, { message: 'Server Error' }),
      jsonResponse(500, { message: 'Server Error' }),
    ]);

    const octokit = createUserOctokit('gho_token', {
      request: { fetch: fakeFetch },
      ...FAST_PLUGINS,
    });

    await expect(octokit.request('GET /user')).rejects.toMatchObject({ status: 500 });
    // 1 original attempt + plugin-retry's default 3 retries — bounded, no loop
    expect(requests).toHaveLength(4);
  });

  it('a transient 500 is retried and succeeds without involving refreshToken', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(500, { message: 'Server Error' }),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const refreshToken = mock(async () => 'gho_fresh');

    const octokit = createUserOctokit('gho_token', {
      refreshToken,
      request: { fetch: fakeFetch },
      ...FAST_PLUGINS,
    });

    const response = await octokit.request('GET /user');

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('401 fresh-token hook composes with the plugins: 401 → refresh → replay hits a secondary limit → throttle retry → 200', async () => {
    const { fakeFetch, requests } = makeFakeFetch([
      jsonResponse(401, { message: 'Bad credentials' }),
      secondaryRateLimitResponse(),
      jsonResponse(200, { login: 'octocat' }),
    ]);
    const refreshToken = mock(async () => 'gho_fresh');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const octokit = createUserOctokit('gho_stale', {
        refreshToken,
        request: { fetch: fakeFetch },
        ...FAST_PLUGINS,
      });

      const response = await octokit.request('GET /user');

      expect(response.status).toBe(200);
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(3);
      expect(requests[0].authorization).toBe('token gho_stale');
      expect(requests[1].authorization).toBe('token gho_fresh');
      expect(requests[2].authorization).toBe('token gho_fresh');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
