/**
 * Types for Clerk-based secrets storage
 *
 * This module defines types for storing encrypted credentials in Clerk's privateMetadata.
 * The API package communicates with Gateway via HTTP endpoints to store/retrieve secrets.
 */

/**
 * Represents an encrypted credential with AES-256-GCM
 */
export interface EncryptedCredential {
  /** Base64 encoded AES-256-GCM ciphertext */
  encrypted: string;
  /** Base64 encoded initialization vector (16 bytes) */
  iv: string;
  /** Base64 encoded authentication tag (16 bytes) */
  tag: string;
}

/**
 * A single connection's secret stored in Clerk
 */
export interface ClerkConnectionSecret {
  /** Service identifier (e.g., 'slack', 'aws-cli', 'google-drive') */
  service: string;
  /** AES-256-GCM encrypted credentials */
  encryptedCredentials: EncryptedCredential;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Structure stored in Clerk user.privateMetadata
 */
export interface ClerkSecretsMetadata {
  /** Map of connectionId -> encrypted secret */
  secretConnections: Record<string, ClerkConnectionSecret>;
  /** Schema version for future migrations */
  version: number;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request to store connection credentials in Clerk
 */
export interface StoreConnectionSecretRequest {
  /** Clerk user ID (must match JWT) */
  clerkUserId: string;
  /** Connection identifier (e.g., 'slack_1', 'aws-cli_2') */
  connectionId: string;
  /** Service identifier */
  service: string;
  /** Plain credentials object (will be encrypted by Gateway) */
  credentials: Record<string, unknown>;
}

/**
 * Response from storing connection credentials
 */
export interface StoreConnectionSecretResponse {
  success: boolean;
  connectionId: string;
  updatedAt: string;
}

/**
 * Request to get connection credentials from Clerk
 */
export interface GetConnectionSecretRequest {
  /** Clerk user ID (must match JWT) */
  clerkUserId: string;
  /** Connection identifier */
  connectionId: string;
}

/**
 * Response from getting connection credentials
 */
export interface GetConnectionSecretResponse {
  /** Plain credentials (decrypted by Gateway) */
  credentials: Record<string, unknown> | null;
  /** ISO timestamp of last update */
  updatedAt: string | null;
}

/**
 * Request to delete connection credentials from Clerk
 */
export interface DeleteConnectionSecretRequest {
  /** Clerk user ID (must match JWT) */
  clerkUserId: string;
  /** Connection identifier */
  connectionId: string;
}

/**
 * Response from deleting connection credentials
 */
export interface DeleteConnectionSecretResponse {
  success: boolean;
  connectionId: string;
}

/**
 * Response from listing connection IDs
 */
export interface ListConnectionSecretsResponse {
  /** Array of connection IDs stored in Clerk */
  connectionIds: string[];
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error response from Clerk secrets endpoints
 */
export interface ClerkSecretsErrorResponse {
  error: string;
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'ENCRYPTION_ERROR'
    | 'CLERK_ERROR'
    | 'INTERNAL_ERROR';
  details?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Current schema version for ClerkSecretsMetadata
 */
export const CLERK_SECRETS_SCHEMA_VERSION = 1;
