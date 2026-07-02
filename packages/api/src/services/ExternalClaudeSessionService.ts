/**
 * ExternalClaudeSessionService — the presence registry for TERMINAL `claude`
 * sessions on this PC (rev12, PRD D54).
 *
 * The api's own SessionHandler tracks only sessions it spawned via the Agent
 * SDK. Sessions the user runs in a terminal are invisible to it — this
 * registry makes them first-class: the launcher-installed global lifecycle
 * hooks (`portable hook-relay`, PRD D53) POST every SessionStart /
 * UserPromptSubmit / Stop / StopFailure / SessionEnd event to
 * `/api/internal/claude-hook`, and this service folds them into a per-session
 * state machine:
 *
 *   SessionStart      → live-idle     (session open, between turns)
 *   UserPromptSubmit  → live-running  (a turn is in flight)
 *   Stop/StopFailure  → live-idle     (turn finished)
 *   SessionEnd        → ended
 *
 * Persistence is a small SQLite table under DATA_DIR (survives api restarts —
 * hooks only fire on events, so an in-memory registry would silently forget a
 * live session across a restart). Read-time semantics are defensive:
 * - a CONFIRMED pid (the hook ancestry surfaced a `claude`-named ancestor, or
 *   the mcp-sidecar later confirms its `process.ppid`) that is dead ⇒ ended;
 * - `live-running` staler than {@link RUNNING_DECAY_MS} decays to `live-idle`
 *   (a crashed CLI mid-turn must not read as "running" forever — but the
 *   window is generous because a long autonomous turn emits NO hook events
 *   between UserPromptSubmit and Stop);
 * - anything `live-*` staler than {@link LIVE_TTL_MS} ⇒ ended.
 *
 * Consumers: the runtime-state fold (presence badge, D55), the
 * adopt-vs-fork gate (D56/D57 — `isLive`), and the Stop-on-PC flow (D59).
 */
import fs from 'fs';
import path from 'path';

import { resolveDataDir } from '@vgit2/shared/secrets';
import { Database } from 'bun:sqlite';

/** Registry states. `live-running` ⇄ `live-idle` → `ended`. */
export type ExternalSessionState = 'live-idle' | 'live-running' | 'ended';

/** Filename of the registry database inside DATA_DIR. */
export const EXTERNAL_SESSIONS_DB_FILE = 'external-claude-sessions.sqlite';

/** live-running staler than this decays to live-idle (crashed-mid-turn guard). */
export const RUNNING_DECAY_MS = 2 * 60 * 60 * 1000; // 2h — long agent turns are real
/** Any live-* row staler than this is treated as ended. */
export const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** One terminal session as tracked by the registry. */
export interface ExternalClaudeSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  /** Best-known pid of the `claude` CLI process (0 = unknown). */
  pid: number;
  /**
   * True when the pid is trustworthy (a `claude`-named hook ancestor, or the
   * mcp-sidecar's own `process.ppid`). Only a CONFIRMED dead pid demotes a
   * session to ended — an unconfirmed pid may be the hook's transient shell.
   */
  pidConfirmed: boolean;
  state: ExternalSessionState;
  /** Epoch ms of the last hook event folded into this row. */
  updatedAt: number;
}

/** The subset of a Claude Code hook payload the registry reads. */
export interface ExternalHookEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  /** Augmentation added by `portable hook-relay`. */
  portable?: {
    ppid?: unknown;
    ancestors?: Array<{ pid?: unknown; command?: unknown }>;
  };
}

interface DbRow {
  session_id: string;
  transcript_path: string;
  cwd: string;
  pid: number;
  pid_confirmed: number;
  state: string;
  updated_at: number;
}

const EVENT_STATE: Record<string, ExternalSessionState> = {
  SessionStart: 'live-idle',
  UserPromptSubmit: 'live-running',
  Stop: 'live-idle',
  StopFailure: 'live-idle',
  SessionEnd: 'ended',
};

