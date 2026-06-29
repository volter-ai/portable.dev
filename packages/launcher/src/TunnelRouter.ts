import { type spawn } from 'child_process';

import { CloudflaredTunnel, type CloudflaredTunnelOptions } from './CloudflaredTunnel.js';

/**
 * Tunnel-router (cloudflared, no-Clerk).
 *
 * The launcher IS the local tunnel-router gateway: it owns the cloudflared
 * lifecycle and the registration agent that keeps the gateway pointed at the
 * PC's current tunnel URL. Registration is `pcId`-keyed with NO Clerk
 * identity — Clerk is gone from the PC entirely.
 *
 * `start()` spawns + supervises cloudflared (via {@link CloudflaredTunnel}),
 * captures the rotating `*.trycloudflare.com` URL, and hands every URL (first
 * capture AND each rotation/restart) to the registration-agent seam
 * ({@link TunnelRouterOptions.onTunnelUrl}, wired to {@link TunnelRegistrationAgent}).
 */

export interface TunnelRouterOptions {
  /** Loopback base URL of the local api the tunnel will front. */
  apiBaseUrl: string;
  /**
   * Registration-agent handoff: called with the public URL on first
   * capture AND on every rotation/restart. Defaults to a deferral log so the
   * launcher works end-to-end before the agent exists.
   */
  onTunnelUrl?: (url: string) => void | Promise<void>;
  /**
   * Registration-agent teardown: called from {@link TunnelRouter.stop}
   * AFTER cloudflared is stopped, so the agent can cancel its heartbeat timers.
   */
  onStop?: () => void | Promise<void>;
  /** child_process.spawn seam, forwarded to cloudflared (injected in tests). */
  spawnImpl?: typeof spawn;
  /** cloudflared presence-detection seam (injected in tests). */
  detectImpl?: () => Promise<boolean>;
  /** cloudflared executable. Defaults to 'cloudflared'. */
  cloudflaredBin?: string;
  /** How long start() waits for the first URL before continuing (ms). Default 30000. */
  firstUrlTimeoutMs?: number;
  /** Factory for the cloudflared supervisor (test seam). Defaults to the real impl. */
  makeCloudflaredTunnel?: (opts: CloudflaredTunnelOptions) => CloudflaredTunnel;
  /** Line sink for tunnel-router output. Defaults to console.log. */
  log?: (line: string) => void;
}

export class TunnelRouter {
  private readonly apiBaseUrl: string;
  private readonly onTunnelUrl?: (url: string) => void | Promise<void>;
  private readonly onStop?: () => void | Promise<void>;
  private readonly spawnImpl?: typeof spawn;
  private readonly detectImpl?: () => Promise<boolean>;
  private readonly cloudflaredBin?: string;
  private readonly firstUrlTimeoutMs: number;
  private readonly makeCloudflaredTunnel: (opts: CloudflaredTunnelOptions) => CloudflaredTunnel;
  private readonly log: (line: string) => void;

  private tunnel: CloudflaredTunnel | null = null;
  private publicUrl: string | null = null;
  private started = false;

  constructor(options: TunnelRouterOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.onTunnelUrl = options.onTunnelUrl;
    this.onStop = options.onStop;
    this.spawnImpl = options.spawnImpl;
    this.detectImpl = options.detectImpl;
    this.cloudflaredBin = options.cloudflaredBin;
    this.firstUrlTimeoutMs = options.firstUrlTimeoutMs ?? 30_000;
    this.makeCloudflaredTunnel =
      options.makeCloudflaredTunnel ?? ((opts) => new CloudflaredTunnel(opts));
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The current public `*.trycloudflare.com` URL, or null before first capture. */
  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Bring up the public ingress for this PC: spawn + supervise cloudflared and
   * route its rotating URL to the registration agent. Throws the install hint
   * (surfaced by the launcher) when cloudflared is missing. Waits up to
   * `firstUrlTimeoutMs` for the first URL — a timeout is logged, NOT fatal:
   * supervision keeps running and the URL is handed off once it appears.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.tunnel = this.makeCloudflaredTunnel({
      localUrl: this.apiBaseUrl,
      onUrl: (url) => this.handleUrl(url),
      spawnImpl: this.spawnImpl,
      detectImpl: this.detectImpl,
      bin: this.cloudflaredBin,
      log: this.log,
    });

    await this.tunnel.start();

    try {
      const url = await this.tunnel.waitForFirstUrl(this.firstUrlTimeoutMs);
      this.log(`[tunnel] ✓ public ingress ready: ${url}`);
    } catch (err) {
      this.log(
        `[tunnel] still waiting for cloudflared URL (${
          err instanceof Error ? err.message : String(err)
        }); supervision continues`
      );
    }
  }

  /**
   * Force a tunnel rotation (self-heal seam for {@link TunnelHealthMonitor}).
   * Delegates to the cloudflared supervisor's {@link CloudflaredTunnel.cycle}: the
   * current child is killed, the supervisor respawns it with a NEW hostname, and the
   * fresh URL flows back through `handleUrl` → the registration agent re-registers.
   * A no-op before {@link start} / after {@link stop}.
   */
  cycle(): void {
    if (!this.started) return;
    this.tunnel?.cycle();
  }

  /** Tear down cloudflared + the registration agent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.tunnel?.stop();
    this.tunnel = null;
    if (this.onStop) {
      try {
        await this.onStop();
      } catch (err) {
        this.log(
          `[tunnel] registration-agent stop error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    this.log('[tunnel] stopped');
  }

  /** Record the current URL and hand it to the registration agent. */
  private handleUrl(url: string): void {
    this.publicUrl = url;
    if (this.onTunnelUrl) {
      void Promise.resolve(this.onTunnelUrl(url)).catch((err) =>
        this.log(
          `[tunnel] registration handoff error: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    } else {
      this.log(`[tunnel] no registration agent wired — would register ${url}`);
    }
  }
}
