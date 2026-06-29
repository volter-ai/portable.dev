/**
 * GitHubUtils 401 handler tests
 *
 * A GitHub 401 must NEVER destroy the express session nor delete the user's
 * stored credentials. Before the fix, ANY 401 (including one caused by a stale
 * cached GitHub App token) fire-and-forgot a credential delete, permanently
 * dropping the unrelated OAuth credential and forcing a pointless reconnect.
 *
 * The JSON response shape (GITHUB_TOKEN_EXPIRED + requiresReconnect) is a
 * client contract and must be preserved.
 *
 * Local-first note: credentials now live in the local encrypted store
 * (LocalGitHubAuthService / LocalSecretsAdapter); the remote ClerkSecretsClient
 * delete path that this test originally guarded against no longer exists, so the
 * "never deletes credentials" guarantee is now structural. The remaining
 * assertions still pin the response contract + the no-session-destroy rule.
 */

import { describe, it, expect, mock } from 'bun:test';

import { handleGitHubApiError } from '../../../src/services/GitHubApiService/utils/GitHubUtils';

function makeReqRes() {
  const destroy = mock((cb?: (err?: Error) => void) => cb?.());
  const req: any = { session: { destroy, authToken: 'jwt-token', userEmail: 'user@test.com' } };

  const json = mock((_body: any) => res);
  const status = mock((_code: number) => res);
  const res: any = { status, json };
  res.status = status;
  res.json = json;
  return { req, res, destroy, status, json };
}

describe('handleGitHubApiError — 401 branch', () => {
  it('responds 401 with GITHUB_TOKEN_EXPIRED + requiresReconnect (client contract)', () => {
    const { req, res, status, json } = makeReqRes();

    const handled = handleGitHubApiError({ status: 401 }, req, res, 'jwt-token');

    expect(handled).toBe(true);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body.error).toBe('GITHUB_TOKEN_EXPIRED');
    expect(body.requiresReconnect).toBe(true);
  });

  it('never destroys the express session', () => {
    const { req, res, destroy } = makeReqRes();

    handleGitHubApiError({ status: 401 }, req, res, 'jwt-token');

    expect(destroy).not.toHaveBeenCalled();
  });

  it('does not handle non-401 errors via the 401 branch (sanity: 500 falls through)', () => {
    const { req, res, status, json } = makeReqRes();

    const handled = handleGitHubApiError({ status: 500, message: 'boom' }, req, res, 'jwt-token');

    expect(handled).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
