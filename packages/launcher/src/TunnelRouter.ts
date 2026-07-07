import { type spawn } from 'child_process';

import { CloudflaredTunnel, type CloudflaredTunnelOptions } from './CloudflaredTunnel.js';
import { TunnelFatalError, type Tunnel, type TunnelOptions } from './Tunnel.js';

/**
 * Tunnel-router (provider-agnostic, no-Clerk).
 *
 * The launcher IS the local tunnel-router gateway: it owns the tunnel
 * lifecycle and the registration agent that keeps the gateway pointed at the
 * PC's current tunnel URL. Registration is `pcId`-keyed with NO Clerk
 * identity — Clerk is gone from the PC entirely.
 *
 * `start()` spawns + supervises the tunnel via the injected {@link Tunnel} provider
 * ({@link CloudflaredTunnel} by default, {@link NgrokTunnel} when `--ngrok` — selected
 * by `createLauncher` via `makeTunnel` + `tunnelBin`), captures its rotating public URL,
 * and hands every URL (first capture AND each rotation/restart) to the registration-agent
 * seam ({@link TunnelRouterOptions.onTunnelUrl}, wired to {@link TunnelRegistrationAgent}).
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
  /** child_process.spawn seam, forwarded to the tunnel (injected in tests). */
  spawnImpl?: typeof spawn;
  /** tunnel presence-detection seam (injected in tests). */
  detectImpl?: () => Promise<boolean>;
  /**
   * The tunnel executable to spawn. Provider-agnostic (cloudflared or ngrok). Prefer
   * this over the deprecated {@link cloudflaredBin} alias.
   */
  tunnelBin?: string;
  /** @deprecated Use {@link tunnelBin}. Kept for back-compat (cloudflared path). */
  cloudflaredBin?: string;
  /** How long start() waits for the first URL before continuing (ms). Default 30000. */
  firstUrlTimeoutMs?: number;
  /**
   * Default for {@link TunnelRouter.waitForFirstRegistration}'s `timeoutMs` (ms).
   * Default 45000 (a fail-open ceiling — comfortably above the registration
   * agent's own ~30s verify budget). Lowered in tests to keep them fast.
   */
  firstRegistrationTimeoutMs?: number;
  /**
   * Factory for the tunnel supervisor (test seam / provider selector). Defaults to a
   * {@link CloudflaredTunnel}; `createLauncher` passes an {@link NgrokTunnel} factory
   * when `--ngrok` is active. Prefer this over the deprecated
   * {@link makeCloudflaredTunnel} alias.
   */
  makeTunnel?: (opts: TunnelOptions) => Tunnel;
  /** @deprecated Use {@link makeTunnel}. Kept for back-compat (cloudflared path). */
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
  private readonly tunnelBin?: string;
  private readonly firstUrlTimeoutMs: number;
  private readonly firstRegistrationTimeoutMs: number;
  private readonly makeTunnel: (opts: TunnelOptions) => Tunnel;
  private readonly log: (line: string) => void;

  private tunnel: Tunnel | null = null;
  private publicUrl: string | null = null;
  private started = false;
  /**
   * Settles once the FIRST tunnel-URL → registration handoff resolves (the
   * registration agent's verify + register, or "no agent wired"). See
   * {@link waitForFirstRegistration}.
   */
  private readonly firstRegistrationPromise: Promise<void>;
  private resolveFirstRegistration: () => void = () => {};

  constructor(options: TunnelRouterOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.onTunnelUrl = options.onTunnelUrl;
    this.onStop = options.onStop;
    this.spawnImpl = options.spawnImpl;
    this.detectImpl = options.detectImpl;
    this.tunnelBin = options.tunnelBin ?? options.cloudflaredBin;
    this.firstUrlTimeoutMs = options.firstUrlTimeoutMs ?? 30_000;
    this.firstRegistrationTimeoutMs = options.firstRegistrationTimeoutMs ?? 45_000;
    this.makeTunnel =
      options.makeTunnel ??
      options.makeCloudflaredTunnel ??
      ((opts) => new CloudflaredTunnel(opts));
    this.log = options.log ?? ((line) => console.log(line));
    this.firstRegistrationPromise = new Promise((resolve) => {
      this.resolveFirstRegistration = resolve;
    });
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

    this.tunnel = this.makeTunnel({
      localUrl: this.apiBaseUrl,
      onUrl: (url) => this.handleUrl(url),
      spawnImpl: this.spawnImpl,
      detectImpl: this.detectImpl,
      bin: this.tunnelBin,
      log: this.log,
    });

    await this.tunnel.start();

    try {
      const url = await this.tunnel.waitForFirstUrl(this.firstUrlTimeoutMs);
      this.log(`[tunnel] ✓ public ingress ready: ${url}`);
    } catch (err) {
      if (err instanceof TunnelFatalError) {
        // Non-transient provider failure (e.g. ngrok's reserved domain is already
        // online, auth rejected, session limit): supervising a doomed retry loop is
        // pointless. Tear down and re-throw so the launcher aborts boot with the
        // provider's own message instead of a silent crash-loop.
        await this.tunnel.stop().catch(() => {});
        this.tunnel = null;
        throw err;
      }
      this.log(
        `[tunnel] still waiting for tunnel URL (${
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
      void Promise.resolve(this.onTunnelUrl(url))
        .catch((err) =>
          this.log(
            `[tunnel] registration handoff error: ${err instanceof Error ? err.message : String(err)}`
          )
        )
        .finally(() => this.resolveFirstRegistration());
    } else {
      this.log(`[tunnel] no registration agent wired — would register ${url}`);
      this.resolveFirstRegistration();
    }
  }

  /**
   * Wait for the FIRST tunnel-URL → registration handoff to settle (the
   * registration agent's DNS verify + `/tunnel/register` POST, or "no agent
   * wired"). Lets the launcher avoid showing a scannable QR before the gateway
   * can actually route to this PC — scanning early hits a PC the relay doesn't
   * know about yet (the `*.trycloudflare.com` DNS-propagation window; see
   * {@link TunnelRegistrationAgent}'s class doc).
   *
   * Bounded by `timeoutMs` (default {@link TunnelRouterOptions.firstRegistrationTimeoutMs},
   * itself defaulting to 45s — comfortably above the registration agent's own
   * ~30s verify budget) and **fail-open**, like {@link verifyPublicUrl}: a stuck
   * registration (e.g. an unreachable relay) must not hang boot forever, since
   * {@link TunnelHealthMonitor} can still recover it once the QR is up. Returns
   * `true` if the handoff settled before the timeout, `false` if the wait gave
   * up first.
   */
  async waitForFirstRegistration(
    timeoutMs: number = this.firstRegistrationTimeoutMs
  ): Promise<boolean> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    await Promise.race([this.firstRegistrationPromise, timeout]);
    if (timer) clearTimeout(timer);
    return !timedOut;
  }
}
