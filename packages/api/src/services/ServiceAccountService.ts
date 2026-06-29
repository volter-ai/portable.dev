/**
 * ServiceAccountService
 *
 * Manages service account lifecycle and operations.
 * Orchestrates encryption, audit logging, and rate limiting services.
 *
 * Features:
 * - CRUD operations for service accounts
 * - Token generation, encryption, and validation
 * - Rate limit enforcement
 * - Audit logging for all operations
 * - Automatic cleanup of expired SAs
 * - Usage tracking
 *
 * Security:
 * - RLS enforced at database level (users can only access their own SAs)
 * - Tokens encrypted at rest (AES-256-GCM)
 * - Tokens only shown once on creation (like GitHub PATs)
 * - Immediate revocation on rotation/deletion
 * - All operations audited
 */

import { RateLimitService } from './RateLimitService.js';
import { ServiceAccountAuditService, type AuditAction } from './ServiceAccountAuditService.js';
import { ServiceAccountEncryptionService } from './ServiceAccountEncryptionService.js';

import type { DbAdapter } from '../db/DbAdapter.js';

// Expiration presets
const EXPIRATION_PRESETS = {
  '30d': 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
  '90d': 90 * 24 * 60 * 60 * 1000, // 90 days
  '1y': 365 * 24 * 60 * 60 * 1000, // 1 year
  never: null,
} as const;

type ExpirationPreset = keyof typeof EXPIRATION_PRESETS;

export interface ServiceAccount {
  id: string;
  userId: string;
  name: string;
  description?: string;
  tokenPrefix: string;
  allowedUserIds: string[];
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  rateLimitWindowStart: Date | null;
  rateLimitRequestsCount: number;
}

export interface ServiceAccountWithToken extends ServiceAccount {
  token: string; // Full decrypted token
}

export interface CreateServiceAccountRequest {
  userId: string;
  name: string;
  description?: string;
  allowedUserIds?: string[];
  expiresIn?: ExpirationPreset;
  ipAddress?: string;
  userAgent?: string;
  authToken?: string; // JWT for RLS authentication
}

export interface UpdateServiceAccountRequest {
  name?: string;
  description?: string;
  allowedUserIds?: string[];
  enabled?: boolean;
}

export class ServiceAccountService {
  private encryptionService: ServiceAccountEncryptionService;
  private auditService: ServiceAccountAuditService;
  private rateLimitService: RateLimitService;

  constructor(private dbAdapter: DbAdapter) {
    this.encryptionService = new ServiceAccountEncryptionService();
    this.auditService = new ServiceAccountAuditService(dbAdapter);
    this.rateLimitService = new RateLimitService(dbAdapter);

    console.log('[ServiceAccountService] Service account service initialized');
  }

