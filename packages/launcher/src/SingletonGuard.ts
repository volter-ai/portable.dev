/**
 * Single-instance takeover for `portable` (the "type `portable` in another
 * window = full restart" behavior).
 *
 * The launcher pins the api to `127.0.0.1:VGIT_PORT` and registers ONE pcId with
 * the relay, so two concurrent runtimes can't coexist: the second api child
 * `EADDRINUSE`s the port and two cloudflared tunnels fight over the same pcId
 * registration. Rather than fail the second invocation, we make it TAKE OVER —
 * stop the already-running portable (its launcher + the api child + cloudflared
 * it owns), wait for the port to free, then boot fresh. The directory the new
 * `portable` runs in is irrelevant; the lock + the api port are the identity.
 *
 * Detection is authoritative on the **api health probe**, not just the PID file:
 * a portable runtime ALWAYS answers `GET /api/health` on the loopback port, so a
 * positive probe means "a portable really is running" — robust against a stale
 * lock (crash without cleanup) and against PID recycling (we only tree-kill when
 * the port is actually serving portable's health). The lock file gives us the PID
 * to kill; a port-owner lookup is the fallback when the lock is missing/stale.
 *
 * Cross-platform tree-kill: Windows `taskkill /T /F` (gets the api child +
 * cloudflared grandchildren); POSIX SIGTERM (the old launcher's signal handler
 * tears its children down gracefully) escalating to SIGKILL.
 *
 * Every effect is an injected seam so the whole takeover is unit-tested with
 * fakes (no real fs / process / network / child_process).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';

import { resolveApiPort } from './config.js';

/** On-disk lock describing the currently-running portable (best-effort). */
export interface LauncherLock {
  /** The launcher process id (the tree root to kill on takeover). */
  pid: number;
  /** The api port it pinned (sanity: a different port is a different runtime). */
  port: number;
  /** ISO timestamp the lock was written (diagnostics only). */
  startedAt: string;
}

/** Injected effects (all defaulted to the real impls in {@link acquireSingleton}). */
export interface SingletonGuardDeps {
  /** This process's pid (defaults to `process.pid`). */
  selfPid?: number;
  /** Absolute path to the lock file (defaults to `<DATA_DIR>/launcher.lock`). */
  lockPath?: string;
  /** The api port to probe + own (defaults to `resolveApiPort(env)`). */
  port?: number;
  /** Env for port resolution (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Probe `GET http://127.0.0.1:<port>/api/health` → true when a runtime answers ok. */
  probeHealth?: (port: number) => Promise<boolean>;
  /** Read + parse the lock file (→ null when absent/corrupt). */
  readLock?: (lockPath: string) => LauncherLock | null;
  /** Write the lock file (best-effort; never throws into boot). */
  writeLock?: (lockPath: string, lock: LauncherLock) => void;
  /** Remove the lock file (best-effort). */
  removeLock?: (lockPath: string) => void;
  /** Is `pid` a live process? Defaults to a real `kill(pid, 0)` probe. */
  isProcessAlive?: (pid: number) => boolean;
  /** Find the pid LISTENING on `port` (fallback when the lock has no pid). */
  findPortOwner?: (port: number) => Promise<number | null>;
  /** Tree-kill the process `pid` (and its children) cross-platform. */
  terminateTree?: (pid: number) => Promise<void>;
  /** Sleep (ms) — injected so tests use fake timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Now (ISO) — injected for deterministic lock timestamps. */
  nowIso?: () => string;
  /** Log sink (defaults to console.log). */
  log?: (line: string) => void;
  /** Max time (ms) to wait for the old runtime's port to free after the kill. */
  portFreeTimeoutMs?: number;
}

/** Handle returned by {@link acquireSingleton}; release on shutdown. */
export interface SingletonHandle {
  /** Remove our lock file (only if it's still ours). Idempotent, never throws. */
  release: () => void;
}

const DEFAULT_PORT_FREE_TIMEOUT_MS = 12_000;

/** Default `<DATA_DIR>/launcher.lock`. */
export function defaultLockPath(): string {
  return path.join(resolveDataDir(), 'launcher.lock');
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is `pid` a live process? (`kill(pid, 0)` throws ESRCH when it isn't.) */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal (still "alive"); ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Real `GET /api/health` probe with a short timeout (false on any error/non-2xx). */
async function probeHealthReal(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function readLockReal(lockPath: string): LauncherLock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LauncherLock;
    if (typeof parsed?.pid === 'number' && typeof parsed?.port === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeLockReal(lockPath: string, lock: LauncherLock): void {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
  } catch {
    // The lock is an optimization (takeover detection); never block boot on it.
  }
}

function removeLockReal(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Spawn a child, resolve when it exits (never rejects). */
function runToExit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Capture a child's stdout (never rejects; '' on error). */
function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.on('error', () => resolve(''));
      child.on('exit', () => resolve(out));
    } catch {
      resolve('');
    }
  });
}

