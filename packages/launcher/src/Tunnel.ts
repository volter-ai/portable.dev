import { type spawn } from 'child_process';

/**
 * Provider-agnostic tunnel abstraction.
 *
 * The launcher's public ingress is a supervised child process that opens a public
 * tunnel to the loopback api and prints a rotating public URL. `cloudflared` (the
 * default) and `ngrok` (opt-in, `--ngrok`) are two concrete providers; both expose
 * the SAME surface so the {@link TunnelRouter} + registration agent are written once
 * and work with either. Everything downstream of the URL (registration, the relay,
 * `TunnelHealthMonitor`, `PublicUrlVerifier`) is already provider-agnostic — only the
 * code that PRODUCES the URL differs per provider.
 *
 * See {@link CloudflaredTunnel} and {@link NgrokTunnel} for the concrete impls.
 */

type SpawnImpl = typeof spawn;
type SleepImpl = (ms: number) => Promise<void>;
type DetectImpl = () => Promise<boolean>;

/**
 * Construction options shared by every {@link Tunnel} provider. Identical for
 * cloudflared and ngrok — the only per-provider differences are the spawned binary,
 * its argv, and how the public URL is parsed out of its log stream (all internal).
 */
export interface TunnelOptions {
  /** The loopback URL the tunnel fronts (e.g. http://127.0.0.1:4200). */
  localUrl: string;
  /**
   * Called with the public URL on first capture AND on every rotation/restart.
   * This is the handoff to the registration agent.
   */
  onUrl?: (url: string) => void;
  /** child_process.spawn seam (injected in tests). */
  spawnImpl?: SpawnImpl;
  /** binary presence-detection seam (injected in tests). */
  detectImpl?: DetectImpl;
  /** the tunnel executable to spawn. */
  bin?: string;
  /** Delay (ms) before respawning after a crash. Default 1000. */
  restartDelayMs?: number;
  /** Max consecutive restart attempts before giving up. Default Infinity. */
  maxRestarts?: number;
  /** Grace period (ms) between SIGTERM and SIGKILL on stop(). Default 8000. */
  killGraceMs?: number;
  /** sleep seam (injected in tests). */
  sleep?: SleepImpl;
  /** Line sink for tunnel output. Defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * A NON-TRANSIENT tunnel failure: restarting the provider would just hit the same wall
 * (the agent was rejected — auth is bad, the reserved/free hostname is already claimed
 * by another live session, the account's simultaneous-session limit is hit, …). The
 * {@link TunnelRouter} re-throws this out of `start()` so the launcher ABORTS boot with
 * the provider's own error text, instead of silently crash-looping into the same error.
 *
 * A plain timeout waiting for the first URL is deliberately NOT this — that stays
 * fail-open (supervision keeps trying), the way a slow cloudflared quick tunnel does.
 */
export class TunnelFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelFatalError';
  }
}

/**
 * The lifecycle the {@link TunnelRouter} drives. Both {@link CloudflaredTunnel} and
 * {@link NgrokTunnel} implement it.
 */
export interface Tunnel {
  /** Ensure the binary is present and spawn it. Throws a provider-specific install/setup hint when missing. */
  start(): Promise<void>;
  /** Stop supervising and terminate the child (SIGTERM → SIGKILL after grace). */
  stop(): Promise<void>;
  /** Force a tunnel rotation (self-heal): kill the child WITHOUT setting stopped so the supervisor respawns → new URL. */
  cycle(): void;
  /** The current public URL, or null before first capture. */
  getPublicUrl(): string | null;
  /** Whether the tunnel is spawned and not stopped. */
  isRunning(): boolean;
  /** Resolve with the first captured public URL (or the current one). Rejects after `timeoutMs`. */
  waitForFirstUrl(timeoutMs?: number): Promise<string>;
}