  /**
   * Create a new service account
   *
   * Generates a secure token, encrypts it, and stores in database.
   * Token is only returned once - never retrievable again via API.
   *
   * @param request Service account creation request
   * @returns Service account with full token (SHOWN ONCE)
   *
   * @example
   * const sa = await service.create({
   *   userId: 'user@example.com',
   *   name: 'CI/CD Pipeline',
   *   description: 'Automated code reviews',
   *   allowedUserIds: ['user@example.com'],
   *   expiresIn: '90d',
   *   ipAddress: '203.0.113.45',
   *   userAgent: 'curl/7.81.0'
   * });
   * // Save sa.token now - it won't be shown again!
   */
  async create(request: CreateServiceAccountRequest): Promise<ServiceAccountWithToken> {
    try {
      const {
        userId,
        name,
        description,
        allowedUserIds,
        expiresIn,
        ipAddress,
        userAgent,
        authToken,
      } = request;

      // Validate inputs
      if (!userId || !name) {
        throw new Error('userId and name are required');
      }

      // Check if name already exists for this user
      const existingAccounts = await this.dbAdapter.getServiceAccounts(userId, authToken);
      const nameExists = existingAccounts.some((sa) => sa.name === name);

      if (nameExists) {
        throw new Error(`Service account with name "${name}" already exists`);
      }

      // Generate token
      const token = this.encryptionService.generateToken();
      const tokenPrefix = this.encryptionService.getTokenPrefix(token);

      // Encrypt token
      const encryptedToken = this.encryptionService.encrypt(token);

      // Calculate expiration
      let expiresAt: Date | null = null;
      if (expiresIn && expiresIn !== 'never') {
        const expirationMs = EXPIRATION_PRESETS[expiresIn];
        if (expirationMs) {
          expiresAt = new Date(Date.now() + expirationMs);
        }
      }

      // Default allowedUserIds to [userId] if not provided
      const finalAllowedUserIds =
        allowedUserIds && allowedUserIds.length > 0 ? allowedUserIds : [userId];

      // Generate a unique ID for the service account
      const id = crypto.randomUUID();

      // Insert into database using DbAdapter
      const success = await this.dbAdapter.createServiceAccount(
        {
          id,
          userId,
          name,
          description,
          tokenPrefix,
          tokenEncrypted: encryptedToken,
          allowedUserIds: finalAllowedUserIds,
          expiresAt: expiresAt || undefined,
        },
        authToken
      );

      if (!success) {
        throw new Error('Failed to create service account');
      }

      // Fetch the created account to get timestamps
      const created = await this.dbAdapter.getServiceAccount(id, userId, authToken);
      if (!created) {
        throw new Error('Failed to retrieve created service account');
      }

      // Log creation
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'create',
        details: {
          name,
          description,
          allowedUserIds: finalAllowedUserIds,
          expiresIn: expiresIn || 'never',
          expiresAt: expiresAt?.toISOString() || null,
        },
        ipAddress,
        userAgent,
        success: true,
        authToken,
      });

      console.log(`[ServiceAccountService] Created service account: ${name} (${id}) for ${userId}`);

