/**
 * SecretsAdapter Interface
 *
 * Defines contract for connection/secrets storage operations.
 *
 * Architecture:
 * - LocalSecretsAdapter: encrypts credentials at rest in the local store (local-first, default)
 *
 * The ConnectionsService receives the adapter from server.ts, keeping all
 * storage logic abstracted away.
 */
import type {
  ServiceConnection,
  GetUserConnectionsOptions,
  GetConnectionOptions,
  GetConnectionsByServiceOptions,
  StoreConnectionOptions,
  RenameConnectionDbOptions,
} from '@vgit2/shared/types';

export interface SecretsAdapter {
  /**
   * Get all service connections for a user
   */
  getUserConnections(options: GetUserConnectionsOptions): Promise<ServiceConnection[]>;

  /**
   * Get credentials for a specific connection by name
   * Returns null if not found
   */
  getConnectionCredentials(options: GetConnectionOptions): Promise<any | null>;

  /**
   * Get a specific connection by name
   */
  getConnection(options: GetConnectionOptions): Promise<ServiceConnection | null>;

  /**
   * Get all connections for a specific service type
   */
  getConnectionsByService(options: GetConnectionsByServiceOptions): Promise<ServiceConnection[]>;

  /**
   * Store a new connection (or update existing)
   */
  storeConnection(options: StoreConnectionOptions): Promise<ServiceConnection>;

  /**
   * Delete a connection by name
   */
  deleteConnection(options: GetConnectionOptions): Promise<void>;

  /**
   * Rename a connection
   */
  renameConnection(options: RenameConnectionDbOptions): Promise<ServiceConnection>;

  /**
   * Toggle connection active status
   * For exclusive services, automatically disables other connections of the same service
   */
  toggleConnectionActive(
    options: GetConnectionOptions & { isActive: boolean }
  ): Promise<ServiceConnection>;

  /**
   * Get active connections for a service (for exclusive services)
   */
  getActiveConnectionsByService(
    options: GetConnectionsByServiceOptions
  ): Promise<ServiceConnection[]>;

  /**
   * Check if user has a specific connection by name
   */
  hasConnection(options: GetConnectionOptions): Promise<boolean>;
}
