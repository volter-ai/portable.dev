/**
 * LocalGitHubAuthService unit tests.
 *
 * Boundary mocked: a REAL LocalSecretStore backed by a temp DATA_DIR (encrypted
 * on disk) + an injected fetch/sleep seam. No real GitHub network.
 *
 * Covers the acceptance criteria:
 *  - OAuth App (device-flow) client id from local config/env
 *  - the PC runs the device flow and stores the token (repo, read:org) in the
 *    local encrypted store
 *  - missing token -> clear "connect GitHub" state
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import {
  GITHUB_DEFAULT_SCOPES,
  GITHUB_DEVICE_TOKEN_KEY,
  LocalGitHubAuthService,
} from '../../../src/services/LocalGitHubAuthService';

let tmpDir: string;
let store: LocalSecretStore;

const noSleep = async () => {};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-gh-auth-test-'));
  store = new LocalSecretStore({ dataDir: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('connection status (missing token)', () => {
  it('reports disconnected with no token stored', () => {
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid' });
    expect(svc.isConnected()).toBe(false);
    expect(svc.getToken()).toBeUndefined();
    expect(svc.getConnectionStatus()).toEqual({ connected: false });
  });
});

describe('token persistence', () => {
  it('stores a token (encrypted at rest) and reports connected status', () => {
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid' });
    svc.setToken('gho_abc', ['repo', 'read:org'], 'octocat');

    expect(svc.isConnected()).toBe(true);
    expect(svc.getToken()).toBe('gho_abc');
    expect(svc.getConnectionStatus()).toEqual({
      connected: true,
      login: 'octocat',
      scopes: ['repo', 'read:org'],
    });

    // Encrypted at rest: the raw secrets file must not contain the plaintext token.
    const raw = fs.readFileSync(path.join(tmpDir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('gho_abc');
  });

  it('refuses to store an empty token', () => {
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid' });
    expect(() => svc.setToken('   ')).toThrow(/empty GitHub token/);
  });

  it('clear() removes the stored token', () => {
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid' });
    svc.setToken('gho_abc');
    expect(svc.clear()).toBe(true);
    expect(svc.isConnected()).toBe(false);
  });

  it('defaults scopes to repo + read:org', () => {
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid' });
    const record = svc.setToken('gho_abc');
    expect(record.scopes).toEqual(GITHUB_DEFAULT_SCOPES);
  });
});

describe('requestDeviceCode', () => {
  it('requires a client id (env or option)', async () => {
    const prev = process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const svc = new LocalGitHubAuthService(store);
    await expect(svc.requestDeviceCode()).rejects.toThrow(/client id/i);
    if (prev !== undefined) process.env.GITHUB_OAUTH_CLIENT_ID = prev;
  });

  it('parses the device-code grant', async () => {
    let sentBody: any;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(init!.body as string);
      return jsonResponse({
        device_code: 'dc-1',
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    };
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });
    const device = await svc.requestDeviceCode();

    expect(sentBody.client_id).toBe('cid');
    expect(sentBody.scope).toBe('repo read:org');
    expect(device).toEqual({
      deviceCode: 'dc-1',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
  });

  it('throws on a malformed device-code response', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'unauthorized_client' });
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });
    await expect(svc.requestDeviceCode()).rejects.toThrow(/unauthorized_client/);
  });
});

describe('pollForAccessToken', () => {
  it('keeps polling through authorization_pending then returns the token', async () => {
    const responses = [
      jsonResponse({ error: 'authorization_pending' }),
      jsonResponse({ access_token: 'gho_xyz', scope: 'repo,read:org' }),
    ];
    let calls = 0;
    const fetchImpl = async () => responses[calls++];
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });

    const result = await svc.pollForAccessToken({
      deviceCode: 'dc-1',
      interval: 5,
      expiresIn: 900,
    });
    expect(calls).toBe(2);
    expect(result.token).toBe('gho_xyz');
    expect(result.scopes).toEqual(['repo', 'read:org']);
  });

  it('rejects when the user denies access', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'access_denied' });
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });
    await expect(
      svc.pollForAccessToken({ deviceCode: 'dc-1', interval: 5, expiresIn: 900 })
    ).rejects.toThrow(/denied/);
  });

  it('rejects when the device code expires', async () => {
    const fetchImpl = async () => jsonResponse({ error: 'expired_token' });
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });
    await expect(
      svc.pollForAccessToken({ deviceCode: 'dc-1', interval: 5, expiresIn: 900 })
    ).rejects.toThrow(/expired/);
  });
});

describe('runDeviceFlow', () => {
  it('runs the full flow and persists the token (repo, read:org)', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('device/code')) {
        return jsonResponse({
          device_code: 'dc-1',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.includes('oauth/access_token')) {
        return jsonResponse({ access_token: 'gho_final', scope: 'repo,read:org' });
      }
      // /user lookup
      return jsonResponse({ login: 'octocat' });
    };
    const svc = new LocalGitHubAuthService(store, { clientId: 'cid', fetchImpl, sleep: noSleep });

    let prompted: any;
    const record = await svc.runDeviceFlow((d) => {
      prompted = d;
    });

    expect(prompted.userCode).toBe('WDJB-MJHT');
    expect(record.token).toBe('gho_final');
    expect(record.scopes).toEqual(['repo', 'read:org']);
    expect(record.login).toBe('octocat');

    // Persisted: a fresh service reading the same store sees the token.
    const fresh = new LocalGitHubAuthService(store, { clientId: 'cid' });
    expect(fresh.getToken()).toBe('gho_final');
    expect(store.getJSON(GITHUB_DEVICE_TOKEN_KEY)).toBeDefined();
  });
});
