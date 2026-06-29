/**
 * LocalSecretsAdapter
 *
 * Local-first replacement for ClerkSecretsAdapter. Connection credentials are
 * encrypted at rest in a LocalSecretStore (AES-256-GCM, per-install key under
 * DATA_DIR) instead of being shipped over HTTP to the gateway/Clerk. Connection
 * METADATA (displayName, service, isActive, …) still comes from the DbAdapter,
 * exactly as ClerkSecretsAdapter split responsibilities.
 *
 * Security: credentials are stored ONLY in the LocalSecretStore. storeConnection
 * persists an empty `{}` credentials object into the metadata DbAdapter, so the
 * connection rows returned to the mobile client never contain plaintext secrets
 * — getConnectionCredentials is the only path that decrypts, and it is used
 * server-side (tool execution) only.
 */
import { debugLog } from '@vgit2/shared/constants';
import { LocalSecretStore } from '@vgit2/shared/secrets';

import type { DbAdapter } from './DbAdapter.js';
import type { SecretsAdapter } from './SecretsAdapter.js';
import type {
  ServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

/** Namespaced key so connection creds never collide with other stored secrets. */
function credentialKey(connectionId: string): string {
  return `connection:${connectionId}`;
}

export class LocalSecretsAdapter implements SecretsAdapter {
  /**
   * @param dbAdapter - DbAdapter for connection metadata (non-credential data)
   * @param store     - LocalSecretStore for encrypted credential storage
   */
  constructor(
    private dbAdapter: DbAdapter,
    private store: LocalSecretStore = new LocalSecretStore()
  ) {}

  async getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]> {
    return this.dbAdapter.getUserConnections(options);
  }

  async getConnectionCredentials(options: GetConnectionOptions): Promise<any | null> {
    if (!options.connectionId) {
      console.warn('[LocalSecretsAdapter] No connectionId provided');
      return null;
    }
    const creds = this.store.getJSON<Record<string, unknown>>(credentialKey(options.connectionId));
    if (creds === undefined) {
      debugLog(`[LocalSecretsAdapter] No credentials stored for ${options.connectionId}`);
      return null;
    }
    return creds;
  }

  async getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null> {
    return this.dbAdapter.getConnection(options);
  }

  async getConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.dbAdapter.getConnectionsByService(options);
  }

  async storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection> {
    // Encrypt credentials locally; never persist them to the metadata store.
    if (options.credentials) {
      this.store.setJSON(credentialKey(options.connectionId), options.credentials);
      debugLog(`[LocalSecretsAdapter] Stored credentials locally for ${options.connectionId}`);
    }

    return this.dbAdapter.storeConnection({
      ...options,
      credentials: {}, // Empty - credentials live encrypted in the LocalSecretStore
    });
  }

  async deleteConnection(options: GetConnectionOptions): Promise<void> {
    if (options.connectionId) {
      this.store.delete(credentialKey(options.connectionId));
      debugLog(`[LocalSecretsAdapter] Deleted local credentials for ${options.connectionId}`);
    }
    await this.dbAdapter.deleteConnection(options);
  }

  async renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection> {
    // Credentials are keyed by connectionId, which is stable across a rename
    // (only the display name changes), so no credential migration is needed.
    return this.dbAdapter.renameConnection(options);
  }

  async toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection> {
    return this.dbAdapter.toggleConnectionActive(options);
  }

  async getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]> {
    return this.dbAdapter.getActiveConnectionsByService(options);
  }

  async hasConnection(options: GetConnectionOptions): Promise<boolean> {
    return this.dbAdapter.hasConnection(options);
  }
}
