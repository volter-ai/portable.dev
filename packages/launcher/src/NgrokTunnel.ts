import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { TunnelFatalError, type Tunnel, type TunnelOptions } from './Tunnel.js';

/**
 * Spawn + supervise ngrok — the opt-in alternative to {@link CloudflaredTunnel}
 * (selected by `portable --ngrok`).
 *
 * It runs `ngrok http <localUrl> --log stdout --log-format json` (IPv4 loopback —
 * NEVER `localhost`, whose `::1` resolution can 502 against the IPv4-bound api on
 * dual-stack/Windows hosts), parses the public `https://…ngrok…` URL out of ngrok's
 * structured (JSON) log stream, and supervises the child — restarting it on crash
 * and handing the (possibly NEW) URL to the registration agent on first capture AND
 * on every rotation/restart. This mirrors the cloudflared supervisor exactly so the
 * {@link TunnelRouter} + registration agent are provider-agnostic.
 *
 * Unlike cloudflared quick tunnels (anonymous), ngrok requires an authenticated
 * agent (an authtoken via `ngrok config add-authtoken` or `NGROK_AUTHTOKEN`). That
 * precondition is enforced BEFORE the tunnel is constructed by
 * `ensureNgrok` (NgrokProvisioner) — a hard-fail, no fallback to cloudflared. So by
 * the time `start()` runs, the binary is present and authenticated.
 *
 * Everything is dependency-injectable (spawn / detect / sleep seams) so the full
 * lifecycle is testable with a fake child process — no real ngrok binary, no
 * real network.
 */

type SpawnImpl = typeof spawn;
type SleepImpl = (ms: number) => Promise<void>;
type DetectImpl = () => Promise<boolean>;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Host suffixes ngrok serves quick/free tunnels under (reserved custom domains excluded). */
const NGROK_HOST_SUFFIXES = [
  '.ngrok-free.app',
  '.ngrok.app',
  '.ngrok-free.dev',
  '.ngrok.dev',
  '.ngrok.io',
];

/**
 * Matches an ngrok public URL anywhere in a log line, e.g.
 *   https://abc-123-def.ngrok-free.app
 * Covers ngrok-free.app / ngrok.app / ngrok-free.dev / ngrok.dev / ngrok.io.
 * A reserved CUSTOM domain won't match here — it is still captured via ngrok's own
 * JSON `url` field ({@link parseNgrokUrl}).
 */
export const NGROK_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.ngrok(?:-free)?\.(?:app|dev|io)/i;

/** `true` iff `url`'s host is one of ngrok's known tunnel-host suffixes. */
function isNgrokHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return NGROK_HOST_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

/**
 * Extract the public ngrok URL from a single ngrok log line, or `null` if the line
 * doesn't contain one. Prefers ngrok's structured JSON (`--log-format json`): a
 * `"started tunnel"` line carries the `url` field (which also works for a reserved
 * custom domain). Falls back to a permissive regex for non-JSON lines. Exported for
 * unit testing.
 */
export function parseNgrokUrl(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const url = typeof obj.url === 'string' ? obj.url.trim() : '';
      const msg = typeof obj.msg === 'string' ? obj.msg.toLowerCase() : '';
      // A "started tunnel" line's url is authoritative (covers custom domains too);
      // otherwise only trust a url whose host is a known ngrok host.
      if (url.startsWith('https://') && (msg.includes('started tunnel') || isNgrokHost(url))) {
        return url;
      }
      // Valid JSON with no qualifying `url` field: do NOT regex-scan the raw line. An
      // error line (e.g. ERR_NGROK_334 "The endpoint 'https://x.ngrok-free.dev' is
      // already online") MENTIONS a URL in its `err` text — regex-scanning it would
      // mis-capture that as a live tunnel and skip the fatal-error handling entirely.
      return null;
    } catch {
      // Leading brace but not valid JSON — fall through to the permissive regex.
    }
  }
  const match = trimmed.match(NGROK_URL_RE);
  return match ? match[0] : null;
}

