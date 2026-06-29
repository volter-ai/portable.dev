import { type ChildProcess, spawn } from 'child_process';

import {
  buildApiChildEnv,
  resolveApiCwd,
  resolveApiServerEntry,
  type ApiChildEnvOverrides,
} from './config.js';

/**
 * Spawn + supervise the api server.
 *
 * The launcher runs the api as a child `bun src/server.ts`, forced into local
 * mode and pinned to 127.0.0.1:VGIT_PORT (API + Socket.IO only — no web bundle).
 * Child stdout/stderr are line-prefixed `[api]` so the user sees a single clean
 * combined log; SIGINT/SIGTERM from the launcher are forwarded for a graceful
 * stop (then SIGKILL after a grace period).
 */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number) => Promise<void>;
type SpawnImpl = typeof spawn;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Body returned by GET /api/health. */
export interface ApiHealthBody {
  status?: string;
  timestamp?: string;
  uptime?: number;
  environment?: string;
  [k: string]: unknown;
}

export interface WaitForHealthOptions {
  fetchImpl?: FetchImpl;
  sleep?: SleepImpl;
  /** Max number of polls before giving up. Default 60. */
  attempts?: number;
  /** Delay between polls in ms. Default 500. */
  intervalMs?: number;
  /** Optional liveness probe — abort early (throw) if the process has died. */
  isAlive?: () => boolean;
}

/**
 * Poll `${baseUrl}/api/health` until it returns a real JSON body with
 * `status: 'ok'`, then resolve with that body. Throws on timeout (or when
 * `isAlive()` reports the process died first). This is the Ralph-runnable smoke
 * assertion: "launcher boots and /api/health returns a real JSON body".
 */
export async function waitForHealth(
  baseUrl: string,
  options: WaitForHealthOptions = {}
): Promise<ApiHealthBody> {
  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? realSleep;
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 500;
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error('[ApiProcess] api process exited before becoming healthy');
    }
    try {
      const res = await doFetch(url, { method: 'GET' });
      if (res.ok) {
        const body = (await res.json()) as ApiHealthBody;
        if (body && body.status === 'ok') {
          return body;
        }
        lastErr = new Error(`unexpected health body: ${JSON.stringify(body)}`);
      } else {
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(
    `[ApiProcess] /api/health did not become ready after ${attempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

export interface ApiProcessOptions {
  /** Base env to derive the child env from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Env overrides forwarded into {@link buildApiChildEnv} — the launcher's
   * data-path JWT secret + pcId + relay base, so the api validates the
   * launcher-minted pairing JWT with the SAME secret.
   */
  childEnvOverrides?: ApiChildEnvOverrides;
  /** child_process.spawn seam (injected in tests). */
  spawnImpl?: SpawnImpl;
  /** Bun executable. Defaults to 'bun'. */
  bun?: string;
  /** Grace period (ms) between SIGTERM and SIGKILL on stop(). Default 8000. */
  killGraceMs?: number;
  /** Line sink for child output. Defaults to console.log. */
  log?: (line: string) => void;
}

export class ApiProcess {
  private readonly env: NodeJS.ProcessEnv;
  private readonly childEnvOverrides: ApiChildEnvOverrides;
  private readonly spawnImpl: SpawnImpl;
  private readonly bun: string;
  private readonly killGraceMs: number;
  private readonly log: (line: string) => void;

  private child: ChildProcess | null = null;
  private exitPromise: Promise<number | null> | null = null;
  private exited = false;

  constructor(options: ApiProcessOptions = {}) {
    this.env = options.env ?? process.env;
    this.childEnvOverrides = options.childEnvOverrides ?? {};
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.bun = options.bun ?? 'bun';
    this.killGraceMs = options.killGraceMs ?? 8000;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** True once the child has spawned and not yet exited. */
  isAlive(): boolean {
    return !!this.child && !this.exited;
  }

  /** The child PID, or undefined before start / after exit. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn the api child. The argv/env are derived from {@link config}. */
  start(): ChildProcess {
    if (this.child) return this.child;

    const entry = resolveApiServerEntry();
    const cwd = resolveApiCwd();
    const childEnv = buildApiChildEnv(this.env, this.childEnvOverrides);

    this.log(`[launcher] starting api: ${this.bun} ${entry}`);
    const child = this.spawnImpl(this.bun, [entry], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = false;

    this.pipe(child.stdout, '[api]');
    this.pipe(child.stderr, '[api]');

    this.exitPromise = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.exited = true;
        this.log(`[launcher] api process exited (code ${code ?? 'null'})`);
        resolve(code ?? null);
      });
      child.once('error', (err) => {
        this.exited = true;
        this.log(`[launcher] api process error: ${err.message}`);
        resolve(null);
      });
    });

    return child;
  }

  /** Resolve when the api child exits (rejects never — resolves with exit code). */
  waitUntilExit(): Promise<number | null> {
    return this.exitPromise ?? Promise.resolve(null);
  }

  /**
   * Gracefully stop the api child: SIGTERM, then SIGKILL after the grace period.
   * Resolves once the child has exited (or immediately if already stopped).
   */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;

    child.kill(signal);

    const killTimer = setTimeout(() => {
      if (!this.exited) {
        this.log('[launcher] api did not exit in time — sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, this.killGraceMs);
    // Don't let the grace timer keep the launcher's event loop alive.
    if (typeof killTimer.unref === 'function') killTimer.unref();

    await this.waitUntilExit();
    clearTimeout(killTimer);
  }

  private pipe(stream: NodeJS.ReadableStream | null, prefix: string): void {
    if (!stream) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.log(`${prefix} ${line}`);
      }
    });
    stream.on('end', () => {
      if (buffer.length) this.log(`${prefix} ${buffer}`);
    });
  }
}
