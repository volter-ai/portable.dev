/**
 * ServiceAccountEncryptionService
 *
 * Handles secure token generation and encryption for service accounts.
 *
 * Features:
 * - Generates cryptographically secure tokens (sa_<32_bytes_hex>)
 * - AES-256-GCM encryption for token storage
 * - Unique IV (initialization vector) per token
 * - Authentication tags for integrity verification
 * - Key derivation via scrypt
 *
 * Security:
 * - Token format: sa_<64 hex chars> = 70 characters total
 * - 256 bits of entropy (32 bytes)
 * - Encryption key derived from SERVICE_ACCOUNT_ENCRYPTION_KEY env var
 * - Falls back to PORTABLE_ENCRYPTION_KEY if not set
 */

import crypto from 'crypto';

import * as constants from '@vgit2/shared/constants';

// Encryption configuration (matches UserSecretsService)
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const TOKEN_BYTES = 32; // 256 bits of entropy
const TOKEN_PREFIX = 'sa_';

interface EncryptedToken {
  encrypted: string; // Hex-encoded encrypted data
  iv: string; // Hex-encoded initialization vector
  tag: string; // Hex-encoded authentication tag
}

export class ServiceAccountEncryptionService {
  private encryptionKey: Buffer;

  constructor(encryptionKey?: string) {
    // Use provided key or fall back to environment variables
    // Priority: provided key > SERVICE_ACCOUNT_ENCRYPTION_KEY > PORTABLE_ENCRYPTION_KEY > default
    const keySource =
      encryptionKey ||
      constants.SERVICE_ACCOUNT_ENCRYPTION_KEY ||
      constants.PORTABLE_ENCRYPTION_KEY ||
      'default-key-change-in-production';

    // Derive encryption key using scrypt (same as UserSecretsService)
    // Using 'sa-salt' to ensure different derived key from user secrets
    this.encryptionKey = crypto.scryptSync(keySource, 'sa-salt', KEY_LENGTH);

    console.log('[ServiceAccountEncryption] Encryption service initialized');
  }

  /**
   * Generate a new service account token
   *
   * Format: sa_<64 hex characters>
   * Total length: 70 characters
   * Entropy: 256 bits (32 bytes)
   *
   * @returns Secure random token with sa_ prefix
   *
   * @example
   * const token = service.generateToken();
   * // "sa_a1b2c3d4e5f6789...64_hex_chars"
   */
  generateToken(): string {
    const randomBytes = crypto.randomBytes(TOKEN_BYTES);
    const token = `${TOKEN_PREFIX}${randomBytes.toString('hex')}`;

    console.log(
      `[ServiceAccountEncryption] Generated token with prefix: ${this.getTokenPrefix(token)}`
    );

    return token;
  }

  /**
   * Get the token prefix for display (first 10 characters)
   *
   * Used for showing tokens in lists without revealing the full token.
   * Format: "sa_xxxxxxxx"
   *
   * @param token Full service account token
   * @returns First 10 characters (sa_ + 8 hex chars)
   *
   * @example
   * const prefix = service.getTokenPrefix("sa_a1b2c3d4e5f6...");
   * // "sa_a1b2c3d4"
   */
  getTokenPrefix(token: string): string {
    if (!token || token.length < 10) {
      throw new Error('Invalid token: too short');
    }

    if (!token.startsWith(TOKEN_PREFIX)) {
      throw new Error(`Invalid token: must start with ${TOKEN_PREFIX}`);
    }

    return token.substring(0, 10);
  }

