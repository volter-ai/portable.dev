import { WebSocket } from 'ws';

import type { TunnelService } from './TunnelService.js';
import type { ClaudeSession } from '../types/index.js';

/**
 * DevServerMonitorService handles dev server port detection and tunnel creation:
 * - Detects dev server ports from Bash output (Vite, React, Next.js, etc.)
 * - Creates Cloudflare Quick Tunnels so the mobile in-chat runtime preview bubble can
 *   reach the dev server (the phone can't reach the PC's localhost)
 * - Manages active tunnel cache
 */
export class DevServerMonitorService {
  private activeTunnels: Map<string, { port: number; url: string }> = new Map();

  constructor(
    private tunnelService?: TunnelService,
    private claudeCodeSessions?: Map<string, ClaudeSession>
  ) {}

  /**
   * Return ports of all currently-detected dev servers (used by MemoryWatchdog).
   */
  getActivePorts(): number[] {
    return Array.from(new Set(Array.from(this.activeTunnels.values()).map((t) => t.port)));
  }

  /**
   * Forget a port after the process holding it is killed. Tunnel cleanup is best-effort.
   */
  forgetPort(port: number): void {
    for (const [id, t] of this.activeTunnels) {
      if (t.port === port) this.activeTunnels.delete(id);
    }
  }

  /**
   * Detect dev server port from command output (simplified)
   * Uses universal pattern :PORT that works with all frameworks
   * Examples: ":5173/", ":3000", ":65534 ", ":8000\n"
   */
  detectDevServerPort(output: string): number | null {
    console.log(`[PortDetect] Searching for ports in ${output.length} chars of output`);

    // Strip ANSI color codes that break pattern matching
    // ANSI codes like \u001b[36m appear between localhost: and port number
    // eslint-disable-next-line no-control-regex
    const cleanOutput = output.replace(/\u001b\[[0-9;]*m/g, '');
    console.log(`[PortDetect] Cleaned output (removed ANSI): ${cleanOutput.length} chars`);

    // Match any :PORT pattern (followed by slash, space, newline, or end of string)
    const portRegex = /:(\d+)(?:[/\s\n]|$)/g;
    const matches = Array.from(cleanOutput.matchAll(portRegex));

    console.log(`[PortDetect] Found ${matches.length} potential port matches`);

    for (const match of matches) {
      const port = parseInt(match[1]);
      console.log(`[PortDetect] Checking port ${port} (valid range: 1024-65535)`);

      // Validate port range (1024-65535 for user ports)
      // Ignore system ports (< 1024) like :22/, :80/, :443/
      if (port >= 1024 && port <= 65535) {
        console.log(`[PortDetect] ✓ Valid dev server port detected: ${port}`);
        return port;
      } else {
        console.log(`[PortDetect] ✗ Port ${port} out of range, skipping`);
      }
    }

    console.log(`[PortDetect] No valid ports found in output`);
    return null;
  }

  /**
   * Create a Cloudflare Quick Tunnel for the detected port if one doesn't exist.
   * Returns the tunnel URL if created or already exists (any port supported).
   */
  async createTunnelForPort(
    port: number,
    userId: string,
    chatId?: string,
    repoPath?: string
  ): Promise<string | null> {
    // Check if tunnel already exists for this port
    const existingTunnel = Array.from(this.activeTunnels.values()).find((t) => t.port === port);
    if (existingTunnel) {
      console.log(
        `[DevServerMonitor] [${userId}] Tunnel already exists for port ${port}: ${existingTunnel.url}`
      );
      return existingTunnel.url;
    }

    // Create new tunnel
    if (!this.tunnelService) {
      console.warn(
        `[DevServerMonitor] [${userId}] TunnelService not available, cannot create tunnel for port ${port}`
      );
      return null;
    }

    try {
      console.log(`[DevServerMonitor] [${userId}] Creating tunnel for port ${port}...`);
      const tunnelUrl = await this.tunnelService.createLocalTunnel(
        port,
        userId,
        chatId,
        repoPath,
        'app',
        undefined, // description
        true // main - auto-detected tunnels are main by default
      );

      // Store in activeTunnels map
      const tunnelId = `tunnel-${userId}-${port}`;
      this.activeTunnels.set(tunnelId, { port, url: tunnelUrl });

      console.log(`[DevServerMonitor] [${userId}] ✓ Tunnel created: ${tunnelUrl} (port ${port})`);
      return tunnelUrl;
    } catch (error) {
      console.error(
        `[DevServerMonitor] [${userId}] Failed to create tunnel for port ${port}:`,
        error
      );
      return null;
    }
  }

  /**
   * Monitor Bash tool result output for dev server ports
   * When detected, create Quick Tunnel and notify Claude via WebSocket
   * Supports both string (Bash XML) and array (other tools) formats
   */
  async monitorBashOutputForPorts(
    toolResult: any,
    userId: string,
    chatId: string,
    ws: WebSocket
  ): Promise<void> {
    console.log(`[PortMonitor] [${userId}] Checking tool output for dev server ports...`);

    if (!toolResult.content) {
      console.log(`[PortMonitor] [${userId}] No content in tool result`);
      return;
    }

    let outputText = '';

    // Handle both string (Bash) and array (other tools) formats
    if (typeof toolResult.content === 'string') {
      // Bash returns XML string: <stdout>...</stdout>
      outputText = toolResult.content;

      // Extract stdout from XML if present
      const stdoutMatch = outputText.match(/<stdout>([\s\S]*?)<\/stdout>/);
      if (stdoutMatch) {
        outputText = stdoutMatch[1];
        console.log(`[PortMonitor] [${userId}] Extracted ${outputText.length} chars from <stdout>`);
      }
    } else if (Array.isArray(toolResult.content)) {
      // Other tools return array of content blocks
      for (const block of toolResult.content) {
        if (block.type === 'text' && block.text) {
          outputText += block.text;
        }
      }
      if (outputText) {
        console.log(
          `[PortMonitor] [${userId}] Extracted ${outputText.length} chars from content blocks`
        );
      }
    }

    if (!outputText) {
      console.log(`[PortMonitor] [${userId}] No output text to analyze`);
      return;
    }

    // Try to detect port using simplified pattern
    console.log(`[PortMonitor] [${userId}] Running port detection regex...`);
    const port = this.detectDevServerPort(outputText);
    if (port) {
      console.log(`[PortMonitor] [${userId}] ✓ Detected dev server on port ${port}`);

      // Always create a Cloudflare Quick Tunnel for the detected port. In the local-first
      // runtime the phone cannot reach the PC's localhost, so the mobile in-chat runtime
      // preview bubble needs a public *.trycloudflare.com URL for the dev server. If
      // cloudflared is missing, createTunnelForPort logs and returns null, degrading
      // gracefully instead of crashing.
      console.log(`[PortMonitor] [${userId}] Creating tunnel for port ${port}...`);

      // Get session to access repo path
      const session = this.claudeCodeSessions?.get(chatId);
      const repoPath = session?.repo_path;

      // Create tunnel for detected port
      const tunnelUrl = await this.createTunnelForPort(port, userId, chatId, repoPath);
      if (tunnelUrl) {
        // Send notification to the client via WebSocket (drives the mobile preview bubble)
        const notification = {
          type: 'tunnel_created',
          chat_id: chatId,
          port,
          url: tunnelUrl,
          message: `✓ Quick Tunnel created: ${tunnelUrl} (port ${port})`,
        };

        ws.send(JSON.stringify(notification));
        console.log(`[DevServerMonitor] [${userId}] ✓ Auto-created tunnel: ${tunnelUrl}`);
      }
    }
  }
}