/** `process.kill(pid, 0)` liveness probe: EPERM means alive-but-not-ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export class ExternalClaudeSessionService {
  private readonly dbPath: string;
  private db: Database | null = null;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    dataDir: string = resolveDataDir(),
    options: { isAlive?: (pid: number) => boolean } = {}
  ) {
    this.dbPath = path.join(dataDir, EXTERNAL_SESSIONS_DB_FILE);
    this.isAlive = options.isAlive ?? isPidAlive;
  }

  initialize(): void {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL unavailable (exotic FS) — the default journal is fine for this tiny table.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_claude_sessions (
        session_id      TEXT PRIMARY KEY,
        transcript_path TEXT NOT NULL DEFAULT '',
        cwd             TEXT NOT NULL DEFAULT '',
        pid             INTEGER NOT NULL DEFAULT 0,
        pid_confirmed   INTEGER NOT NULL DEFAULT 0,
        state           TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private required(): Database {
    if (!this.db) throw new Error('[ExternalClaudeSessionService] not initialized');
    return this.db;
  }

  /**
   * Fold one hook event into the registry. Returns whether the visible state
   * changed (the caller broadcasts the runtime snapshot only on real change).
   * Unknown events / payloads without a session_id are ignored.
   */
  ingestHookEvent(event: ExternalHookEvent, now: number = Date.now()): { changed: boolean } {
    const eventName = typeof event.hook_event_name === 'string' ? event.hook_event_name : '';
    const nextState = EVENT_STATE[eventName];
    const sessionId = typeof event.session_id === 'string' ? event.session_id.trim() : '';
    if (!nextState || sessionId.length === 0) return { changed: false };

    const transcriptPath = typeof event.transcript_path === 'string' ? event.transcript_path : '';
    const cwd = typeof event.cwd === 'string' ? event.cwd : '';
    const { pid, confirmed } = pickPid(event);

    const db = this.required();
    const existing = db
      .prepare<DbRow>(
        'SELECT session_id, transcript_path, cwd, pid, pid_confirmed, state, updated_at FROM external_claude_sessions WHERE session_id = ?'
      )
      .get(sessionId);

    // Never let an unconfirmed pid overwrite a confirmed one (the sidecar's
    // confirmation is stronger than hook ancestry guesses).
    const keepConfirmed = existing?.pid_confirmed === 1 && !confirmed;
    const nextPid = keepConfirmed ? existing.pid : pid > 0 ? pid : (existing?.pid ?? 0);
    const nextConfirmed = keepConfirmed ? 1 : confirmed ? 1 : (existing?.pid_confirmed ?? 0);

    db.prepare(
      `INSERT INTO external_claude_sessions
         (session_id, transcript_path, cwd, pid, pid_confirmed, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         transcript_path = CASE WHEN excluded.transcript_path != '' THEN excluded.transcript_path ELSE transcript_path END,
         cwd             = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE cwd END,
         pid             = excluded.pid,
         pid_confirmed   = excluded.pid_confirmed,
         state           = excluded.state,
         updated_at      = excluded.updated_at`
    ).run(sessionId, transcriptPath, cwd, nextPid, nextConfirmed, nextState, now);

    return { changed: existing?.state !== nextState || !existing };
  }

  /** Explicit terminal-state write (Stop-on-PC evidence, sidecar channel death). */
  markEnded(sessionId: string, now: number = Date.now()): void {
    this.required()
      .prepare('UPDATE external_claude_sessions SET state = ?, updated_at = ? WHERE session_id = ?')
      .run('ended', now, sessionId);
  }

  /**
   * The mcp-sidecar announced itself with its parent CLI's pid (rev12 D58).
   * Correlate: an exact live-pid match confirms in place; else a UNIQUE live
   * session in the same cwd adopts this pid (hook ancestry may only have
   * surfaced the transient shell). Ambiguous (two live sessions in one cwd)
   * ⇒ no correlation — honest degradation, Stop-on-PC stays unavailable there.
   * Returns the matched sessionId, or null.
   */
  confirmSidecarPid(ppid: number, cwd: string, now: number = Date.now()): string | null {
    if (!Number.isInteger(ppid) || ppid <= 0) return null;
    const live = this.getLiveSessions(now);

    const byPid = live.find((s) => s.pid === ppid);
    if (byPid) {
      if (!byPid.pidConfirmed) {
        this.required()
          .prepare('UPDATE external_claude_sessions SET pid_confirmed = 1 WHERE session_id = ?')
          .run(byPid.sessionId);
      }
      return byPid.sessionId;
    }

    const byCwd = live.filter((s) => s.cwd === cwd && cwd.length > 0);
    if (byCwd.length === 1) {
      this.required()
        .prepare(
          'UPDATE external_claude_sessions SET pid = ?, pid_confirmed = 1 WHERE session_id = ?'
        )
        .run(ppid, byCwd[0].sessionId);
      return byCwd[0].sessionId;
    }
    return null;
  }

  /**
   * All sessions that are effectively live right now, defensive semantics
   * applied (confirmed-dead pid ⇒ ended; stale decay/TTL) and persisted so the
   * table converges instead of re-deriving forever.
   */
  getLiveSessions(now: number = Date.now()): ExternalClaudeSession[] {
    const db = this.required();
    const rows = db
      .prepare<DbRow>(
        "SELECT session_id, transcript_path, cwd, pid, pid_confirmed, state, updated_at FROM external_claude_sessions WHERE state != 'ended'"
      )
      .all();

    const live: ExternalClaudeSession[] = [];
    for (const row of rows) {
      const session = this.applyReadTimeRules(row, now);
      if (session.state !== 'ended') live.push(session);
    }
    return live;
  }

  /** One session with read-time rules applied; null when unknown. */
  getSession(sessionId: string, now: number = Date.now()): ExternalClaudeSession | null {
    const row = this.required()
      .prepare<DbRow>(
        'SELECT session_id, transcript_path, cwd, pid, pid_confirmed, state, updated_at FROM external_claude_sessions WHERE session_id = ?'
      )
      .get(sessionId);
    if (!row) return null;
    return this.applyReadTimeRules(row, now);
  }

  /**
   * The adopt-vs-fork gate's question (PRD D56/D57): is this session live on
   * the terminal right now? Unknown sessions are NOT live (adoption safety is
   * additionally guarded by the transcript-mtime freshness check at the call
   * site — a session started while Portable was off has a hot mtime).
   */
  isLive(sessionId: string, now: number = Date.now()): boolean {
    const session = this.getSession(sessionId, now);
    return session !== null && session.state !== 'ended';
  }

  private applyReadTimeRules(row: DbRow, now: number): ExternalClaudeSession {
    let state = (
      row.state === 'live-running' || row.state === 'live-idle' ? row.state : 'ended'
    ) as ExternalSessionState;
    const age = now - row.updated_at;

    if (state !== 'ended') {
      if (row.pid_confirmed === 1 && row.pid > 0 && !this.isAlive(row.pid)) {
        state = 'ended';
      } else if (age > LIVE_TTL_MS) {
        state = 'ended';
      } else if (state === 'live-running' && age > RUNNING_DECAY_MS) {
        state = 'live-idle';
      }
    }

    if (state !== row.state) {
      this.required()
        .prepare('UPDATE external_claude_sessions SET state = ? WHERE session_id = ?')
        .run(state, row.session_id);
    }

    return {
      sessionId: row.session_id,
      transcriptPath: row.transcript_path,
      cwd: row.cwd,
      pid: row.pid,
      pidConfirmed: row.pid_confirmed === 1,
      state,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Pick the best pid candidate out of the hook-relay augmentation. A
 * `claude`-named ancestor is trustworthy (confirmed); otherwise fall back to
 * the raw ppid UNCONFIRMED — it may be the hook's transient shell, so it must
 * never be used as death evidence on its own.
 */
function pickPid(event: ExternalHookEvent): { pid: number; confirmed: boolean } {
  const ancestors = Array.isArray(event.portable?.ancestors) ? event.portable.ancestors : [];
  for (const a of ancestors) {
    const command = typeof a?.command === 'string' ? a.command : '';
    const pid = typeof a?.pid === 'number' ? a.pid : NaN;
    if (Number.isInteger(pid) && pid > 0 && /claude/i.test(command)) {
      return { pid, confirmed: true };
    }
  }
  const ppid = typeof event.portable?.ppid === 'number' ? event.portable.ppid : NaN;
  if (Number.isInteger(ppid) && ppid > 0) return { pid: ppid, confirmed: false };
  return { pid: 0, confirmed: false };
}
