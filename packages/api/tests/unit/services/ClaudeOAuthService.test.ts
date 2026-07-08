/**
 * ClaudeOAuthService unit tests (portable.dev#18 — login-from-phone).
 *
 * Boundary mocked: the token endpoint via an injected fetchImpl (the preload's
 * global fetch mock blocks external calls anyway) + an injected now() clock.
 * Storage is a REAL LocalSecretStore in a temp DATA_DIR through a real
 * LocalAiCredentialsService — persistence/mirroring assertions are end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import {
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_TOKEN_URL,
  ClaudeOAuthError,
  ClaudeOAuthService,
  LOGIN_ATTEMPT_TTL_MS,
  REFRESH_BUFFER_MS,
} from '../../../src/services/ClaudeOAuthService';
import { LocalAiCredentialsService } from '../../../src/services/LocalAiCredentialsService';

let tmpDir: string;
let credentials: LocalAiCredentialsService;
let clock: { now: number };

/** A recording fake for the token endpoint. */
function makeFetch(
  respond: (url: string, init?: RequestInit) => { status: number; body: unknown } = () => ({
    status: 200,
    body: tokenResponse(),
  })
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const { status, body } = respond(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    token_type: 'Bearer',
    access_token: 'sk-ant-oat01-fresh-access',
    expires_in: 28800,
    refresh_token: 'sk-ant-ort01-refresh',
    scope: 'user:inference user:profile',
    account: { uuid: 'acc-1', email_address: 'user@example.com' },
    ...overrides,
  };
}

function makeService(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return new ClaudeOAuthService(credentials, { fetchImpl, now: () => clock.now });
}

/** Extract the state param from a startLogin authorize URL. */
function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

const ENV_KEYS = ['ANTHROPIC_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-claude-oauth-test-'));
  credentials = new LocalAiCredentialsService(new LocalSecretStore({ dataDir: tmpDir }));
  clock = { now: 1_700_000_000_000 };
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startLogin', () => {
  it('builds a PKCE authorize URL with every required param', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    const { authorizeUrl } = service.startLogin();
    const url = new URL(authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_OAUTH_AUTHORIZE_URL);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toContain('user:inference');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('state')?.length).toBeGreaterThan(20);
  });

  it('a new start supersedes the previous pending attempt', async () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    const first = service.startLogin();
    service.startLogin();

    // Completing with the FIRST attempt's state must now mismatch.
    await expect(service.completeLogin(`some-code#${stateOf(first.authorizeUrl)}`)).rejects.toThrow(
      ClaudeOAuthError
    );
  });
});