  /**
   * Encrypt a service account token using AES-256-GCM
   *
   * AES-256-GCM provides:
   * - Confidentiality (encryption)
   * - Authenticity (authentication tag)
   * - Integrity (detects tampering)
   *
   * @param token The plaintext service account token
   * @returns Encrypted data with IV and authentication tag
   *
   * @example
   * const encrypted = service.encrypt("sa_a1b2c3d4e5f6...");
   * // {
   * //   encrypted: "f3a8b9c1d2e3...",  // Hex-encoded
   * //   iv: "a1b2c3d4e5f6...",        // Hex-encoded IV
   * //   tag: "x9y8z7w6v5u4..."        // Hex-encoded auth tag
   * // }
   */
  encrypt(token: string): EncryptedToken {
    try {
      // Generate unique IV for this encryption
      const iv = crypto.randomBytes(IV_LENGTH);

      // Create cipher with key and IV
      const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

      // Encrypt the token
      let encrypted = cipher.update(token, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Get authentication tag
      const tag = cipher.getAuthTag();

      const result = {
        encrypted,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
      };

      console.log('[ServiceAccountEncryption] Token encrypted successfully');

      return result;
    } catch (error) {
      console.error('[ServiceAccountEncryption] Encryption failed:', error);
      throw new Error('Token encryption failed');
    }
  }

  /**
   * Decrypt a service account token using AES-256-GCM
   *
   * Verifies authentication tag to ensure data integrity.
   * Throws error if token has been tampered with.
   *
   * @param encryptedData The encrypted token data (encrypted, iv, tag)
   * @returns The decrypted plaintext token
   * @throws Error if decryption fails or authentication tag is invalid
   *
   * @example
   * const token = service.decrypt({
   *   encrypted: "f3a8b9c1d2e3...",
   *   iv: "a1b2c3d4e5f6...",
   *   tag: "x9y8z7w6v5u4..."
   * });
   * // "sa_a1b2c3d4e5f6..."
   */
  decrypt(encryptedData: EncryptedToken): string {
    try {
      // Create decipher with key and IV
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        this.encryptionKey,
        Buffer.from(encryptedData.iv, 'hex')
      );

      // Set authentication tag
      decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));

      // Decrypt the token
      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      console.log('[ServiceAccountEncryption] Token decrypted successfully');

      return decrypted;
    } catch (error) {
      console.error('[ServiceAccountEncryption] Decryption failed:', error);
      throw new Error('Token decryption failed - data may be corrupted or tampered with');
    }
  }

  /**
   * Hash a token for quick lookup (optional)
   *
   * NOT used for encryption - only for creating indexes or quick lookups.
   * Uses SHA-256 for deterministic hashing.
   *
   * @param token The plaintext service account token
   * @returns SHA-256 hash of the token (hex-encoded)
   *
   * @example
   * const hash = service.hashToken("sa_a1b2c3d4e5f6...");
   * // "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Validate token format
   *
   * Checks if a token matches the expected format:
   * - Starts with "sa_"
   * - Followed by 64 hex characters
   * - Total length: 70 characters
   *
   * @param token Token to validate
   * @returns true if valid, false otherwise
   *
   * @example
   * service.validateTokenFormat("sa_a1b2c3d4e5f6..."); // true
   * service.validateTokenFormat("invalid");              // false
   * service.validateTokenFormat("user_token_123");       // false
   */
  validateTokenFormat(token: string): boolean {
    // Check basic structure
    if (!token || typeof token !== 'string') {
      return false;
    }

    // Check prefix
    if (!token.startsWith(TOKEN_PREFIX)) {
      return false;
    }

    // Check total length (sa_ + 64 hex chars = 70)
    if (token.length !== TOKEN_PREFIX.length + TOKEN_BYTES * 2) {
      return false;
    }

    // Check if remaining characters are valid hex
    const hexPart = token.substring(TOKEN_PREFIX.length);
    const hexRegex = /^[a-f0-9]{64}$/i;

    return hexRegex.test(hexPart);
  }

  /**
   * Get encryption configuration info (for debugging)
   *
   * Returns non-sensitive information about the encryption configuration.
   * Never logs actual keys or sensitive data.
   *
   * @returns Configuration info object
   */
  getConfigInfo(): {
    algorithm: string;
    keyLength: number;
    ivLength: number;
    tagLength: number;
    tokenLength: number;
  } {
    return {
      algorithm: ALGORITHM,
      keyLength: KEY_LENGTH,
      ivLength: IV_LENGTH,
      tagLength: TAG_LENGTH,
      tokenLength: TOKEN_PREFIX.length + TOKEN_BYTES * 2,
    };
  }
}