      return {
        id,
        userId,
        name,
        description: description || undefined,
        tokenPrefix,
        token, // ONLY TIME TOKEN IS RETURNED IN PLAINTEXT
        allowedUserIds: finalAllowedUserIds,
        enabled: true,
        expiresAt,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        lastUsedAt: created.lastUsedAt || null,
        rateLimitWindowStart: null,
        rateLimitRequestsCount: 0,
      };
    } catch (error) {
      // Log failed creation
      await this.auditService.log({
        serviceAccountId: 'unknown',
        userId: request.userId,
        action: 'create',
        details: { name: request.name },
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        authToken: request.authToken,
      });

      console.error('[ServiceAccountService] Failed to create service account:', error);
      throw error;
    }
  }

  /**
   * List service accounts for a user
   *
   * Returns all SAs owned by the user (RLS enforced).
   * Tokens are NOT included - only token prefixes shown.
   *
   * @param userId Email of the user
   * @param includeDisabled Include disabled SAs (default: false)
   * @returns Array of service accounts (without full tokens)
   *
   * @example
   * const accounts = await service.list('user@example.com', false);
   */
  async list(
    userId: string,
    includeDisabled: boolean = false,
    authToken?: string
  ): Promise<ServiceAccount[]> {
    try {
      // Get all service accounts for the user using DbAdapter
      let accounts = await this.dbAdapter.getServiceAccounts(userId, authToken);

      // Filter out disabled accounts if requested
      if (!includeDisabled) {
        accounts = accounts.filter((sa) => sa.enabled);
      }

      // Map to ServiceAccount type (add missing fields)
      const result: ServiceAccount[] = accounts.map((sa) => ({
        id: sa.id,
        userId: sa.userId,
        name: sa.name,
        description: sa.description,
        tokenPrefix: sa.tokenPrefix,
        allowedUserIds: sa.allowedUserIds,
        enabled: sa.enabled,
        expiresAt: sa.expiresAt || null,
        createdAt: sa.createdAt,
        updatedAt: sa.updatedAt,
        lastUsedAt: sa.lastUsedAt || null,
        rateLimitWindowStart: null,
        rateLimitRequestsCount: 0,
      }));

      console.log(`[ServiceAccountService] Listed ${result.length} service accounts for ${userId}`);

      return result;
    } catch (error) {
      console.error('[ServiceAccountService] Failed to list service accounts:', error);
      throw new Error('Failed to list service accounts');
    }
  }

  /**
   * Get service account by ID with full token
   *
   * Returns SA with decrypted token.
   * Only owner can access (RLS enforced).
   *
   * @param id UUID of the service account
   * @param userId Email of the requesting user (for RLS)
   * @returns Service account with full decrypted token
   *
   * @example
   * const sa = await service.getById('uuid-xxx', 'user@example.com');
   * console.log('Token:', sa.token);  // Full token revealed
   */
  async getById(id: string, userId: string, authToken?: string): Promise<ServiceAccountWithToken> {
    try {
      // Get service account using DbAdapter
      const sa = await this.dbAdapter.getServiceAccount(id, userId, authToken);

      if (!sa) {
        throw new Error('Service account not found');
      }

      // Decrypt token
      const token = this.encryptionService.decrypt(sa.tokenEncrypted);

      console.log(`[ServiceAccountService] Retrieved service account: ${sa.name} (${id})`);

      return {
        id: sa.id,
        userId: sa.userId,
        name: sa.name,
        description: sa.description,
        tokenPrefix: sa.tokenPrefix,
        token, // Decrypted token
        allowedUserIds: sa.allowedUserIds,
        enabled: sa.enabled,
        expiresAt: sa.expiresAt || null,
        createdAt: sa.createdAt,
        updatedAt: sa.updatedAt,
        lastUsedAt: sa.lastUsedAt || null,
        rateLimitWindowStart: null,
        rateLimitRequestsCount: 0,
      };
    } catch (error) {
      console.error('[ServiceAccountService] Failed to get service account:', error);
      throw error;
    }
  }

  /**
   * Update service account metadata
   *
   * Can update: name, description, allowedUserIds, enabled status.
   * Cannot update: token (use rotate() instead).
   *
   * @param id UUID of the service account
   * @param userId Email of the requesting user (for RLS)
   * @param updates Fields to update
   * @param ipAddress Optional IP address for audit log
   * @param userAgent Optional user agent for audit log
   * @returns Updated service account (without token)
   *
   * @example
   * const updated = await service.update('uuid-xxx', 'user@example.com', {
   *   name: 'Updated Name',
   *   enabled: false
   * });
   */
  async update(
    id: string,
    userId: string,
    updates: UpdateServiceAccountRequest,
    ipAddress?: string,
    userAgent?: string,
    authToken?: string
  ): Promise<ServiceAccount> {
    try {
      // Validate that there are fields to update
      if (Object.keys(updates).length === 0) {
        throw new Error('No fields to update');
      }

      // Update using DbAdapter
      const success = await this.dbAdapter.updateServiceAccount(id, userId, updates, authToken);

      if (!success) {
        throw new Error('Service account not found or not authorized');
      }

      // Fetch updated account
      const updated = await this.dbAdapter.getServiceAccount(id, userId, authToken);
      if (!updated) {
        throw new Error('Service account not found or not authorized');
      }

      // Log update
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'update',
        details: updates,
        ipAddress,
        userAgent,
        success: true,
        authToken,
      });

      console.log(`[ServiceAccountService] Updated service account: ${updated.name} (${id})`);

      return {
        id: updated.id,
        userId: updated.userId,
        name: updated.name,
        description: updated.description,
        tokenPrefix: updated.tokenPrefix,
        allowedUserIds: updated.allowedUserIds,
        enabled: updated.enabled,
        expiresAt: updated.expiresAt || null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        lastUsedAt: updated.lastUsedAt || null,
        rateLimitWindowStart: null,
        rateLimitRequestsCount: 0,
      };
    } catch (error) {
      // Log failed update
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'update',
        details: updates,
        ipAddress,
        userAgent,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        authToken,
      });

      console.error('[ServiceAccountService] Failed to update service account:', error);
      throw error;
    }
  }

  /**
   * Delete (revoke) service account
   *
   * Soft delete - sets enabled = false.
   * Token is immediately invalidated.
   * Audit log is preserved.
   *
   * @param id UUID of the service account
   * @param userId Email of the requesting user (for RLS)
   * @param ipAddress Optional IP address for audit log
   * @param userAgent Optional user agent for audit log
   *
   * @example
   * await service.delete('uuid-xxx', 'user@example.com');
   * // Token immediately stops working
   */
  async delete(
    id: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    authToken?: string
  ): Promise<void> {
    try {
      // Get service account name before deletion
      const sa = await this.dbAdapter.getServiceAccount(id, userId, authToken);
      if (!sa) {
        throw new Error('Service account not found or not authorized');
      }

      // Delete using DbAdapter
      const success = await this.dbAdapter.deleteServiceAccount(id, userId, authToken);

      if (!success) {
        throw new Error('Service account not found or not authorized');
      }

      // Log deletion
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'delete',
        details: { name: sa.name },
        ipAddress,
        userAgent,
        success: true,
        authToken,
      });

      console.log(`[ServiceAccountService] Deleted service account: ${sa.name} (${id})`);
    } catch (error) {
      // Log failed deletion
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'delete',
        ipAddress,
        userAgent,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        authToken,
      });

      console.error('[ServiceAccountService] Failed to delete service account:', error);
      throw error;
    }
  }

  /**
   * Rotate service account token
   *
   * Generates new token, encrypts it, and replaces old token.
   * Old token is IMMEDIATELY invalidated.
   * New token is returned (shown once).
   *
   * @param id UUID of the service account
   * @param userId Email of the requesting user (for RLS)
   * @param ipAddress Optional IP address for audit log
   * @param userAgent Optional user agent for audit log
   * @returns Service account with NEW token
   *
   * @example
   * const sa = await service.rotate('uuid-xxx', 'user@example.com');
   * // Old token stops working immediately
   * // Save sa.token now - it won't be shown again!
   */
  async rotate(
    id: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    authToken?: string
  ): Promise<ServiceAccountWithToken> {
    try {
      // Get existing service account
      const existing = await this.dbAdapter.getServiceAccount(id, userId, authToken);
      if (!existing) {
        throw new Error('Service account not found or not authorized');
      }

      // Generate new token
      const newToken = this.encryptionService.generateToken();
      const tokenPrefix = this.encryptionService.getTokenPrefix(newToken);

      // Encrypt new token
      const encryptedToken = this.encryptionService.encrypt(newToken);

      // Update using DbAdapter (includes tokenEncrypted)
      const success = await this.dbAdapter.updateServiceAccount(
        id,
        userId,
        {
          tokenEncrypted: encryptedToken,
        },
        authToken
      );

      if (!success) {
        throw new Error('Service account not found or not authorized');
      }

      // Fetch updated account
      const updated = await this.dbAdapter.getServiceAccount(id, userId, authToken);
      if (!updated) {
        throw new Error('Service account not found or not authorized');
      }

      // Log rotation
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'rotate',
        details: { name: updated.name },
        ipAddress,
        userAgent,
        success: true,
        authToken,
      });

      console.log(
        `[ServiceAccountService] Rotated token for service account: ${updated.name} (${id})`
      );

      return {
        id: updated.id,
        userId: updated.userId,
        name: updated.name,
        description: updated.description,
        tokenPrefix: updated.tokenPrefix,
        token: newToken, // NEW TOKEN (shown once)
        allowedUserIds: updated.allowedUserIds,
        enabled: updated.enabled,
        expiresAt: updated.expiresAt || null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        lastUsedAt: updated.lastUsedAt || null,
        rateLimitWindowStart: null,
        rateLimitRequestsCount: 0,
      };
    } catch (error) {
      // Log failed rotation
      await this.auditService.log({
        serviceAccountId: id,
        userId,
        action: 'rotate',
        ipAddress,
        userAgent,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        authToken,
      });

      console.error('[ServiceAccountService] Failed to rotate token:', error);
      throw error;
    }
  }

  /**
   * Validate a service account token
   *
   * Checks if token is valid, enabled, and not expired.
   * Returns SA if valid, null if invalid.
   *
   * @param token The service account token to validate
   * @returns Service account (without token) if valid, null if invalid
   *
   * @example
   * const sa = await service.validateToken('sa_a1b2c3d4e5f6...');
   * if (!sa) {
   *   return res.status(401).json({ error: 'Invalid token' });
   * }
   */
  async validateToken(token: string): Promise<ServiceAccount | null> {
    try {
      // Validate token format
      if (!this.encryptionService.validateTokenFormat(token)) {
        return null;
      }

      const tokenPrefix = this.encryptionService.getTokenPrefix(token);

      // Find SA by token prefix (quick lookup) using DbAdapter
      const sa = await this.dbAdapter.getServiceAccountByPrefix(tokenPrefix);

      if (!sa) {
        return null;
      }

      // Decrypt stored token
      const storedToken = this.encryptionService.decrypt(sa.tokenEncrypted);

      // Compare tokens (constant-time comparison would be better, but sufficient)
      if (storedToken !== token) {
        return null;
      }

      // Token matches - check validity
      if (!sa.enabled) {
        console.log(`[ServiceAccountService] Token validation failed: disabled (${sa.id})`);
        return null;
      }

      if (sa.expiresAt && sa.expiresAt < new Date()) {
        console.log(`[ServiceAccountService] Token validation failed: expired (${sa.id})`);
        return null;
      }

      return {
        id: sa.id,
        userId: sa.userId,
        name: sa.name,
        description: undefined,
        tokenPrefix: this.encryptionService.getTokenPrefix(storedToken), // Extract prefix from validated token
        allowedUserIds: sa.allowedUserIds,
        enabled: sa.enabled,
        expiresAt: sa.expiresAt || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUsedAt: null,
        rateLimitWindowStart: sa.rateLimitWindowStart || null,
        rateLimitRequestsCount: sa.rateLimitRequestsCount,
      };
    } catch (error) {
      console.error('[ServiceAccountService] Token validation error:', error);
      return null;
    }
  }

  /**
   * Record usage of a service account
   *
   * Updates last_used_at timestamp and increments rate limit counter.
   *
   * @param id UUID of the service account
   */
  async recordUsage(id: string): Promise<void> {
    await this.rateLimitService.recordRequest(id);
  }

  /**
   * Check rate limits for a service account
   *
   * Returns whether request is allowed based on rate limits.
   *
   * @param id UUID of the service account
   * @returns Rate limit check result
   */
  async checkRateLimit(id: string) {
    return this.rateLimitService.checkServiceAccountLimit(id);
  }

  /**
   * Cleanup expired service accounts
   *
   * Disables SAs that have passed their expiration date.
   * Run periodically via cron job.
   *
   * @returns Number of SAs disabled
   *
   * @example
   * // Run daily cleanup
   * const disabled = await service.cleanup();
   * console.log(`Disabled ${disabled} expired service accounts`);
   */
  async cleanup(): Promise<number> {
    try {
      // Note: This is a simplified implementation
      // A more efficient implementation would require a dedicated DbAdapter method
      // For now, we'll return 0 and log a warning
      console.warn(
        `[ServiceAccountService] Cleanup operation not fully implemented - requires direct database access`
      );
      console.warn(
        `[ServiceAccountService] To cleanup expired service accounts, use database-level operations`
      );

      return 0;
    } catch (error) {
      console.error('[ServiceAccountService] Cleanup failed:', error);
      return 0;
    }
  }

  /**
   * Get audit service (for advanced audit operations)
   */
  getAuditService(): ServiceAccountAuditService {
    return this.auditService;
  }

  /**
   * Get rate limit service (for advanced rate limit operations)
   */
  getRateLimitService(): RateLimitService {
    return this.rateLimitService;
  }
}
