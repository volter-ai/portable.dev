/**
 * MockTunnelService
 *
 * Mock implementation of TunnelService for testing.
 * Provides in-memory tunnel tracking without actual tunnel management.
 */

interface Tunnel {
  id: string;
  port: number;
  url: string;
  userId: string;
  createdByRepoPath: string;
  createdAt: number;
}

export class MockTunnelService {
  private tunnels: Tunnel[] = [];
  private activePorts: Set<number> = new Set();
  private tunnelIdCounter: number = 1;

  /**
   * Create a dynamic tunnel (mock implementation)
   * Returns a mock tunnel URL
   */
  async createDynamicTunnel(userId: string, port: number, type: string): Promise<string> {
    const tunnelId = `tunnel-${this.tunnelIdCounter++}`;
    const tunnelUrl = `https://mock-tunnel-${tunnelId}.example.com`;

    const tunnel: Tunnel = {
      id: tunnelId,
      port,
      url: tunnelUrl,
      userId,
      createdByRepoPath: type,
      createdAt: Date.now(),
    };

    this.tunnels.push(tunnel);
    this.activePorts.add(port);

    return tunnelUrl;
  }

  /**
   * Destroy a tunnel by ID
   */
  async destroyTunnel(tunnelId: string): Promise<void> {
    const tunnelIndex = this.tunnels.findIndex((t) => t.id === tunnelId);
    if (tunnelIndex !== -1) {
      const tunnel = this.tunnels[tunnelIndex];
      this.activePorts.delete(tunnel.port);
      this.tunnels.splice(tunnelIndex, 1);
    }
  }

  /**
   * Add a tunnel (for manual testing)
   */
  addTunnel(tunnel: Tunnel): void {
    this.tunnels.push(tunnel);
  }

  /**
   * Mark a port as active (listening)
   */
  setPortActive(port: number, active: boolean): void {
    if (active) {
      this.activePorts.add(port);
    } else {
      this.activePorts.delete(port);
    }
  }

  /**
   * Check if a port is active (for testing)
   */
  async isPortActive(port: number): Promise<boolean> {
    return this.activePorts.has(port);
  }

  /**
   * Get all tunnels for a user
   */
  getUserTunnels(userId: string): Tunnel[] {
    return this.tunnels.filter((t) => t.userId === userId);
  }

  /**
   * Get tunnels for a specific repo
   */
  getTunnelsForRepo(userId: string, repoPath: string): Tunnel[] {
    return this.tunnels.filter((t) => t.userId === userId && t.createdByRepoPath === repoPath);
  }

  /**
   * Get tunnel mappings (port to URL mapping)
   * Returns array of {port, url} for all active tunnels
   */
  getTunnelMappings(userId?: string): Array<{ port: number; url: string }> {
    const tunnels: Array<{ port: number; url: string }> = [];

    this.tunnels.forEach((tunnel) => {
      // Filter by userId if provided, otherwise return all tunnels
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
   * Clear all tunnels (for testing)
   */
  reset(): void {
    this.tunnels = [];
    this.activePorts.clear();
  }
}