describe('completeLogin', () => {
  it('exchanges CODE#STATE (form-encoded) and persists the full record', async () => {
    const { calls, fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    const { authorizeUrl } = service.startLogin();
    const result = await service.completeLogin(`the-auth-code#${stateOf(authorizeUrl)}`);

    expect(result.email).toBe('user@example.com');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(CLAUDE_OAUTH_TOKEN_URL);
    expect(calls[0].init?.method).toBe('POST');
    const contentType = new Headers(calls[0].init?.headers).get('Content-Type');
    expect(contentType).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-auth-code');
    expect(body.get('redirect_uri')).toBe(CLAUDE_OAUTH_REDIRECT_URI);
    expect(body.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
    expect(body.get('state')).toBe(stateOf(authorizeUrl));
    expect(body.get('code_verifier')?.length).toBeGreaterThan(20);

    const record = credentials.getOAuthRecord();
    expect(record?.accessToken).toBe('sk-ant-oat01-fresh-access');
    expect(record?.refreshToken).toBe('sk-ant-ort01-refresh');
    expect(record?.expiresAt).toBe(clock.now + 28800 * 1000);
    expect(record?.email).toBe('user@example.com');
    // Mirror for the launcher's discovery.
    expect(credentials.getClaudeOAuthToken()).toBe('sk-ant-oat01-fresh-access');
  });

  it('accepts a bare code with no #STATE suffix', async () => {
    const { calls, fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    service.startLogin();
    await service.completeLogin('  bare-code  ');

    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('code')).toBe('bare-code');
  });

  it('rejects a pasted state that does not match the pending attempt', async () => {
    const { calls, fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    service.startLogin();
    await expect(service.completeLogin('code#wrong-state')).rejects.toMatchObject({
      code: 'state_mismatch',
    });
    expect(calls.length).toBe(0);
    expect(credentials.getOAuthRecord()).toBeNull();
  });

  it('rejects when no login was started', async () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    await expect(service.completeLogin('code')).rejects.toMatchObject({
      code: 'no_pending_login',
    });
  });

  it('rejects when the pending attempt has expired', async () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    service.startLogin();
    clock.now += LOGIN_ATTEMPT_TTL_MS + 1;
    await expect(service.completeLogin('code')).rejects.toMatchObject({
      code: 'no_pending_login',
    });
  });

  it('rejects an empty code', async () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    service.startLogin();
    await expect(service.completeLogin('   ')).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('surfaces a failed exchange without persisting anything', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const service = makeService(fetchImpl);

    const { authorizeUrl } = service.startLogin();
    await expect(service.completeLogin(`bad-code#${stateOf(authorizeUrl)}`)).rejects.toMatchObject({
      code: 'exchange_failed',
    });
    expect(credentials.getOAuthRecord()).toBeNull();
  });
});

describe('refreshIfNeeded', () => {
  const seedRecord = (expiresInMs: number) => {
    credentials.setOAuthRecord({
      accessToken: 'sk-ant-oat01-old',
      refreshToken: 'sk-ant-ort01-refresh',
      expiresAt: clock.now + expiresInMs,
      obtainedAt: new Date(clock.now).toISOString(),
    });
  };

  it('does nothing while the token is comfortably fresh', async () => {
    const { calls, fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    seedRecord(REFRESH_BUFFER_MS * 3);

    await service.refreshIfNeeded();
    expect(calls.length).toBe(0);
    expect(credentials.getOAuthRecord()?.accessToken).toBe('sk-ant-oat01-old');
  });

  it('refreshes (refresh_token grant) inside the expiry buffer and persists the new record', async () => {
    const { calls, fetchImpl } = makeFetch(() => ({
      status: 200,
      body: tokenResponse({ access_token: 'sk-ant-oat01-renewed' }),
    }));
    const service = makeService(fetchImpl);
    seedRecord(REFRESH_BUFFER_MS - 1);

    await service.refreshIfNeeded();

    expect(calls.length).toBe(1);
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('sk-ant-ort01-refresh');
    expect(body.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);

    const record = credentials.getOAuthRecord();
    expect(record?.accessToken).toBe('sk-ant-oat01-renewed');
    expect(record?.expiresAt).toBe(clock.now + 28800 * 1000);
    expect(credentials.getClaudeOAuthToken()).toBe('sk-ant-oat01-renewed');
  });

  it('keeps the previous refresh token when the response omits one', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 200,
      body: tokenResponse({ refresh_token: undefined }),
    }));
    const service = makeService(fetchImpl);
    seedRecord(0);

    await service.refreshIfNeeded();
    expect(credentials.getOAuthRecord()?.refreshToken).toBe('sk-ant-ort01-refresh');
  });

  it('keeps the old record and does NOT throw when the refresh fails', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const service = makeService(fetchImpl);
    seedRecord(0);

    await service.refreshIfNeeded(); // must not throw
    expect(credentials.getOAuthRecord()?.accessToken).toBe('sk-ant-oat01-old');
  });

  it('does nothing without a refresh token or without an expiry', async () => {
    const { calls, fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    credentials.setOAuthRecord({
      accessToken: 'sk-ant-oat01-long-lived',
      obtainedAt: new Date(clock.now).toISOString(),
    });
    await service.refreshIfNeeded();
    expect(calls.length).toBe(0);
  });

  it('single-flights concurrent refreshes', async () => {
    let resolveResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      await gate;
      return new Response(JSON.stringify(tokenResponse()), { status: 200 });
    };
    const service = makeService(fetchImpl);
    seedRecord(0);

    const [a, b] = [service.refreshIfNeeded(), service.refreshIfNeeded()];
    resolveResponse!();
    await Promise.all([a, b]);
    expect(calls.length).toBe(1);
  });
});

describe('status', () => {
  it('reports none when nothing is configured', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    expect(service.status()).toEqual({
      mode: 'none',
      source: 'none',
      hasRefreshToken: false,
    });
  });

  it('reports the oauth record metadata without ever exposing token values', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    credentials.setOAuthRecord({
      accessToken: 'sk-ant-oat01-secret',
      refreshToken: 'sk-ant-ort01-secret',
      expiresAt: clock.now + 1000,
      email: 'user@example.com',
      obtainedAt: new Date(clock.now).toISOString(),
    });

    const status = service.status();
    expect(status).toEqual({
      mode: 'claude-oauth',
      source: 'oauth-record',
      hasRefreshToken: true,
      email: 'user@example.com',
      expiresAt: clock.now + 1000,
    });
    expect(JSON.stringify(status)).not.toContain('secret');
  });
});

describe('pasteToken + signOut', () => {
  it('classifies an sk-ant-oat01 token as a claude-oauth record (no refresh token)', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    const result = service.pasteToken('  sk-ant-oat01-pasted  ');
    expect(result.mode).toBe('claude-oauth');
    expect(credentials.getOAuthRecord()?.accessToken).toBe('sk-ant-oat01-pasted');
    expect(credentials.getOAuthRecord()?.refreshToken).toBeUndefined();
    expect(credentials.getClaudeOAuthToken()).toBe('sk-ant-oat01-pasted');
  });

  it('classifies an sk-ant-api… key as a stored API key', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);

    const result = service.pasteToken('sk-ant-api03-pasted');
    expect(result.mode).toBe('api-key');
    expect(credentials.getStoredApiKey()).toBe('sk-ant-api03-pasted');
  });

  it('rejects a token that is not an sk-ant-… credential', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    expect(() => service.pasteToken('ghp_not_anthropic')).toThrow(ClaudeOAuthError);
    expect(() => service.pasteToken('   ')).toThrow(ClaudeOAuthError);
  });

  it('signOut clears the record, the legacy mirror, and the stored API key', () => {
    const { fetchImpl } = makeFetch();
    const service = makeService(fetchImpl);
    service.pasteToken('sk-ant-oat01-pasted');
    credentials.setStoredApiKey('sk-ant-api03-x');

    expect(service.signOut()).toBe(true);
    expect(credentials.getOAuthRecord()).toBeNull();
    expect(credentials.getClaudeOAuthToken()).toBeNull();
    expect(credentials.getStoredApiKey()).toBeNull();
    expect(service.signOut()).toBe(false);
  });
});
