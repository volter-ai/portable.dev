/**
 * LocalSecretsAdapter unit tests.
 *
 * Verifies the local-first SecretsAdapter contract:
 *  - credentials are stored ONLY in the encrypted LocalSecretStore
 *  - the metadata DbAdapter receives an EMPTY credentials object (never plaintext)
 *  - getConnectionCredentials decrypts from the local store
 *  - delete removes the local credential
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { LocalSecretsAdapter } from '../../../src/db/LocalSecretsAdapter.js';

import type { DbAdapter } from '../../../src/db/DbAdapter.js';
import type { ServiceConnection, StoreConnectionOptions } from '@vgit2/shared/types';

let tmpDir: string;

/** Minimal DbAdapter stub that records what storeConnection receives. */
function makeDbStub() {
  const calls: { storeConnection: StoreConnectionOptions[]; deleteConnection: unknown[] } = {
    storeConnection: [],
    deleteConnection: [],
  };
  const stub = {
    async storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
      calls.storeConnection.push(options);
      return {
        connectionId: options.connectionId,
        displayName: options.displayName,
        service: options.service,
        isActive: true,
      } as unknown as ServiceConnection;
    },
    async deleteConnection(options: unknown): Promise<void> {
      calls.deleteConnection.push(options);
    },
  } as unknown as DbAdapter;
  return { stub, calls };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-local-adapter-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalSecretsAdapter', () => {
  const baseStore = () => new LocalSecretStore({ dataDir: tmpDir });

  it('stores credentials in the local store and EMPTY creds in the metadata db', async () => {
    const { stub, calls } = makeDbStub();
    const store = baseStore();
    const adapter = new LocalSecretsAdapter(stub, store);

    await adapter.storeConnection({
      userId: 'u_1',
      connectionId: 'slack_1',
      displayName: 'Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: 'xoxb-secret' },
    });

    // Metadata db must never receive plaintext credentials.
    expect(calls.storeConnection).toHaveLength(1);
    expect(calls.storeConnection[0].credentials).toEqual({});

    // The encrypted store holds the real credentials, and not as plaintext on disk.
    const onDisk = fs.readFileSync(path.join(tmpDir, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('xoxb-secret');
  });

  it('retrieves stored credentials via getConnectionCredentials', async () => {
    const { stub } = makeDbStub();
    const store = baseStore();
    const adapter = new LocalSecretsAdapter(stub, store);

    await adapter.storeConnection({
      userId: 'u_1',
      connectionId: 'gh_1',
      displayName: 'GitHub',
      service: 'github',
      serviceType: 'cli',
      credentials: { accessToken: 'gho_abc' },
    });

    const creds = await adapter.getConnectionCredentials({ userId: 'u_1', connectionId: 'gh_1' });
    expect(creds).toEqual({ accessToken: 'gho_abc' });
  });

  it('returns null for an unknown connection', async () => {
    const { stub } = makeDbStub();
    const adapter = new LocalSecretsAdapter(stub, baseStore());
    expect(
      await adapter.getConnectionCredentials({ userId: 'u_1', connectionId: 'missing' })
    ).toBeNull();
  });

  it('deletes the local credential on deleteConnection', async () => {
    const { stub, calls } = makeDbStub();
    const store = baseStore();
    const adapter = new LocalSecretsAdapter(stub, store);

    await adapter.storeConnection({
      userId: 'u_1',
      connectionId: 'slack_1',
      displayName: 'Slack',
      service: 'slack',
      serviceType: 'sdk',
      credentials: { token: 'xoxb-secret' },
    });
    await adapter.deleteConnection({ userId: 'u_1', connectionId: 'slack_1' });

    expect(calls.deleteConnection).toHaveLength(1);
    expect(store.has('connection:slack_1')).toBe(false);
    expect(
      await adapter.getConnectionCredentials({ userId: 'u_1', connectionId: 'slack_1' })
    ).toBeNull();
  });
});
