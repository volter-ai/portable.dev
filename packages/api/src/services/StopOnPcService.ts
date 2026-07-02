/**
 * StopOnPcService — the "Stop on PC" orchestration (rev12, PRD D59/D60).
 *
 * The mobile app asks to stop a TERMINAL `claude` session that is live on the
 * PC (chatId == the Claude Code session id). This service:
 * 1. resolves the session's CONFIRMED pid from the presence registry (a bare/
 *    unconfirmed pid is refused — never signal a process we're not sure is the
 *    right `claude`);
 * 2. delivers the stop via the mcp-sidecar channel when one is live (the
 *    sidecar signals its own parent), else falls back to a DIRECT
 *    `process.kill` — the api runs on the same PC, so it can signal the pid
 *    itself (older CLI without the sidecar, or a not-yet-connected channel);
 * 3. WAITS for evidence — never assumes. `end` (SIGTERM) is confirmed by the
 *    session going not-live (pid death flips the registry to ended, or the
 *    SessionEnd hook arrives); `interrupt` (SIGINT) is confirmed by the turn
 *    leaving the running state. Grace-bounded; a timeout returns stopped:false
 *    so the caller falls back to fork (never data loss).
 *
 * OQ-R12-1 validated (macOS/CLI 2.1.198): SIGINT and SIGTERM both leave a
 * resumable transcript, so a confirmed `end` makes the D56 hand-off safe.
 */
import { spawnSync } from 'child_process';

import { isPidAlive } from './ExternalClaudeSessionService.js';

import type { ExternalClaudeSessionService } from './ExternalClaudeSessionService.js';
import type { SidecarChannelService } from './SidecarChannelService.js';

export type StopMode = 'interrupt' | 'end';

export interface StopOnPcResult {
  stopped: boolean;
  /** How it resolved — for the client to phrase its notice / decide next step. */
  reason:
    | 'already-ended'
    | 'stopped'
    | 'no-confirmed-pid'
    | 'undeliverable'
    | 'not-confirmed'
    | 'unknown-session';
  /** The delivery path actually used (diagnostics). */
  via?: 'sidecar' | 'direct-kill';
}

export interface StopOnPcDeps {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Read a pid's `comm` (process name) for the pid-reuse guard before a DIRECT
   * kill (N2). Returns null when unknowable (Windows / no `ps` / not found).
   * Injected for tests; defaults to a bounded `ps -o comm= -p <pid>`.
   */
  readComm?: (pid: number) => string | null;
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for stop evidence. */
  graceMs?: number;
  /** Poll cadence while waiting for evidence. */
  pollMs?: number;
}

/** Bounded `ps` read of a pid's command name (POSIX). null on any failure. */
function readPidComm(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const out = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 400,
    });
    if (out.status !== 0 || !out.stdout) return null;
    const comm = out.stdout.trim();
    return comm.length > 0 ? comm : null;
  } catch {
    return null;
  }
}

const DEFAULT_GRACE_MS = 6_000;
const DEFAULT_POLL_MS = 300;

export class StopOnPcService {
  private readonly isAlive: (pid: number) => boolean;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly readComm: (pid: number) => string | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly graceMs: number;
  private readonly pollMs: number;

  constructor(
    private externalSessions: ExternalClaudeSessionService,
    private sidecarChannel: SidecarChannelService | undefined,
    deps: StopOnPcDeps = {}
  ) {
    this.isAlive = deps.isAlive ?? isPidAlive;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.readComm = deps.readComm ?? readPidComm;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  }

  async stop(sessionId: string, mode: StopMode = 'end'): Promise<StopOnPcResult> {
    const session = this.externalSessions.getSession(sessionId);
    if (!session) return { stopped: false, reason: 'unknown-session' };
    if (session.state === 'ended') return { stopped: true, reason: 'already-ended' };
    if (!session.pidConfirmed || session.pid <= 0) {
      // We won't signal a process we can't positively tie to this session.
      return { stopped: false, reason: 'no-confirmed-pid' };
    }

    const pid = session.pid;
    const signal: NodeJS.Signals = mode === 'end' ? 'SIGTERM' : 'SIGINT';

    // Prefer the sidecar ONLY when its channel is genuinely live — a registered
    // channel is never evicted and `send` queues+returns true even for a dead
    // sidecar, which would silently swallow the stop (N1). Gate on isChannelLive
    // so a crashed/absent sidecar falls through to a direct local kill.
    let via: 'sidecar' | 'direct-kill';
    if (
      this.sidecarChannel?.isChannelLive(pid) &&
      this.sidecarChannel.send(pid, { command: 'stop', mode })
    ) {
      via = 'sidecar';
    } else {
      // Direct kill: the api signals the pid itself (it runs on this PC). Guard
      // against pid REUSE (N2) — a confirmed pid can go stale if the terminal
      // exited without a SessionEnd hook and the OS recycled the number. Only
      // the sidecar path can trust the pid blindly (it signals its OWN parent);
      // a direct kill re-verifies the pid is still a `claude` process first.
      const comm = this.readComm(pid);
      if (comm !== null && !/claude/i.test(comm)) {
        // The pid is now some OTHER process — the session is gone, not a target.
        this.externalSessions.markEnded(sessionId);
        return { stopped: true, reason: 'already-ended' };
      }
      try {
        this.kill(pid, signal);
        via = 'direct-kill';
      } catch {
        return { stopped: false, reason: 'undeliverable' };
      }
    }

    // Wait for evidence. `end` → session not-live (pid death flips the registry
    // to ended, or SessionEnd arrives). `interrupt` → the turn is no longer
    // running (Stop hook flips live-running → live-idle).
    const deadline = this.graceMs;
    let waited = 0;
    while (waited < deadline) {
      await this.sleep(this.pollMs);
      waited += this.pollMs;
      if (mode === 'end') {
        if (!this.externalSessions.isLive(sessionId) || !this.isAlive(pid)) {
          this.externalSessions.markEnded(sessionId);
          return { stopped: true, reason: 'stopped', via };
        }
      } else {
        const current = this.externalSessions.getSession(sessionId);
        if (!current || current.state !== 'live-running') {
          return { stopped: true, reason: 'stopped', via };
        }
      }
    }
    return { stopped: false, reason: 'not-confirmed', via };
  }
}
