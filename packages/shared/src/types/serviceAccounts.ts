/**
 * Service Account Types
 *
 * Shared types for service account management across the client and backend.
 * These types ensure type safety for API requests/responses.
 */

// ============================================================================
// Core Types
// ============================================================================

export type ExpirationPreset = '30d' | '90d' | '1y' | 'never';

export type AuditAction = 'create' | 'update' | 'delete' | 'rotate' | 'regenerate' | 'use';

export interface ServiceAccount {
  id: string;
  userId: string;
  name: string;
  description?: string;
  tokenPrefix: string; // First 10 chars: "sa_xxxxxxxx"
  allowedUserIds: string[];
  enabled: boolean;
  expiresAt: string | null; // ISO 8601 timestamp
  createdAt: string; // ISO 8601 timestamp
  updatedAt: string; // ISO 8601 timestamp
  lastUsedAt: string | null; // ISO 8601 timestamp
  rateLimitUsage?: {
    current: number;
    limit: number;
    windowStart: string; // ISO 8601 timestamp
  };
}

export interface ServiceAccountWithToken extends ServiceAccount {
  token: string; // Full token (70 chars) - only shown on creation/rotation
}

export interface AuditLogEntry {
  id: string;
  serviceAccountId: string;
  userId: string;
  action: AuditAction;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMessage?: string;
  timestamp: string; // ISO 8601 timestamp
}

// ============================================================================
// API Request Types
// ============================================================================

export interface CreateServiceAccountRequest {
  name: string;
  description?: string;
  allowedUserIds?: string[];
  expiresIn?: ExpirationPreset;
}

export interface UpdateServiceAccountRequest {
  name?: string;
  description?: string;
  allowedUserIds?: string[];
  enabled?: boolean;
}

export interface GetAuditLogsRequest {
  limit?: number; // Default: 50, Max: 200
  offset?: number; // Default: 0
  action?: AuditAction;
  success?: boolean;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface CreateServiceAccountResponse extends ServiceAccountWithToken {
  // Includes full token (shown once)
}

export interface ListServiceAccountsResponse {
  serviceAccounts: ServiceAccount[];
  total: number;
}

export interface GetServiceAccountResponse extends ServiceAccountWithToken {
  // Includes full token (for owner only)
}

export interface UpdateServiceAccountResponse extends ServiceAccount {
  // Updated SA without token
}

export interface RotateTokenResponse {
  id: string;
  token: string; // New token (shown once)
  tokenPrefix: string;
  rotatedAt: string; // ISO 8601 timestamp
}

export interface GetAuditLogsResponse {
  logs: AuditLogEntry[];
  total: number;
}

// ============================================================================
// Rate Limit Types
// ============================================================================

export interface RateLimitInfo {
  current: number; // Current request count in window
  limit: number; // Maximum requests allowed per window
  remaining: number; // Requests remaining in window
  resetAt: string; // ISO 8601 timestamp when window resets
  percentUsed: number; // Percentage of limit used (0-100)
}

export interface RateLimitError {
  error: string;
  message: string;
  resetAt: string; // ISO 8601 timestamp
  retryAfter: number; // Seconds until retry allowed
}

// ============================================================================
// Error Types
// ============================================================================

export interface ServiceAccountError {
  error: string;
  message?: string;
  details?: Record<string, any>;
}

// ============================================================================
// Usage Statistics Types
// ============================================================================

export interface UsageStatistics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  uniqueDays: number;
  avgRequestsPerDay: number;
}
