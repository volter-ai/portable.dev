import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Spawn + supervise cloudflared.
 *
 * The launcher IS the local tunnel-router gateway and owns the cloudflared
 * lifecycle: it runs `cloudflared tunnel --url http://127.0.0.1:VGIT_PORT` (IPv4
 * loopback — NEVER `localhost`, whose `::1` resolution can 502 against the
 * IPv4-bound api on dual-stack/Windows hosts),
 * parses the rotating `*.trycloudflare.com` quick-tunnel URL from cloudflared's
 * (stderr) log output, and supervises the child — restarting it on crash and
 * handing the (possibly NEW) URL to the registration agent on first
 * capture AND on every rotation/restart.
 *
 * Everything is dependency-injectable (spawn / detect / sleep seams) so the full
 * lifecycle is testable with a fake child process — no real cloudflared binary,
 * no real network. The real-cloudflared run is the post-run live-smoke.
 */

type SpawnImpl = typeof spawn;
type SleepImpl = (ms: number) => Promise<void>;
type DetectImpl = () => Promise<boolean>;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Matches a Cloudflare quick-tunnel URL anywhere in a log line, e.g.
 *   2026-... INF |  https://random-three-words.trycloudflare.com  |
 * Hostnames are lowercase alphanumeric + hyphens.
 */
export const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/**
 * Extract the `*.trycloudflare.com` URL from a single cloudflared log line, or
 * `null` if the line doesn't contain one. Exported for unit testing (AC3).
 */
export function parseTrycloudflareUrl(line: string): string | null {
  const match = line.match(TRYCLOUDFLARE_URL_RE);
  return match ? match[0] : null;
}

/** User-facing instruction shown when the cloudflared binary is missing (AC2). */
export const CLOUDFLARED_INSTALL_HINT =
  'cloudflared not found on PATH. Install it to expose this PC:\n' +
  '  macOS:    brew install cloudflared\n' +
  '  Windows:  winget install --id Cloudflare.cloudflared\n' +
  '  Linux:    see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
  'Then re-run `portable start`.\n' +
  'On Windows the winget/MSI installer often does NOT add cloudflared to PATH; the\n' +
  'launcher probes the default install dirs automatically. If yours lives elsewhere,\n' +
  'set PORTABLE_CLOUDFLARED_BIN to the full path of cloudflared.exe.';

/**
 * Resolve the cloudflared executable to spawn (Windows support).
 *
 * The default `'cloudflared'` works when the binary is on PATH (the common case
 * on macOS/Linux via Homebrew / the package manager). On Windows, however, the
 * winget/MSI installer frequently does NOT add cloudflared to PATH, so a bare
 * `spawn('cloudflared')` fails with ENOENT even though the binary is installed.
 * To make `portable start` work out of the box there, we:
 *   1. honor an explicit `PORTABLE_CLOUDFLARED_BIN` override (any platform);
 *   2. on win32, probe the well-known install locations and return the full
 *      path (spawn with shell:false handles spaces in the path fine);
 *   3. otherwise fall back to the bare name so PATH resolution / the missing-
 *      binary install hint still apply.
 *
 * `existsImpl` / `platform` are injected seams so this is unit-testable without a
 * real filesystem or a real Windows host.
 */
export function resolveCloudflaredBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  existsImpl: (p: string) => boolean = fs.existsSync
): string {
  const override = env.PORTABLE_CLOUDFLARED_BIN?.trim();
  if (override) return override;

  if (platform !== 'win32') return 'cloudflared';

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
      if (existsImpl(candidate)) return candidate;
    } catch {
      // Ignore probe errors — fall through to the next candidate / bare name.
    }
  }
  // Not found in the known dirs: fall back to the bare name so PATH lookup (if
  // the user added it) still works and, failing that, the install hint fires.
  return 'cloudflared';
}

/**
 * Detect whether the cloudflared binary is available by running
 * `<bin> --version`. Resolves false on spawn error (ENOENT) or a non-zero exit.
 */
