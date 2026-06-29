/**
 * SecretsVaultAdapter - Interface for saved secrets storage
 *
 * Provides a consistent interface for storing and retrieving saved environment
 * variables (secrets vault) backed by local SQLite.
 *
 * This is separate from the regular secrets storage and is specifically for
 * the password-manager style "save and reuse" functionality.
 */

export interface SavedSecret {
  id?: string;
  userId: string;
  key: string;
  valueEncrypted: string;
  source: 'manual' | 'env_editor' | 'connection';
  sourceConnectionId?: string;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SecretsVaultAdapter {
  /**
   * Get all saved secrets for a user (returns keys and metadata only, no values)
   * @param userId - User identifier (email)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns Array of saved secrets (values still encrypted)
   */
  getSavedSecrets(userId: string, authToken?: string): Promise<SavedSecret[]>;

  /**
   * Get a specific saved secret by key
   * @param userId - User identifier (email)
   * @param key - Secret key name
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns Saved secret with encrypted value, or null if not found
   */
  getSavedSecret(userId: string, key: string, authToken?: string): Promise<SavedSecret | null>;

  /**
   * Save or update a secret in the vault
   * @param userId - User identifier (email)
   * @param key - Secret key name
   * @param valueEncrypted - Encrypted secret value
   * @param source - Source of the secret (manual, env_editor, connection)
   * @param sourceConnectionId - Connection ID if source='connection'
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns void
   */
  saveSecret(
    userId: string,
    key: string,
    valueEncrypted: string,
    source?: 'manual' | 'env_editor' | 'connection',
    sourceConnectionId?: string,
    authToken?: string
  ): Promise<void>;

  /**
   * Delete a secret from the vault
   * @param userId - User identifier (email)
   * @param key - Secret key name
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns void
   */
  deleteSecret(userId: string, key: string, authToken?: string): Promise<void>;

  /**
   * Search secrets by partial key match (for autocomplete)
   * @param userId - User identifier (email)
   * @param query - Search query (partial key name)
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns Array of matching saved secrets
   */
  searchSecrets(userId: string, query: string, authToken?: string): Promise<SavedSecret[]>;

  /**
   * Update the last used timestamp for a secret
   * @param userId - User identifier (email)
   * @param key - Secret key name
   * @param authToken - Optional JWT auth token (unused by the local SQLite adapter)
   * @returns void
   */
  updateLastUsed(userId: string, key: string, authToken?: string): Promise<void>;
}
