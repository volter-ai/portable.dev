/**
 * Tunnel Provider Types
 *
 * The local-first runtime uses a single provider:
 * - QuickTunnelProvider: Cloudflare Quick Tunnels (per dev-server tunnel)
 */

import type { ChildProcess } from 'child_process';

/**
 * Metadata for an active tunnel
 */
export interface TunnelMetadata {
  userId: string;
  createdByChatId?: string;
  createdByRepoPath?: string;
  name: string;
  description?: string;
  main?: boolean;
  port: number;
  url: string;
  process: ChildProcess | null;
  createdAt: number;
  timeoutId?: NodeJS.Timeout;
  active?: boolean;
  isExternal?: boolean;
}

/**
 * Options for creating a tunnel
 */
export interface CreateTunnelOptions {
  port: number;
  userId: string;
  chatId?: string;
  repoPath?: string;
  name: string;
  description?: string;
  main?: boolean;
}

/**
 * Result of tunnel creation
 */
export interface CreateTunnelResult {
  url: string;
  tunnelId: string;
  metadata: TunnelMetadata;
}

/**
 * Provider mode - the local-first runtime only has the quick (local cloudflared) provider
 */
export type TunnelProviderMode = 'quick';

/**
 * Base interface for all tunnel providers
 */
export interface ITunnelProvider {
  /**
   * Get the mode this provider operates in
   */
  readonly mode: TunnelProviderMode;

  /**
   * Check if this provider supports the given port
   */
  isPortSupported(port: number): boolean;

  /**
   * Get the list of supported ports (for persistent providers)
   * Returns undefined for dynamic providers that support any port
   */
  getSupportedPorts(): number[] | undefined;

  /**
   * Get the tunnel URL for a port (persistent providers return pre-computed URL)
   */
  getTunnelUrl(port: number): string | Promise<string>;

  /**
   * Create or register a tunnel
   */
  createTunnel(options: CreateTunnelOptions): Promise<CreateTunnelResult>;

  /**
   * Destroy a specific tunnel
   */
  destroyTunnel(tunnelId: string, metadata: TunnelMetadata): Promise<void>;

  /**
   * Shutdown the provider (cleanup any processes)
   */
  shutdown(): Promise<void>;

  /**
   * Check if the provider is ready to create tunnels
   */
  isReady(): boolean;
}

/**
 * Quick tunnel provider interface
 * Used by Cloudflare Quick Tunnels (the only local-first provider)
 *
 * Key characteristics:
 * - Dynamic URLs (trycloudflare.com)
 * - Per-tunnel cloudflared process
 * - Any port supported
 * - Spawned on demand
 */
export interface IQuickTunnelProvider extends ITunnelProvider {
  mode: 'quick';

  /**
   * Get the URL for a port (must wait for tunnel creation)
   */
  getTunnelUrl(port: number): Promise<string>;
}