export function detectCloudflared(
  bin = 'cloudflared',
  spawnImpl: SpawnImpl = spawn
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawnImpl(bin, ['--version'], { stdio: 'ignore' });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

export interface CloudflaredTunnelOptions {
  /** The loopback URL cloudflared fronts (e.g. http://127.0.0.1:4200). */
  localUrl: string;
  /**
   * Called with the public URL on first capture AND on every rotation/restart.
   * This is the handoff to the registration agent.
   */
  onUrl?: (url: string) => void;
  /** child_process.spawn seam (injected in tests). */
  spawnImpl?: SpawnImpl;
  /** cloudflared presence-detection seam (injected in tests). */
  detectImpl?: DetectImpl;
  /** cloudflared executable. Defaults to 'cloudflared'. */
  bin?: string;
  /** Delay (ms) before respawning after a crash. Default 1000. */
  restartDelayMs?: number;
  /**
   * Max consecutive restart attempts before giving up. Default Infinity — the
   * tunnel is the PC's only ingress, so we keep trying.
   */
  maxRestarts?: number;
  /** Grace period (ms) between SIGTERM and SIGKILL on stop(). Default 8000. */
  killGraceMs?: number;
  /** sleep seam (injected in tests). */
  sleep?: SleepImpl;
  /** Line sink for tunnel output. Defaults to console.log. */
  log?: (line: string) => void;
}

export class CloudflaredTunnel {
  private readonly localUrl: string;
  private readonly onUrl?: (url: string) => void;
  private readonly spawnImpl: SpawnImpl;
  private readonly detectImpl: DetectImpl;
  private readonly bin: string;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly killGraceMs: number;
  private readonly sleep: SleepImpl;
  private readonly log: (line: string) => void;

  private child: ChildProcess | null = null;
  private publicUrl: string | null = null;
  private stopped = false;
  private restarts = 0;
  /** Resolvers waiting on the first captured URL. */
  private firstUrlWaiters: Array<(url: string) => void> = [];

  constructor(options: CloudflaredTunnelOptions) {
    this.localUrl = options.localUrl;
    this.onUrl = options.onUrl;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.detectImpl = options.detectImpl ?? (() => detectCloudflared(this.bin, this.spawnImpl));
    this.bin = options.bin ?? 'cloudflared';
    this.restartDelayMs = options.restartDelayMs ?? 1000;
    this.maxRestarts = options.maxRestarts ?? Infinity;
    this.killGraceMs = options.killGraceMs ?? 8000;
    this.sleep = options.sleep ?? realSleep;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The current public `*.trycloudflare.com` URL, or null before first capture. */
  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  isRunning(): boolean {
    return !!this.child && !this.stopped;
  }

  /**
   * Ensure cloudflared is installed and spawn it. Throws {@link CLOUDFLARED_INSTALL_HINT}
   * when the binary is missing. Returns once the child is spawned; the public URL
   * is delivered asynchronously via {@link onUrl} (use {@link waitForFirstUrl} to await it).
   */
  async start(): Promise<void> {
    if (this.child) return;
    this.stopped = false;

    const present = await this.detectImpl();
    if (!present) {
      throw new Error(CLOUDFLARED_INSTALL_HINT);
    }

    this.spawnChild();
  }

  /**
   * Resolve with the first public URL captured (or the current one if already
   * known). Rejects after `timeoutMs` (default 30s) so the launcher doesn't hang
   * forever if cloudflared never prints a URL.
   */
  waitForFirstUrl(timeoutMs = 30_000): Promise<string> {
    if (this.publicUrl) return Promise.resolve(this.publicUrl);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstUrlWaiters = this.firstUrlWaiters.filter((w) => w !== onUrl);
        reject(new Error(`[cloudflared] no tunnel URL after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const onUrl = (url: string) => {
        clearTimeout(timer);
        resolve(url);
      };
      this.firstUrlWaiters.push(onUrl);
    });
  }

  private spawnChild(): void {
    this.log(`[tunnel] starting cloudflared: ${this.bin} tunnel --url ${this.localUrl}`);
    const child = this.spawnImpl(this.bin, ['tunnel', '--no-autoupdate', '--url', this.localUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    // cloudflared logs the quick-tunnel URL to stderr; watch both to be safe.
    this.watch(child.stdout);
    this.watch(child.stderr);

    child.once('exit', (code) => this.handleExit(code));
    child.once('error', (err) => {
      this.log(`[tunnel] cloudflared error: ${err.message}`);
      this.handleExit(null);
    });
  }

  private handleExit(code: number | null): void {
    this.child = null;
    if (this.stopped) {
      this.log('[tunnel] cloudflared stopped');
      return;
    }
    this.log(`[tunnel] cloudflared exited (code ${code ?? 'null'}) — supervising`);
    if (this.restarts >= this.maxRestarts) {
      this.log(`[tunnel] giving up after ${this.restarts} restart attempts`);
      return;
    }
    this.restarts += 1;
    // Drop the stale URL: a restart yields a NEW quick-tunnel hostname.
    this.publicUrl = null;
    void this.sleep(this.restartDelayMs).then(() => {
      if (this.stopped) return;
      this.log(`[tunnel] restarting cloudflared (attempt ${this.restarts})`);
      this.spawnChild();
    });
  }

  /**
   * Force a tunnel rotation (self-heal). Kills the current cloudflared child so the
   * crash-supervisor respawns it — which yields a NEW `*.trycloudflare.com`
   * hostname and re-fires {@link onUrl} (→ the registration agent re-registers).
   *
   * Unlike {@link stop}, this does NOT set `stopped`, so {@link handleExit} treats
   * the death as a crash and respawns after `restartDelayMs`. No-op when stopped or
   * before the first spawn. Used by {@link TunnelHealthMonitor} when the PUBLIC relay
   * path is unreachable while the local api is healthy (a dead/stale gateway mapping
   * the local api + a direct-tunnel check would both miss).
   */
  cycle(): void {
    const child = this.child;
    if (this.stopped || !child) return;
    this.log('[tunnel] cycling cloudflared (self-heal: public ingress unreachable)');
    // Drop the stale URL now; handleExit() respawns (we are NOT stopped) → new host.
    this.publicUrl = null;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this.log(`[tunnel] cycle kill error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Stop supervising and terminate cloudflared (SIGTERM → SIGKILL after grace). */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (!done) {
          this.log('[tunnel] cloudflared did not exit in time — sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, this.killGraceMs);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    });
    this.child = null;
  }

  private watch(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.consumeLine(line);
      }
    });
    stream.on('end', () => {
      if (buffer.length) this.consumeLine(buffer);
    });
  }

  private consumeLine(line: string): void {
    const url = parseTrycloudflareUrl(line);
    if (url && url !== this.publicUrl) {
      this.publicUrl = url;
      this.restarts = 0; // healthy again — reset the restart counter
      this.log(`[tunnel] public URL: ${url}`);
      // Hand the URL to the registration agent + wake any waiters.
      try {
        this.onUrl?.(url);
      } catch (err) {
        this.log(
          `[tunnel] onUrl handler error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const waiters = this.firstUrlWaiters;
      this.firstUrlWaiters = [];
      for (const w of waiters) w(url);
    }
  }
}
