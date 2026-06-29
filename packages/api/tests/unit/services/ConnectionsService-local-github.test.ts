/**
 * ConnectionsService local-first GitHub resolution.
 *
 * In local mode getActiveGitHubConnection must resolve the GitHub token from the
 * on-device LocalGitHubAuthService (the device-flow token in the local encrypted
 * store) and NEVER fall through to the gateway/Clerk SecretsAdapter chain — a
 * throwing stub adapter proves the short-circuit. Boundary mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { ConnectionsService } from '../../../src/services/ConnectionsService';
import { LocalGitHubAuthService } from '../../../src/services/LocalGitHubAuthService';

import type { SecretsAdapter } from '../../../src/db/SecretsAdapter';

// A SecretsAdapter that explodes on any call — if the local short-circuit works,
// none of these run.
const throwingAdapter = {
  getUserConnections: async () => {
    throw new Error('SecretsAdapter must not be reached in local mode');
  },
  getConnectionCredentials: async () => {
    throw new Error('SecretsAdapter must not be reached in local mode');
  },
} as unknown as SecretsAdapter;

let tmpDir: string;
let store: LocalSecretStore;
let ghAuth: LocalGitHubAuthService;
let service: ConnectionsService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-conn-gh-test-'));
  store = new LocalSecretStore({ dataDir: tmpDir });
  ghAuth = new LocalGitHubAuthService(store, { clientId: 'cid' });
  service = new ConnectionsService(throwingAdapter);
  service.setLocalGitHubAuthService(ghAuth);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('local-first GitHub connection resolution', () => {
  it('returns the on-device device-flow token as an oauth connection', async () => {
    ghAuth.setToken('gho_local', ['repo', 'read:org'], 'octocat');

    const result = await service.getActiveGitHubConnection('user@example.com');

    expect(result.type).toBe('oauth');
    expect(result.token).toBe('gho_local');
    expect(result.connection?.service).toBe('github');
    expect(result.connection?.isActive).toBe(true);
    expect(result.connection?.displayName).toContain('octocat');
  });

  it('returns "none" (connect-GitHub state) when no local token is stored', async () => {
    const result = await service.getActiveGitHubConnection('user@example.com');
    expect(result.type).toBe('none');
    expect(result.token).toBeUndefined();
  });
});
