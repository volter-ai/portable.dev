/**
 * LocalSecretsVaultAdapter - local-first implementation of the secrets vault.
 *
 * The saved-secrets vault (password-manager-style "save and reuse" env vars)
 * persists to a local SQLite database under DATA_DIR via
 * {@link SqliteSecretsVaultStore}. Values arrive already encrypted (by
 * SecretsService), so this adapter only persists the opaque `value_encrypted`
 * blob.
 *
 * Single-user scoping: every method filters by `user_id` at the store layer.
 * The `authToken` argument from the {@link SecretsVaultAdapter} interface is
 * ignored in local mode.
 */

import { SqliteSecretsVaultStore } from './SqliteDbAdapter/SqliteSecretsVaultStore.js';

import type { SavedSecret, SecretsVaultAdapter } from './SecretsVaultAdapter.js';

export class LocalSecretsVaultAdapter implements SecretsVaultAdapter {
  private readonly store: SqliteSecretsVaultStore;
  private initialized = false;

  /**
   * @param dataDir Optional override for the vault SQLite directory (tests).
   *                Defaults to DATA_DIR via the store's own default.
   */
  constructor(dataDir?: string) {
    this.store = new SqliteSecretsVaultStore(dataDir);
  }

  /** Lazily open the SQLite store on first use. */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.store.initialize();
      this.initialized = true;
    }
  }

  /** Close the underlying SQLite handle (tests / graceful shutdown). */
  close(): void {
    this.store.close();
  }

  async getSavedSecrets(userId: string, _authToken?: string): Promise<SavedSecret[]> {
    await this.ensureInitialized();
    return this.store.getSavedSecrets(userId);
  }

  async getSavedSecret(
    userId: string,
    key: string,
    _authToken?: string
  ): Promise<SavedSecret | null> {
    await this.ensureInitialized();
    return this.store.getSavedSecret(userId, key);
  }

  async saveSecret(
    userId: string,
    key: string,
    valueEncrypted: string,
    source: 'manual' | 'env_editor' | 'connection' = 'manual',
    sourceConnectionId?: string,
    _authToken?: string
  ): Promise<void> {
    await this.ensureInitialized();
    return this.store.saveSecret(userId, key, valueEncrypted, source, sourceConnectionId);
  }

  async deleteSecret(userId: string, key: string, _authToken?: string): Promise<void> {
    await this.ensureInitialized();
    return this.store.deleteSecret(userId, key);
  }

  async searchSecrets(userId: string, query: string, _authToken?: string): Promise<SavedSecret[]> {
    await this.ensureInitialized();
    return this.store.searchSecrets(userId, query);
  }

  async updateLastUsed(userId: string, key: string, _authToken?: string): Promise<void> {
    await this.ensureInitialized();
    return this.store.updateLastUsed(userId, key);
  }
}
