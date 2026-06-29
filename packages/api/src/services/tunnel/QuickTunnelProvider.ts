/**
 * QuickTunnelProvider - Provider for Cloudflare Quick Tunnels
 *
 * The on-demand dev-server tunnel provider (the stable named-tunnel path was
 * removed — Quick Tunnels are the only provider).
 *
 * Characteristics:
 * - Dynamic URLs (trycloudflare.com)
 * - Per-tunnel cloudflared process
 * - Any port supported (no restrictions)
 * - Spawned on demand
 */

import { spawn, ChildProcess, exec } from 'child_process';
import fsSync from 'fs';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

import { debugLog } from '@vgit2/shared/constants';

import type {
  IQuickTunnelProvider,
  CreateTunnelOptions,
  CreateTunnelResult,
  TunnelMetadata,
} from './types.js';

// Lazy execAsync - created on first use to allow mocking in tests
const getExecAsync = () => promisify(exec);

/**
 * Resolve the `cloudflared` executable cross-platform. Mirrors the launcher's
 * `resolveCloudflaredBin` (the api can't import from @vgit2/launcher): honor
 * `PORTABLE_CLOUDFLARED_BIN`, then on Windows probe the standard install dirs
 * (winget/MSI rarely add cloudflared to PATH, so a bare `spawn('cloudflared')`
 * ENOENTs), else the bare name for PATH resolution on macOS/Linux.
 */
function resolveCloudflaredBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PORTABLE_CLOUDFLARED_BIN?.trim();
  if (override) return override;
  if (process.platform !== 'win32') return 'cloudflared';
  const candidates = [
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(
      env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'cloudflared',
      'cloudflared.exe'
    ),
    env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
      : '',
    env.USERPROFILE ? path.join(env.USERPROFILE, 'scoop', 'shims', 'cloudflared.exe') : '',
  ].filter((c): c is string => c.length > 0);
  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // ignore and keep probing
    }
  }
  return 'cloudflared';
}

/**
 * Clear, actionable message when the `cloudflared` binary is not on PATH. Quick Tunnels
 * are the ONLY tunnel provider in the local-first runtime (the old pre-configured path was removed),
 * so a missing binary means no dev-server preview tunnels. Mirrors the
 * launcher's install hint (kept local — the api must not import from @vgit2/launcher).
 */
const CLOUDFLARED_INSTALL_HINT =
  'cloudflared not found on PATH — dev-server preview tunnels are unavailable. Install it:\n' +
  '  macOS:  brew install cloudflared\n' +
  '  Linux:  see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

export class QuickTunnelProvider implements IQuickTunnelProvider {
  readonly mode = 'quick' as const;

  // Track active tunnel processes for cleanup
  private activeProcesses: Map<string, ChildProcess> = new Map();

  /**
   * Notified when a tunnel's `cloudflared` child EXITS for any reason (crash,
   * killed, network give-up). Lets the owner (TunnelService) evict the now-dead
   * tunnel from its registry and re-broadcast — so a flapped/crashed tunnel
   * disappears from the client instead of lingering as a dead `*.trycloudflare.com`.
   * Set via {@link setTunnelExitCallback}.
   */
  private onTunnelExit?: (tunnelId: string) => void;

  constructor() {
    debugLog('[QuickTunnelProvider] Initialized');
    // Clean up any orphaned cloudflared processes from previous runs
    this.cleanupOrphanedProcesses();
  }

  /**
   * Register a callback fired when ANY tunnel's cloudflared child exits. Idempotent
   * for the owner: the callback must tolerate being called for an already-removed
   * tunnel (intentional destroy / shutdown also trigger the child's `exit`).
   */
  setTunnelExitCallback(cb: (tunnelId: string) => void): void {
    this.onTunnelExit = cb;
  }

  /**
   * Quick tunnels support any port
   */
  isPortSupported(port: number): boolean {
    return port > 0 && port <= 65535;
  }