/**
 * ngrok error codes that are NOT transient: restarting the agent just hits the same
 * wall (a config / account / hostname-collision problem, not a network blip). When one
 * of these is seen we STOP the restart loop and surface it — the opposite of a crash
 * that a respawn could recover.
 *   ERR_NGROK_334  the endpoint (reserved/free domain) is already online — another live
 *                  session holds it (ngrok free = ONE fixed domain per account, so a
 *                  second machine on the same account collides).
 *   ERR_NGROK_108  the account is limited to 1 simultaneous agent session.
 *   ERR_NGROK_105 / 107 / 4018  authentication failures (bad / stale authtoken).
 */
const NGROK_FATAL_ERR_RE = /ERR_NGROK_(?:334|108|105|107|4018)\b/;

/** A structured error pulled out of an ngrok JSON log line. */
export interface NgrokLogError {
  /** The `ERR_NGROK_*` code if present, else null. */
  code: string | null;
  /** One-line human summary (first non-empty line of ngrok's `err` / `msg`). */
  message: string;
  /** Whether this error is non-transient — restarting the agent won't help. */
  fatal: boolean;
}

/**
 * Extract an error from a single ngrok JSON log line whose level is `eror` or `crit`,
 * or `null` for anything else (info lines, URL lines, non-JSON). ngrok carries the
 * reason in a multi-line `err` field plus a short `msg`; we keep the first human line
 * and classify {@link NGROK_FATAL_ERR_RE} fatal codes. Exported for unit testing.
 */
export function parseNgrokError(line: string): NgrokLogError | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const lvl = typeof obj.lvl === 'string' ? obj.lvl.toLowerCase() : '';
  if (lvl !== 'eror' && lvl !== 'crit') return null;
  const err = typeof obj.err === 'string' ? obj.err : '';
  const msg = typeof obj.msg === 'string' ? obj.msg : '';
  const haystack = `${err} ${msg}`;
  const codeMatch = haystack.match(/ERR_NGROK_\d+/);
  const firstLine =
    (err || msg)
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  return {
    code: codeMatch ? codeMatch[0] : null,
    message: firstLine || msg || 'ngrok error',
    fatal: NGROK_FATAL_ERR_RE.test(haystack),
  };
}

/** Actionable guidance for a fatal ngrok error, keyed by its code. */
export function ngrokFatalGuidance(e: NgrokLogError): string {
  switch (e.code) {
    case 'ERR_NGROK_334':
      return (
        'that ngrok endpoint is already online in another session. ngrok free accounts ' +
        'get ONE fixed domain, so only one machine can serve it at a time — stop the ' +
        'other `portable --ngrok` (often another PC signed into the same ngrok account), ' +
        'then re-run. Or drop `--ngrok` to use cloudflared (no such limit).'
      );
    case 'ERR_NGROK_108':
      return (
        'your ngrok account is limited to 1 simultaneous agent session — stop the other ' +
        'ngrok session, then re-run. Or drop `--ngrok` to use cloudflared.'
      );
    default:
      return (
        'ngrok rejected the agent (authentication). Re-run `ngrok config add-authtoken ' +
        '<token>` or set NGROK_AUTHTOKEN, then try again. Or drop `--ngrok` for cloudflared.'
      );
  }
}

/** User-facing instruction shown when the ngrok binary is missing. */
export const NGROK_SETUP_HINT =
  'ngrok not found on PATH. `--ngrok` requires ngrok installed AND authenticated.\n' +
  'Install it:\n' +
  '  macOS:    brew install ngrok\n' +
  '  Windows:  winget install --id ngrok.ngrok\n' +
  '  Linux:    see https://ngrok.com/download\n' +
  'Then authenticate (one-time): ngrok config add-authtoken <YOUR_TOKEN>\n' +
  '(get a token at https://dashboard.ngrok.com/get-started/your-authtoken)\n' +
  'If ngrok lives outside PATH, set PORTABLE_NGROK_BIN to its full path.\n' +
  'Or drop `--ngrok` to use the default cloudflared tunnel (no account needed).';

/**
 * Resolve the ngrok executable to spawn.
 *
 * Order: an explicit `PORTABLE_NGROK_BIN` override (any platform) wins; on Windows we
 * probe the well-known install dirs (scoop shims, chocolatey bin, winget Links)
 * because those installers don't always add ngrok to PATH; otherwise fall back to the
 * bare name so PATH resolution / the missing-binary hint still apply.
 *
 * `existsImpl` / `platform` are injected seams so this is unit-testable without a real
 * filesystem or a real Windows host.
 */
