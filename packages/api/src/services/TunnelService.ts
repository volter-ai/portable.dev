import * as http from 'http';

import { debugLog } from '@vgit2/shared/constants';

import {
  QuickTunnelProvider,
  type TunnelMetadata,
  type CreateTunnelOptions,
} from './tunnel/index.js';

import type { TunnelRepairResult } from '@vgit2/shared/types';

/**
 * Configuration options for TunnelService
 *
 * The local-first runtime only has the single local cloudflared (quick) provider,
 * so the only accepted mode is 'quick'. The option is kept for test ergonomics /
 * forward-compat; it does not change provider selection.
 */
export interface TunnelServiceOptions {
  /** Tunnel mode — only 'quick' is supported (the single local cloudflared provider). */
  mode?: 'quick';
}

/**
 * TunnelService - Tunnel management for the local-first runtime
 *
 * ## Architecture
 *
 * The service uses a single provider — QuickTunnelProvider (Cloudflare Quick Tunnels):
 * - Dynamic URLs (trycloudflare.com)
 * - Per-tunnel cloudflared process
 * - Any port supported
 *
 * The old pre-configured-tunnel path and the stable Named-Tunnel path were removed
 * in the local-first pivot. The launcher (`@vgit2/launcher`) owns the main
 * cloudflared tunnel; this service only manages on-demand dev-server tunnels.
 *
 * ## Responsibilities
 *
 * TunnelService orchestrates:
 * - Provider lifecycle
 * - Tunnel metadata management (chatId, repoPath, main flag)
 * - Tunnel replacement logic (same name+repoPath on different port)
 * - Main tunnel management (only one main per repo)
 * - Health checks and port validation
 * - Rate limiting for dynamic tunnels
 * - State change notifications
 */
export class TunnelService {
  // Provider handles actual tunnel creation/destruction
  private provider: QuickTunnelProvider;

  // Track active tunnels with metadata
  private activeTunnels: Map<string, TunnelMetadata> = new Map();

  // Rate limiting for quick tunnels
  private userTunnelCount: Map<string, number[]> = new Map();
  private readonly MAX_TUNNELS_PER_HOUR = 5;
  private readonly TUNNEL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  // Callback for tunnel state changes
  private stateChangeCallback?: (userId: string) => void;

  constructor(_options?: TunnelServiceOptions) {
    debugLog('[TunnelService] TunnelService initialized (QuickTunnelProvider)');
    this.provider = new QuickTunnelProvider();
    // Evict a tunnel the instant its cloudflared child dies (crash/flap/network
    // give-up) and re-broadcast, so a dead tunnel never lingers in the client.
    this.provider.setTunnelExitCallback((tunnelId) => this.handleProviderTunnelExit(tunnelId));
  }