  /**
   * Quick tunnels don't have a fixed list of supported ports
   */
  getSupportedPorts(): undefined {
    return undefined;
  }

  /**
   * Get the tunnel URL for a port
   * For quick tunnels, this requires creating the tunnel first
   */
  async getTunnelUrl(port: number): Promise<string> {
    throw new Error(
      'QuickTunnelProvider.getTunnelUrl() is not supported. ' +
        'Use createTunnel() instead to get a dynamic URL.'
    );
  }

  /**
   * Create a quick tunnel for a port
   * Spawns a new cloudflared process and waits for the URL
   */
  async createTunnel(options: CreateTunnelOptions): Promise<CreateTunnelResult> {
    const { port, userId, chatId, repoPath, name, description, main } = options;

    console.log(`[QuickTunnelProvider] Creating Quick Tunnel for port ${port}...`);

    // Validate that port is actually listening
    const isListening = await this.isPortActive(port);
    if (!isListening) {
      throw new Error(
        `Cannot create tunnel: Port ${port} is not listening. ` +
          `Please start your server on port ${port} first, then create the tunnel.`
      );
    }

    // Generate unique tunnel ID
    const tunnelId = `quick-${userId}-${port}-${Date.now()}`;

    // Spawn cloudflared Quick Tunnel (Windows-aware bin resolution — winget/MSI
    // often don't add cloudflared to PATH, so a bare 'cloudflared' would ENOENT).
    // ⚠️ Origin is `127.0.0.1`, NOT `localhost`: on Windows/dual-stack hosts
    // `localhost` resolves to BOTH `::1` (IPv6) and `127.0.0.1` (IPv4), and
    // cloudflared (Go) commonly dials `[::1]:port` first. Most dev servers
    // (Vite/Next/CRA) bind IPv4-only, so a `localhost` origin yields
    // `dial tcp [::1]:port: connect: connection refused` → a 502 Bad Gateway the
    // phone sees as a broken preview — even though `isPortActive` (which probes
    // `127.0.0.1`) reported the server up. Pinning IPv4 matches the liveness probe
    // and removes the dual-stack ambiguity.
    const tunnelProcess = spawn(resolveCloudflaredBin(), [
      'tunnel',
      '--no-autoupdate',
      '--url',
      `http://127.0.0.1:${port}`,
    ]);

    // Track the process for cleanup
    this.activeProcesses.set(tunnelId, tunnelProcess);

    // Parse public URL from stderr output. A missing `cloudflared` binary surfaces here as
    // a spawn ENOENT — translate it into a clear install hint instead of a cryptic error.
    let url: string;
    try {
      url = await this.parsePublicUrl(tunnelProcess);
    } catch (error) {
      this.activeProcesses.delete(tunnelId);
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new Error(CLOUDFLARED_INSTALL_HINT);
      }
      throw error;
    }

    console.log(`[QuickTunnelProvider] ✓ Quick Tunnel created: ${url} (port ${port})`);

    // Set up error monitoring
    this.monitorTunnelProcess(tunnelProcess, tunnelId, port);

    const metadata: TunnelMetadata = {
      userId,
      createdByChatId: chatId,
      createdByRepoPath: repoPath,
      name,
      description,
      main,
      port,
      url,
      process: tunnelProcess,
      createdAt: Date.now(),
      isExternal: false,
    };