export function resolveNgrokBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  existsImpl: (p: string) => boolean = fs.existsSync
): string {
  const override = env.PORTABLE_NGROK_BIN?.trim();
  if (override) return override;

  if (platform !== 'win32') return 'ngrok';

  // Build Windows paths with the win32 joiner so the backslash separators are correct
  // regardless of the HOST os (this branch is exercised in tests on macOS/Linux too).
  const candidates = [
    env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'scoop', 'shims', 'ngrok.exe') : '',
    'C:\\ProgramData\\chocolatey\\bin\\ngrok.exe',
    env.LOCALAPPDATA
      ? path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ngrok.exe')
      : '',
    path.win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'ngrok', 'ngrok.exe'),
  ].filter((c): c is string => c.length > 0);

  for (const candidate of candidates) {
    try {
      if (existsImpl(candidate)) return candidate;
    } catch {
      // Ignore probe errors — fall through to the next candidate / bare name.
    }
  }
  return 'ngrok';
}

/**
 * Detect whether the ngrok binary is available by running `<bin> version`. Resolves
 * false on spawn error (ENOENT) or a non-zero exit.
 */
export function detectNgrok(bin = 'ngrok', spawnImpl: SpawnImpl = spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawnImpl(bin, ['version'], { stdio: 'ignore' });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

/** ngrok tunnel options — identical to the shared {@link TunnelOptions}. */
export type NgrokTunnelOptions = TunnelOptions;

export class NgrokTunnel implements Tunnel {
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
  /**
   * Set once a NON-TRANSIENT ngrok error is seen (see {@link NGROK_FATAL_ERR_RE}):
   * carries the actionable guidance. While set, the supervisor stops restarting and
   * {@link waitForFirstUrl} rejects with a {@link TunnelFatalError} so boot aborts.
   */
  private fatalReason: string | null = null;
  /** Waiters on the first captured URL — resolved with the URL or rejected on a fatal error. */
  private firstUrlWaiters: Array<{ resolve: (url: string) => void; reject: (err: Error) => void }> =
    [];

  constructor(options: NgrokTunnelOptions) {
    this.localUrl = options.localUrl;
    this.onUrl = options.onUrl;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.detectImpl = options.detectImpl ?? (() => detectNgrok(this.bin, this.spawnImpl));
    this.bin = options.bin ?? 'ngrok';
    this.restartDelayMs = options.restartDelayMs ?? 1000;
    this.maxRestarts = options.maxRestarts ?? Infinity;
    this.killGraceMs = options.killGraceMs ?? 8000;
    this.sleep = options.sleep ?? realSleep;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The current public ngrok URL, or null before first capture. */
  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  isRunning(): boolean {
    return !!this.child && !this.stopped;
  }

  /**
   * Ensure ngrok is installed and spawn it. Throws {@link NGROK_SETUP_HINT} when the
   * binary is missing. Returns once the child is spawned; the public URL is delivered
   * asynchronously via {@link onUrl} (use {@link waitForFirstUrl} to await it).
   */
  async start(): Promise<void> {
    if (this.child) return;
    this.stopped = false;

    const present = await this.detectImpl();
    if (!present) {
      throw new Error(NGROK_SETUP_HINT);
    }

    this.spawnChild();
  }

  /**
   * Resolve with the first public URL captured (or the current one if already known).
   * Rejects after `timeoutMs` (default 30s) so the launcher doesn't hang forever if
   * ngrok never prints a URL.
   */
  waitForFirstUrl(timeoutMs = 30_000): Promise<string> {
    if (this.publicUrl) return Promise.resolve(this.publicUrl);
    // Already failed for a non-transient reason — fail fast, don't wait the full budget.
    if (this.fatalReason) return Promise.reject(new TunnelFatalError(this.fatalReason));
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (url: string) => {
          clearTimeout(timer);
          resolve(url);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      timer = setTimeout(() => {
        this.firstUrlWaiters = this.firstUrlWaiters.filter((w) => w !== waiter);
        reject(new Error(`[ngrok] no tunnel URL after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.firstUrlWaiters.push(waiter);
    });
  }

  private spawnChild(): void {
    const args = [
      'http',
      this.localUrl,
      '--log',
      'stdout',
      '--log-format',
      'json',
      '--log-level',
      'info',
    ];
    this.log(`[tunnel] starting ngrok: ${this.bin} ${args.join(' ')}`);
    const child = this.spawnImpl(this.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    // ngrok logs the tunnel URL to stdout (--log stdout); watch stderr too to be safe.
    this.watch(child.stdout);
    this.watch(child.stderr);

    child.once('exit', (code) => this.handleExit(code));
    child.once('error', (err) => {
      this.log(`[tunnel] ngrok error: ${err.message}`);
      this.handleExit(null);
    });
  }

  private handleExit(code: number | null): void {
    this.child = null;
    if (this.stopped) {
      this.log('[tunnel] ngrok stopped');
      return;
    }
    if (this.fatalReason) {
      // Non-transient (auth / hostname already online / session limit): respawning
      // would collide again. Stop supervising; the error was already surfaced.
      this.log(`[tunnel] not restarting ngrok — ${this.fatalReason}`);
      return;
    }
    this.log(`[tunnel] ngrok exited (code ${code ?? 'null'}) — supervising`);
    if (this.restarts >= this.maxRestarts) {
      this.log(`[tunnel] giving up after ${this.restarts} restart attempts`);
      return;
    }
    this.restarts += 1;
    // Drop the stale URL: a restart may yield a NEW ngrok hostname.
    this.publicUrl = null;
    void this.sleep(this.restartDelayMs).then(() => {
      if (this.stopped) return;
      this.log(`[tunnel] restarting ngrok (attempt ${this.restarts})`);
      this.spawnChild();
    });
  }

  /**
   * Force a tunnel rotation (self-heal). Kills the current ngrok child so the
   * crash-supervisor respawns it — which yields a fresh tunnel and re-fires
   * {@link onUrl} (→ the registration agent re-registers).
   *
   * Unlike {@link stop}, this does NOT set `stopped`, so {@link handleExit} treats the
   * death as a crash and respawns after `restartDelayMs`. No-op when stopped or before
   * the first spawn. Used by {@link TunnelHealthMonitor} when the PUBLIC relay path is
   * unreachable while the local api is healthy.
   */
  cycle(): void {
    const child = this.child;
    if (this.stopped || !child) return;
    this.log('[tunnel] cycling ngrok (self-heal: public ingress unreachable)');
    // Drop the stale URL now; handleExit() respawns (we are NOT stopped) → fresh tunnel.
    this.publicUrl = null;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this.log(`[tunnel] cycle kill error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Stop supervising and terminate ngrok (SIGTERM → SIGKILL after grace). */
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
          this.log('[tunnel] ngrok did not exit in time — sending SIGKILL');
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
    // Errors FIRST. A failing ngrok session echoes its own tunnel URL inside the error
    // text — both the JSON `err` field AND the trailing non-JSON banner
    // (`ERROR:  … 'https://…' is already online`). Parsing that back out as a live URL
    // is the phantom-tunnel bug (a dead endpoint gets registered + DNS-probed). So we
    // classify errors before URLs and, once a fatal error is latched, ignore ANY URL the
    // dead session keeps printing.
    const err = parseNgrokError(line);
    if (err) {
      // Surface ngrok's reason (otherwise a failure is just a bare `exited (code 1)`).
      if (err.fatal) {
        if (this.fatalReason) return; // already surfaced — suppress duplicate crit lines
        this.fatalReason = ngrokFatalGuidance(err);
        this.log(`[tunnel] ✗ ngrok ${err.code ?? 'error'}: ${err.message}`);
        this.log(`[tunnel]   ${this.fatalReason}`);
        // Abort any in-flight first-URL wait so boot fails fast with ngrok's message.
        const waiters = this.firstUrlWaiters;
        this.firstUrlWaiters = [];
        const fatal = new TunnelFatalError(this.fatalReason);
        for (const w of waiters) w.reject(fatal);
      } else {
        this.log(`[tunnel] ngrok ${err.code ?? 'error'}: ${err.message}`);
      }
      return;
    }

    // A latched fatal error means the session is dead — never capture a URL it echoes.
    if (this.fatalReason) return;

    const url = parseNgrokUrl(line);
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
      for (const w of waiters) w.resolve(url);
    }
  }
}