/** Real cross-platform tree-kill. */
async function terminateTreeReal(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // /T = tree (api child + cloudflared grandchildren), /F = force.
    await runToExit('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  // POSIX: SIGTERM lets the old launcher's handler tear down its children
  // gracefully (tunnel deregister + api stop); escalate to SIGKILL if it lingers.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 50; i++) {
    if (!isProcessAlive(pid)) return;
    await sleepReal(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone in the meantime */
  }
}

/** Real port-owner lookup (fallback when the lock has no usable pid). */
async function findPortOwnerReal(port: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const out = await runCapture('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      // "  TCP    127.0.0.1:4200   0.0.0.0:0   LISTENING   12345"
      if (!/LISTENING/i.test(line)) continue;
      if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  }
  const out = await runCapture('lsof', [`-ti`, `tcp:${port}`, '-sTCP:LISTEN']);
  const pid = Number(out.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Ensure THIS process is the only `portable` runtime: if another is already
 * serving the api port, stop it and take over; then claim the lock. Returns a
 * handle whose `release()` removes our lock on shutdown.
 *
 * Never throws into boot — a takeover failure degrades to a warning, and the api
 * spawn will surface a hard `EADDRINUSE` itself if the old runtime truly refused
 * to die.
 */
export async function acquireSingleton(deps: SingletonGuardDeps = {}): Promise<SingletonHandle> {
  const env = deps.env ?? process.env;
  const selfPid = deps.selfPid ?? process.pid;
  const lockPath = deps.lockPath ?? defaultLockPath();
  const port = deps.port ?? resolveApiPort(env);
  const probeHealth = deps.probeHealth ?? probeHealthReal;
  const readLock = deps.readLock ?? readLockReal;
  const writeLock = deps.writeLock ?? writeLockReal;
  const removeLock = deps.removeLock ?? removeLockReal;
  const aliveCheck = deps.isProcessAlive ?? isProcessAlive;
  const findPortOwner = deps.findPortOwner ?? findPortOwnerReal;
  const terminateTree = deps.terminateTree ?? terminateTreeReal;
  const sleep = deps.sleep ?? sleepReal;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const log = deps.log ?? ((line: string) => console.log(line));
  const portFreeTimeoutMs = deps.portFreeTimeoutMs ?? DEFAULT_PORT_FREE_TIMEOUT_MS;

  const running = await probeHealth(port);
  const existing = readLock(lockPath);

  if (running) {
    // A portable runtime really IS serving the port. Find its pid to tree-kill:
    // the lock first (it's the launcher root → /T gets the api child + cloudflared),
    // then the port owner as a fallback.
    let pid = existing?.pid ?? null;
    if (pid === null || !aliveCheck(pid)) {
      pid = await findPortOwner(port);
    }
    if (pid && pid !== selfPid) {
      log(
        `[launcher] another portable is already running on :${port} (pid ${pid}) — stopping it to take over…`
      );
      await terminateTree(pid);
      // Wait for the old api to actually release the port before we boot ours.
      const deadline = Date.now() + portFreeTimeoutMs;
      let freed = false;
      while (Date.now() < deadline) {
        if (!(await probeHealth(port))) {
          freed = true;
          break;
        }
        await sleep(250);
      }
      if (freed) {
        log('[launcher] previous portable stopped — taking over.');
      } else {
        log(
          `[launcher] previous portable is still holding :${port} after ${Math.round(
            portFreeTimeoutMs / 1000
          )}s — the api may fail to bind; stop it manually if boot errors.`
        );
      }
    } else {
      // Port is serving health but we can't attribute it to a pid (or it's us).
      log(
        `[launcher] :${port} is already serving /api/health but its owner pid is unknown — ` +
          'if boot fails to bind, stop the other instance manually.'
      );
    }
  } else if (existing) {
    // Stale lock (the runtime crashed without releasing it). Drop it.
    removeLock(lockPath);
  }

  // Claim the lock for ourselves.
  writeLock(lockPath, { pid: selfPid, port, startedAt: nowIso() });

  return {
    release: () => {
      // Only remove the lock if it's still OURS (a later takeover may have
      // overwritten it with their pid — don't delete theirs).
      const current = readLock(lockPath);
      if (current && current.pid === selfPid) removeLock(lockPath);
    },
  };
}