    return { url, tunnelId, metadata };
  }

  /**
   * Parse the public URL from cloudflared's output
   */
  private parsePublicUrl(process: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for cloudflared tunnel URL'));
      }, 30000);

      const handleOutput = (data: Buffer) => {
        const output = data.toString();

        // Look for the public URL pattern
        // Format: "INF |  https://xxx-yyy.trycloudflare.com"
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (urlMatch) {
          clearTimeout(timeout);
          resolve(urlMatch[0]);
        }
      };

      process.stderr?.on('data', handleOutput);
      process.stdout?.on('data', handleOutput);

      process.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Monitor tunnel process for errors and unexpected exits
   */
  private monitorTunnelProcess(process: ChildProcess, tunnelId: string, port: number): void {
    process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      // Only log actual errors (not info messages that go to stderr)
      if (output.toLowerCase().includes('error') && !output.includes('INF')) {
        console.error(`[QuickTunnelProvider] Tunnel error (port ${port}): ${output.trim()}`);
      }
    });

    process.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(
          `[QuickTunnelProvider] Tunnel process exited unexpectedly (port ${port}, code ${code})`
        );
      }
      this.activeProcesses.delete(tunnelId);
      // Notify the owner so it can evict the dead tunnel + re-broadcast. Fires for
      // intentional kills too; the handler no-ops when the tunnel is already gone.
      this.onTunnelExit?.(tunnelId);
    });
  }

  /**
   * Check if a port is actively listening
   */
  async isPortActive(port: number): Promise<boolean> {
    // Windows has no `lsof`. Use a cross-platform TCP-connect probe there: if
    // something accepts a connection on the port, a server is listening.
    if (process.platform === 'win32') {
      return await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const finish = (active: boolean) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(active);
        };
        socket.setTimeout(1000);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, '127.0.0.1');
      });
    }
    // POSIX keeps the original `lsof` check (behaviour unchanged; tests mock it).
    try {
      const execAsync = getExecAsync();
      const { stdout } = await execAsync(`lsof -i :${port} -sTCP:LISTEN || true`);
      const lines = stdout.trim().split('\n');
      const processLines = lines.filter(
        (line) => !line.startsWith('COMMAND') && line.trim().length > 0
      );
      return processLines.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Destroy a tunnel by killing its process
   */
  async destroyTunnel(tunnelId: string, metadata: TunnelMetadata): Promise<void> {
    const process = this.activeProcesses.get(tunnelId);
    if (process && !process.killed) {
      console.log(`[QuickTunnelProvider] Destroying tunnel for port ${metadata.port}...`);
      process.kill();
      this.activeProcesses.delete(tunnelId);
    }
  }

  /**
   * Check if provider is ready (always ready for quick tunnels)
   */
  isReady(): boolean {
    return true;
  }

  /**
   * Clean up orphaned cloudflared processes from previous runs
   */
  private async cleanupOrphanedProcesses(): Promise<void> {
    try {
      console.log('[QuickTunnelProvider] Checking for orphaned cloudflared processes...');

      const execAsync = getExecAsync();
      // Cross-platform process listing: `tasklist` on Windows, `ps` on POSIX.
      // (This is awareness-only — it logs a count and never kills anything.)
      const isWindows = process.platform === 'win32';
      const listCmd = isWindows
        ? 'tasklist /FI "IMAGENAME eq cloudflared.exe" /NH'
        : 'ps aux | grep "cloudflared tunnel" | grep -v grep || true';
      const { stdout } = await execAsync(listCmd);
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && /cloudflared/i.test(line));

      if (lines.length > 0) {
        console.log(`[QuickTunnelProvider] Found ${lines.length} cloudflared process(es)`);
        // Note: We don't kill them automatically as they might be from other services
        // Just log for awareness
      } else {
        console.log('[QuickTunnelProvider] No orphaned cloudflared processes found');
      }
    } catch (error) {
      // Ignore errors - this is just cleanup
      debugLog(`[QuickTunnelProvider] Error checking for orphaned processes: ${error}`);
    }
  }

  /**
   * Shutdown the provider - kill all active tunnel processes
   */
  async shutdown(): Promise<void> {
    console.log(`[QuickTunnelProvider] Shutting down ${this.activeProcesses.size} tunnel(s)...`);

    for (const [tunnelId, process] of this.activeProcesses.entries()) {
      if (!process.killed) {
        process.kill();
        console.log(`[QuickTunnelProvider] Killed tunnel: ${tunnelId}`);
      }
    }

    this.activeProcesses.clear();
    console.log('[QuickTunnelProvider] ✓ Shutdown complete');
  }
}