  /**
   * A tunnel's cloudflared child exited. If the tunnel is still tracked (i.e. this
   * was NOT an intentional destroy/shutdown — those remove it from the map first),
   * it crashed/flapped: drop it and notify clients so the dead tunnel disappears.
   * Idempotent — a no-op once the tunnel has already been removed.
   */
  private handleProviderTunnelExit(tunnelId: string): void {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel) return; // already removed (intentional destroy / shutdown)
    console.warn(
      `[TunnelService] cloudflared for tunnel ${tunnelId} (port ${tunnel.port}) exited; evicting dead tunnel`
    );
    if (tunnel.timeoutId) clearTimeout(tunnel.timeoutId);
    this.activeTunnels.delete(tunnelId);
    if (this.stateChangeCallback) this.stateChangeCallback(tunnel.userId);
  }

  /**
   * Set callback to be called when tunnel state changes
   * Used to broadcast runtime state updates to connected clients
   */
  public setStateChangeCallback(callback: (userId: string) => void): void {
    this.stateChangeCallback = callback;
  }

  /**
   * Get tunnel mappings for system prompt generation
   * Returns array of {port, url} for all active tunnels
   */
  public getTunnelMappings(userId?: string): Array<{ port: number; url: string }> {
    const tunnels: Array<{ port: number; url: string }> = [];

    this.activeTunnels.forEach((tunnel) => {
      if (!userId || tunnel.userId === userId) {
        tunnels.push({
          port: tunnel.port,
          url: tunnel.url,
        });
      }
    });

    return tunnels;
  }

  /**
   * Check if a port is supported by the current provider
   */
  public isPortSupported(port: number): boolean {
    return this.provider.isPortSupported(port);
  }

  /**
   * Check if a port is actively listening
   */
  public async isPortActive(port: number): Promise<boolean> {
    return this.provider.isPortActive(port);
  }

  /**
   * Check health of all tunnels for a user and update active status
   */
  async checkTunnelHealth(userId: string): Promise<void> {
    console.log(`[TunnelService] Checking tunnel health for user: ${userId}`);

    for (const [_tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.userId === userId) {
        const wasActive = tunnel.active ?? true;
        const isActive = await this.isPortActive(tunnel.port);
        tunnel.active = isActive;

        const statusChange =
          wasActive !== isActive ? ` (changed from ${wasActive ? 'ACTIVE' : 'INACTIVE'})` : '';
        console.log(
          `[TunnelService] Port :${tunnel.port} - ${isActive ? 'ACTIVE' : 'INACTIVE'}${statusChange}`
        );
      }
    }
  }

  /**
   * Shutdown all active tunnels
   */
  async shutdown(): Promise<void> {
    console.log('[TunnelService] Shutting down all tunnels...');

    // Destroy all active tunnels
    const tunnelIds = Array.from(this.activeTunnels.keys());
    console.log(`[TunnelService] Destroying ${tunnelIds.length} active tunnels...`);

    for (const tunnelId of tunnelIds) {
      await this.destroyTunnel(tunnelId);
    }

    // Shutdown the provider
    await this.provider.shutdown();

    console.log('[TunnelService] ✓ Shutdown complete');
  }

  /**
   * Create a local tunnel for a specific port
   *
   * Spawns a cloudflared Quick Tunnel with a dynamic URL (any port supported).
   */
  async createLocalTunnel(
    port: number,
    userId: string,
    chatId: string | undefined,
    repoPath: string | undefined,
    name: string,
    description?: string,
    main?: boolean
  ): Promise<string> {
    // Handle replacement logic: close existing tunnel with same name+repoPath on different port
    if (name && repoPath) {
      await this.handleTunnelReplacement(userId, name, repoPath, port);
    }

    // Check for existing tunnel on same port for this user
    for (const [tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.port === port && tunnel.userId === userId) {
        // Verify the cloudflared process is still alive and the port is listening
        const isProcessAlive =
          tunnel.process && !tunnel.process.killed && tunnel.process.exitCode === null;
        const isPortListening = await this.isPortActive(port);

        if (isProcessAlive && isPortListening) {
          console.log(`[TunnelService] Tunnel already exists for port ${port}: ${tunnel.url}`);
          return tunnel.url;
        } else {
          console.log(`[TunnelService] Found stale tunnel for port ${port}, cleaning up...`);
          await this.destroyTunnel(tunnelId);
          break;
        }
      }
    }

    // Handle main tunnel logic
    if (main && repoPath) {
      this.unsetPreviousMainTunnel(userId, repoPath);
    }

    // Create tunnel via provider
    const options: CreateTunnelOptions = {
      port,
      userId,
      chatId,
      repoPath,
      name,
      description,
      main,
    };

    const result = await this.provider.createTunnel(options);

    // Store tunnel metadata
    this.activeTunnels.set(result.tunnelId, result.metadata);

    // Notify state change callback
    if (this.stateChangeCallback) {
      this.stateChangeCallback(userId);
    }

    return result.url;
  }

  /**
   * Destroy a local tunnel by port
   */
  async destroyLocalTunnel(port: number): Promise<void> {
    console.log(`[TunnelService] Destroying local tunnel for port ${port}...`);

    let tunnelId: string | undefined;
    for (const [id, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.port === port && tunnel.userId === 'local') {
        tunnelId = id;
        break;
      }
    }

    if (!tunnelId) {
      console.warn(`[TunnelService] No local tunnel found for port ${port}`);
      return;
    }

    await this.destroyTunnel(tunnelId);
    console.log(`[TunnelService] ✓ Local tunnel destroyed for port ${port}`);
  }

  /**
   * Lazily REPAIR a dead dev-server preview tunnel the user just touched.
   *
   * The phone reaches a per-port dev server only through its `*.trycloudflare.com`
   * Quick Tunnel; that tunnel dies whenever its cloudflared child dies (PC/dev
   * restart, the free tunnel flapping, the PC dropping its network) and Cloudflare
   * then answers a Bad Gateway. Rather than mass-reopening every tunnel, we repair
   * ONLY the port the user touched:
   *
   * - **Port still listening** → force a FRESH tunnel (destroy any stale/wedged one
   *   first so even a cloudflared that is alive-but-unreachable is replaced), and
   *   return the new URL for the client to reload.
   * - **Port not listening** (the dev server stopped too) → there is nothing to
   *   tunnel; clear any stale tunnel for the port (so the client converges) and
   *   report `dev_server_down` so the UI can prompt to restart the dev server
   *   instead of showing a confusing Cloudflare error.
   *
   * Always re-broadcasts via the state-change callback so every surface converges
   * on the single source of truth. Never throws (a failure to spawn a fresh tunnel
   * on a live port degrades to `dev_server_down`).
   */
  async repairTunnel(
    userId: string,
    port: number,
    opts?: { chatId?: string; repoPath?: string; name?: string; main?: boolean }
  ): Promise<TunnelRepairResult> {
    console.log(`[TunnelService] Repair requested for user ${userId} port ${port}`);

    // Capture metadata from the existing (stale) tunnel before we drop it, so the
    // repaired tunnel keeps its name / chat-and-repo scoping / main flag.
    const existingId = this.findUserTunnelIdByPort(userId, port);
    const existing = existingId ? this.activeTunnels.get(existingId) : undefined;
    const name = opts?.name ?? existing?.name ?? 'app';
    const chatId = opts?.chatId ?? existing?.createdByChatId;
    const repoPath = opts?.repoPath ?? existing?.createdByRepoPath;
    const main = opts?.main ?? existing?.main;

    const portActive = await this.isPortActive(port);
    if (!portActive) {
      // The dev server is gone too — nothing to tunnel. Drop the stale tunnel so
      // the client stops showing a dead preview, then report dev_server_down.
      if (existingId) {
        await this.destroyTunnel(existingId);
      }
      if (this.stateChangeCallback) this.stateChangeCallback(userId);
      console.log(`[TunnelService] Repair: port ${port} not listening → dev_server_down`);
      return { status: 'dev_server_down', port };
    }

    // Force a brand-new tunnel: destroy the old one first so a cloudflared that is
    // alive-but-unreachable (edge dropped) is replaced rather than reused.
    if (existingId) {
      await this.destroyTunnel(existingId);
    }

    try {
      const url = await this.createLocalTunnel(
        port,
        userId,
        chatId,
        repoPath,
        name,
        undefined,
        main
      );
      console.log(`[TunnelService] Repair: port ${port} → fresh tunnel ${url}`);
      return { status: 'repaired', port, url };
    } catch (error) {
      // TOCTOU: the port went away between the probe and the spawn, or cloudflared
      // is missing. Treat as dev_server_down (the honest, non-confusing outcome).
      console.warn(`[TunnelService] Repair: failed to create tunnel for port ${port}:`, error);
      if (this.stateChangeCallback) this.stateChangeCallback(userId);
      return { status: 'dev_server_down', port };
    }
  }

  /** Find the active tunnel id for a user's port, or undefined. */
  private findUserTunnelIdByPort(userId: string, port: number): string | undefined {
    for (const [id, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.userId === userId && tunnel.port === port) return id;
    }
    return undefined;
  }

  /**
   * Create Named Tunnel with JWT token (legacy method)
   * NOTE: This is a passthrough to createLocalTunnel for backward compatibility
   */
  async createQuickTunnelWithToken(
    port: number,
    token: string,
    userId: string,
    chatId: string | undefined,
    repoPath: string | undefined,
    name: string,
    description?: string,
    main?: boolean
  ): Promise<string> {
    // For now, delegate to createLocalTunnel
    // The token parameter is not used with the new provider architecture
    return this.createLocalTunnel(port, userId, chatId, repoPath, name, description, main);
  }

  /**
   * Create a dynamic Cloudflare Tunnel with rate limiting
   */
  async createDynamicTunnel(
    userId: string,
    port: number,
    name: string,
    description?: string,
    main?: boolean
  ): Promise<string> {
    console.log(`[TunnelService] Creating dynamic tunnel for user ${userId} on port ${port}...`);

    // Check rate limit
    await this.rateLimitCheck(userId);

    // Create tunnel via provider
    const options: CreateTunnelOptions = {
      port,
      userId,
      name,
      description,
      main,
    };

    const result = await this.provider.createTunnel(options);

    // Set up auto-cleanup timeout
    const timeoutId = setTimeout(() => {
      console.log(
        `[TunnelService] Auto-expiring tunnel ${result.tunnelId} after ${this.TUNNEL_TIMEOUT_MS}ms`
      );
      this.destroyTunnel(result.tunnelId);
    }, this.TUNNEL_TIMEOUT_MS);

    // Store with timeout
    result.metadata.timeoutId = timeoutId;
    this.activeTunnels.set(result.tunnelId, result.metadata);

    // Track creation for rate limiting
    this.trackTunnelCreation(userId);

    return result.url;
  }

  /**
   * Destroy a tunnel by ID
   */
  async destroyTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.activeTunnels.get(tunnelId);
    if (!tunnel) {
      console.warn(`[TunnelService] Tunnel ${tunnelId} not found`);
      return;
    }

    console.log(`[TunnelService] Destroying tunnel ${tunnelId} (${tunnel.url})`);

    // Clear timeout if exists
    if (tunnel.timeoutId) {
      clearTimeout(tunnel.timeoutId);
    }

    // Destroy via provider
    await this.provider.destroyTunnel(tunnelId, tunnel);

    // Remove from map
    this.activeTunnels.delete(tunnelId);

    console.log(`[TunnelService] ✓ Tunnel ${tunnelId} destroyed`);
  }

  /**
   * Check if a port is healthy (responding to HTTP requests)
   */
  async checkPortHealth(
    port: number
  ): Promise<{ healthy: boolean; statusCode?: number; error?: string }> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: port,
          path: '/',
          method: 'GET',
          timeout: 2000,
        },
        (res) => {
          const statusCode = res.statusCode || 0;
          res.on('data', () => {});
          res.on('end', () => {});

          if (statusCode >= 200 && statusCode < 400) {
            resolve({ healthy: true, statusCode });
          } else if (statusCode === 404) {
            resolve({
              healthy: false,
              statusCode,
              error: 'Port returning 404 Not Found',
            });
          } else if (statusCode >= 500) {
            resolve({
              healthy: false,
              statusCode,
              error: `Server error (HTTP ${statusCode})`,
            });
          } else {
            resolve({
              healthy: false,
              statusCode,
              error: `Unexpected status code (HTTP ${statusCode})`,
            });
          }
        }
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          resolve({
            healthy: false,
            error: 'Connection refused (ECONNREFUSED) - server not running',
          });
        } else if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
          resolve({
            healthy: false,
            error: 'Connection timeout (2s) - server not responding',
          });
        } else {
          resolve({
            healthy: false,
            error: `Connection error: ${err.message}`,
          });
        }
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          healthy: false,
          error: 'Connection timeout (2s) - server not responding',
        });
      });

      req.end();
    });
  }

  /**
   * Get all active tunnels for a user
   */
  getUserTunnels(userId: string): Array<{
    id: string;
    url: string;
    port: number;
    name: string;
    description?: string;
    main?: boolean;
    createdAt: number;
    active?: boolean;
    createdByChatId?: string;
    createdByRepoPath?: string;
  }> {
    const userTunnels: Array<{
      id: string;
      url: string;
      port: number;
      name: string;
      description?: string;
      main?: boolean;
      createdAt: number;
      active?: boolean;
      createdByChatId?: string;
      createdByRepoPath?: string;
    }> = [];

    for (const [tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.userId === userId) {
        userTunnels.push({
          id: tunnelId,
          url: tunnel.url,
          port: tunnel.port,
          name: tunnel.name,
          description: tunnel.description,
          main: tunnel.main,
          createdAt: tunnel.createdAt,
          active: tunnel.active ?? true,
          createdByChatId: tunnel.createdByChatId,
          createdByRepoPath: tunnel.createdByRepoPath,
        });
      }
    }

    return userTunnels;
  }

  /**
   * Destroy all tunnels for a user (cleanup on logout/session end)
   */
  async destroyUserTunnels(userId: string): Promise<void> {
    console.log(`[TunnelService] Destroying all tunnels for user ${userId}`);

    const tunnelIds: string[] = [];
    for (const [tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (tunnel.userId === userId) {
        tunnelIds.push(tunnelId);
      }
    }

    for (const tunnelId of tunnelIds) {
      await this.destroyTunnel(tunnelId);
    }

    console.log(`[TunnelService] ✓ Destroyed ${tunnelIds.length} tunnels for user ${userId}`);
  }

  /**
   * Get statistics about tunnels
   */
  getTunnelStats(): {
    activeTunnels: number;
    tunnelsByUser: Map<string, number>;
  } {
    const tunnelsByUser = new Map<string, number>();

    for (const tunnel of this.activeTunnels.values()) {
      const count = tunnelsByUser.get(tunnel.userId) || 0;
      tunnelsByUser.set(tunnel.userId, count + 1);
    }

    return {
      activeTunnels: this.activeTunnels.size,
      tunnelsByUser,
    };
  }

  // ========================================
  // Private Helper Methods
  // ========================================

  /**
   * Handle tunnel replacement: close existing tunnel with same name+repoPath on different port
   */
  private async handleTunnelReplacement(
    userId: string,
    name: string,
    repoPath: string,
    newPort: number
  ): Promise<void> {
    for (const [tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (
        tunnel.userId === userId &&
        tunnel.name === name &&
        tunnel.createdByRepoPath === repoPath &&
        tunnel.port !== newPort
      ) {
        console.log(
          `[TunnelService] Replacing existing tunnel "${name}" on project ${repoPath} (old port: ${tunnel.port}, new port: ${newPort})`
        );
        await this.destroyTunnel(tunnelId);
      }
    }
  }

  /**
   * Unset previous main tunnel for a repo when new main tunnel is created
   */
  private unsetPreviousMainTunnel(userId: string, repoPath: string): void {
    for (const [_tunnelId, tunnel] of this.activeTunnels.entries()) {
      if (
        tunnel.userId === userId &&
        tunnel.createdByRepoPath === repoPath &&
        tunnel.main === true
      ) {
        console.log(
          `[TunnelService] Unsetting previous main tunnel for repo ${repoPath}: port ${tunnel.port}`
        );
        tunnel.main = false;
      }
    }
  }

  /**
   * Rate limit check for tunnel creation
   */
  private async rateLimitCheck(userId: string): Promise<void> {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    let timestamps = this.userTunnelCount.get(userId) || [];
    timestamps = timestamps.filter((ts) => ts > oneHourAgo);
    this.userTunnelCount.set(userId, timestamps);

    if (timestamps.length >= this.MAX_TUNNELS_PER_HOUR) {
      const oldestTimestamp = Math.min(...timestamps);
      const waitTimeMs = oldestTimestamp + 60 * 60 * 1000 - now;
      const waitMinutes = Math.ceil(waitTimeMs / 60000);

      throw new Error(
        `Rate limit exceeded: You can create ${this.MAX_TUNNELS_PER_HOUR} tunnels per hour. ` +
          `Please wait ${waitMinutes} minutes before creating another tunnel.`
      );
    }
  }

  /**
   * Track tunnel creation for rate limiting
   */
  private trackTunnelCreation(userId: string): void {
    const timestamps = this.userTunnelCount.get(userId) || [];
    timestamps.push(Date.now());
    this.userTunnelCount.set(userId, timestamps);
  }
}
