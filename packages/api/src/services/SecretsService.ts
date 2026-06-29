/**
 * SecretsService
 *
 * Manages secrets (environment variables) that are automatically
 * added to all projects. Secrets are stored encrypted in the vault database.
 *
 * Storage: user_secrets_vault table (AES-256-GCM encrypted)
 *
 * Features:
 * - Create, read, update, delete secrets
 * - Source tracking (manual, env_editor, connection)
 * - Encrypted storage using crypto module
 * - Automatic injection into project .env files
 * - Per-user isolation
 * - Password-manager style vault for saving and reusing secrets
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import * as constants from '@vgit2/shared/constants';

import type { SecretsVaultAdapter, SavedSecret } from '../db/SecretsVaultAdapter.js';
import type { Secret, UserSecret } from '@vgit2/shared/types';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
}

export class SecretsService {
  private encryptionKey: Buffer;
  private vaultAdapter?: SecretsVaultAdapter;

  constructor(encryptionKey?: string, vaultAdapter?: SecretsVaultAdapter) {
    // Use provided key or generate from environment
    // In production, this should come from a secure key management service
    const keySource =
      encryptionKey || constants.PORTABLE_ENCRYPTION_KEY || 'default-key-change-in-production';
    this.encryptionKey = crypto.scryptSync(keySource, 'salt', KEY_LENGTH);
    this.vaultAdapter = vaultAdapter;
  }

  /**
   * Get the secrets file path for a user
   */
  private getSecretsFilePath(userEmail: string): string {
    const workspace = getUserWorkspaceDir(userEmail);
    const vgitDir = path.join(workspace, '.vgit');
    return path.join(vgitDir, 'secrets.json');
  }

  /**
   * Ensure the .vgit directory exists
   */
  private async ensureVgitDir(userEmail: string): Promise<void> {
    const workspace = getUserWorkspaceDir(userEmail);
    const vgitDir = path.join(workspace, '.vgit');

    try {
      await fs.access(vgitDir);
    } catch {
      await fs.mkdir(vgitDir, { recursive: true });
      console.log(`[SecretsService] Created .vgit directory for ${userEmail}`);
    }
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  private encrypt(data: string): EncryptedData {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  private decrypt(encryptedData: EncryptedData): string {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.encryptionKey,
      Buffer.from(encryptedData.iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Load secrets from encrypted file
   */
  private async loadSecrets(userEmail: string): Promise<UserSecret[]> {
    const filePath = this.getSecretsFilePath(userEmail);

    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      const encryptedData: EncryptedData = JSON.parse(fileContent);
      const decrypted = this.decrypt(encryptedData);
      return JSON.parse(decrypted);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, return empty array
        return [];
      }
      console.error(`[SecretsService] Error loading secrets for ${userEmail}:`, error);
      throw new Error('Failed to load secrets');
    }
  }

  /**
   * Save secrets to encrypted file
   */
  private async saveSecrets(userEmail: string, secrets: UserSecret[]): Promise<void> {
    await this.ensureVgitDir(userEmail);

    const filePath = this.getSecretsFilePath(userEmail);
    const data = JSON.stringify(secrets, null, 2);
    const encrypted = this.encrypt(data);

    await fs.writeFile(filePath, JSON.stringify(encrypted, null, 2), 'utf8');
    console.log(`[SecretsService] Saved ${secrets.length} secrets for ${userEmail}`);
  }

  /**
   * Get all secrets for a user
   */
  async getSecrets(userEmail: string): Promise<UserSecret[]> {
    console.log(`[SecretsService] Getting secrets for ${userEmail}`);
    return await this.loadSecrets(userEmail);
  }

  /**
   * Get a specific secret by key
   */
  async getSecret(userEmail: string, key: string): Promise<UserSecret | null> {
    const secrets = await this.loadSecrets(userEmail);
    return secrets.find((s) => s.key === key) || null;
  }

  /**
   * Create a new secret (legacy file-based storage)
   * @deprecated Use saveSecretToVault instead for database-backed storage with source tracking
   */
  async createSecret(
    userEmail: string,
    key: string,
    value: string,
    description?: string,
    source: 'manual' | 'env_editor' | 'connection' = 'manual'
  ): Promise<Secret> {
    console.log(`[SecretsService] Creating secret "${key}" for ${userEmail}`);

    // Validate key format (must be valid env var name)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        'Invalid key format. Must be uppercase letters, numbers, and underscores only, and cannot start with a number.'
      );
    }

    const secrets = await this.loadSecrets(userEmail);

    // Check if secret already exists
    if (secrets.some((s) => s.key === key)) {
      throw new Error(`Secret "${key}" already exists`);
    }

    const now = Date.now();
    const newSecret: Secret = {
      key,
      value,
      description,
      source,
      createdAt: now,
      updatedAt: now,
    };

    secrets.push(newSecret);
    await this.saveSecrets(userEmail, secrets);

    console.log(`[SecretsService] ✓ Created secret "${key}"`);
    return newSecret;
  }

  /**
   * Update an existing secret
   */
  async updateSecret(
    userEmail: string,
    key: string,
    updates: { value?: string; description?: string }
  ): Promise<UserSecret> {
    console.log(`[SecretsService] Updating secret "${key}" for ${userEmail}`);

    const secrets = await this.loadSecrets(userEmail);
    const secretIndex = secrets.findIndex((s) => s.key === key);

    if (secretIndex === -1) {
      throw new Error(`Secret "${key}" not found`);
    }

    const secret = secrets[secretIndex];

    if (updates.value !== undefined) {
      secret.value = updates.value;
    }

    if (updates.description !== undefined) {
      secret.description = updates.description;
    }

    secret.updatedAt = Date.now();

    secrets[secretIndex] = secret;
    await this.saveSecrets(userEmail, secrets);

    console.log(`[SecretsService] ✓ Updated secret "${key}"`);
    return secret;
  }

  /**
   * Delete a secret
   */
  async deleteSecret(userEmail: string, key: string): Promise<boolean> {
    console.log(`[SecretsService] Deleting secret "${key}" for ${userEmail}`);

    const secrets = await this.loadSecrets(userEmail);
    const filteredSecrets = secrets.filter((s) => s.key !== key);

    if (filteredSecrets.length === secrets.length) {
      // Secret not found
      return false;
    }

    await this.saveSecrets(userEmail, filteredSecrets);

    console.log(`[SecretsService] ✓ Deleted secret "${key}"`);
    return true;
  }

  /**
   * Get secrets as environment variables object (for injection)
   * This returns a plain object with key-value pairs
   */
  async getSecretsAsEnvVars(userEmail: string): Promise<Record<string, string>> {
    const secrets = await this.loadSecrets(userEmail);
    const envVars: Record<string, string> = {};

    for (const secret of secrets) {
      envVars[secret.key] = secret.value;
    }

    return envVars;
  }

  /**
   * Check if a secret exists
   */
  async secretExists(userEmail: string, key: string): Promise<boolean> {
    const secrets = await this.loadSecrets(userEmail);
    return secrets.some((s) => s.key === key);
  }

  // ============================================================================
  // VAULT METHODS - Password-manager style saved secrets
  // ============================================================================

  /**
   * Check if vault is available
   */
  private ensureVaultAvailable(): void {
    if (!this.vaultAdapter) {
      throw new Error('Secrets vault is not configured');
    }
  }

  /**
   * Get all saved secrets from vault (keys and metadata only)
   */
  async getSavedSecrets(
    userEmail: string,
    authToken?: string
  ): Promise<Array<{ key: string; lastUsedAt?: Date; createdAt: Date; updatedAt: Date }>> {
    this.ensureVaultAvailable();
    console.log(`[SecretsService] Getting saved secrets from vault for ${userEmail}`);

    const savedSecrets = await this.vaultAdapter!.getSavedSecrets(userEmail, authToken);

    // Return without values for security (values stay encrypted)
    return savedSecrets.map((s) => ({
      key: s.key,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Get a specific saved secret value from vault (decrypted)
   */
  async getSavedSecretValue(
    userEmail: string,
    key: string,
    authToken?: string
  ): Promise<string | null> {
    this.ensureVaultAvailable();
    console.log(`[SecretsService] Getting saved secret "${key}" from vault for ${userEmail}`);

    const savedSecret = await this.vaultAdapter!.getSavedSecret(userEmail, key, authToken);

    if (!savedSecret) {
      return null;
    }

    // Update last used timestamp
    await this.vaultAdapter!.updateLastUsed(userEmail, key, authToken);

    // Decrypt the value
    try {
      const encryptedData: EncryptedData = JSON.parse(savedSecret.valueEncrypted);
      return this.decrypt(encryptedData);
    } catch (error) {
      console.error(`[SecretsService] Error decrypting saved secret "${key}":`, error);
      throw new Error('Failed to decrypt saved secret');
    }
  }

  /**
   * Save a secret to the vault
   */
  async saveSecretToVault(
    userEmail: string,
    key: string,
    value: string,
    source: 'manual' | 'env_editor' | 'connection' = 'manual',
    sourceConnectionId?: string,
    authToken?: string
  ): Promise<void> {
    this.ensureVaultAvailable();
    console.log(
      `[SecretsService] Saving secret "${key}" to vault for ${userEmail} (source: ${source})`
    );

    // Validate key format (must be valid env var name)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        'Invalid key format. Must be uppercase letters, numbers, and underscores only, and cannot start with a number.'
      );
    }

    // Encrypt the value
    const encrypted = this.encrypt(value);
    const valueEncrypted = JSON.stringify(encrypted);

    await this.vaultAdapter!.saveSecret(
      userEmail,
      key,
      valueEncrypted,
      source,
      sourceConnectionId,
      authToken
    );

    console.log(`[SecretsService] ✓ Saved secret "${key}" to vault`);
  }

  /**
   * Delete a secret from the vault
   */
  async deleteSecretFromVault(userEmail: string, key: string, authToken?: string): Promise<void> {
    this.ensureVaultAvailable();
    console.log(`[SecretsService] Deleting secret "${key}" from vault for ${userEmail}`);

    await this.vaultAdapter!.deleteSecret(userEmail, key, authToken);

    console.log(`[SecretsService] ✓ Deleted secret "${key}" from vault`);
  }

  /**
   * Search vault for secrets matching a query (for autocomplete)
   */
  async searchVault(
    userEmail: string,
    query: string,
    authToken?: string
  ): Promise<Array<{ key: string; lastUsedAt?: Date }>> {
    this.ensureVaultAvailable();
    console.log(`[SecretsService] Searching vault for "${query}" for ${userEmail}`);

    const results = await this.vaultAdapter!.searchSecrets(userEmail, query, authToken);

    // Return keys and last used timestamps only
    return results.map((s) => ({
      key: s.key,
      lastUsedAt: s.lastUsedAt,
    }));
  }

  /**
   * Check if a secret exists in the vault
   */
  async secretExistsInVault(userEmail: string, key: string, authToken?: string): Promise<boolean> {
    this.ensureVaultAvailable();

    const savedSecret = await this.vaultAdapter!.getSavedSecret(userEmail, key, authToken);
    return savedSecret !== null;
  }
}
