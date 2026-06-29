/**
 * SessionReaperService — automatic idle Claude-session reaping.
 *
 * In this architecture a fully-idle chat does NOT hold a Claude subprocess: when
 * a turn completes the for-await loop's finally block tears the subprocess down
 * (query=null, inputQueue=undefined) and only a tiny `session_id` string remains.
 * The memory-holding subprocess persists ONLY between turns of a multi-turn
 * session — while `query` + `inputQueue` are set and the loop is blocked waiting
 * on the input queue. THIS is what the reaper targets.
 *
 * Reaping just calls `stopSession`, which closes the input queue (the loop exits,
 * the subprocess is freed) while PRESERVING `session_id`. The next message then
 * resumes the session transparently (CASE 2 resume) — the user loses nothing but
 * a marginally slower next turn. This is a proactive, time-based reclaim of idle
 * session subprocesses.
 *
 * The TTL is tunable via `CLAUDE_SESSION_IDLE_TTL_MS` (default 10 min) and is
 * surfaced in the runtime panel. All work is bounded (a small in-memory map walk
 * + an awaited `stopSession`), so it never blocks the event loop.
 */

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * Resolve the idle TTL from `CLAUDE_SESSION_IDLE_TTL_MS` (falling back to the
 * 10-minute default for an unset/invalid value). Exported so the runtime panel
 * can surface the same value the reaper enforces.
 */
export function getClaudeSessionIdleTtlMs(): number {
  const raw = process.env.CLAUDE_SESSION_IDLE_TTL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TTL_MS;
}

/** Minimal slice of ClaudeService the reaper needs (keeps it unit-testable). */
export interface ReaperClaudeService {
  getAllSessions(): Map<string, any>;
  stopSession(chatId: string, userId?: string): Promise<boolean>;
}

export interface SessionReaperDeps {
  claudeService: ReaperClaudeService;
  /**
   * Called after a session is reaped so the caller can notify the owning user
   * (emit `session:reaped`) and rebroadcast the runtime state.
   */
  onReap: (userId: string, chatId: string, idleMs: number) => void;
  /** Idle TTL in ms (defaults to {@link getClaudeSessionIdleTtlMs}). */
  ttlMs?: number;
  /** Reaper tick interval in ms (default 60s). */
  intervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class SessionReaperService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private deps: SessionReaperDeps) {
    this.ttlMs = deps.ttlMs ?? getClaudeSessionIdleTtlMs();
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Idle TTL the reaper enforces (surfaced in the runtime panel). */
  getTtlMs(): number {
    return this.ttlMs;
  }

  start(): void {
    // Reaping is a SAFE reclaim: stopSession frees an idle subprocess while
    // PRESERVING session_id, so the next message resumes transparently — the user
    // loses nothing. (OQ-09: a *soft* warn-only local memory-pressure notice with NO
    // kill is still an open follow-up — the hard idle-shutdown / OOM-kill guards were
    // removed entirely in the local-first pivot.)
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reapOnce();
    }, this.intervalMs);
    // Don't keep the process alive just for the reaper.
    if (typeof (this.timer as any)?.unref === 'function') (this.timer as any).unref();
    console.log(
      `[SessionReaperService] Started (ttl=${this.ttlMs}ms, interval=${this.intervalMs}ms)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One reap pass. Terminates every LIVE, idle (not processing), not-already-
   * stopping session whose idle time exceeds the TTL. Returns the reaped chatIds.
   */
  async reapOnce(): Promise<string[]> {
    const sessions = this.deps.claudeService.getAllSessions();
    const now = this.now();

    // Collect first (the synchronous walk never awaits — no event-loop stalls).
    const candidates: Array<{ chatId: string; userId: string; idleMs: number }> = [];
    for (const [chatId, session] of sessions.entries()) {
      if (!session) continue;
      // Only live subprocesses hold memory worth reclaiming.
      if (!session.query || !session.inputQueue) continue;
      // Never reap an actively-generating (or permission-waiting) session.
      if (session.isProcessing) continue;
      // Already stopping (manual kill / prior reap in flight).
      if (session.signal?.stopped) continue;
      const last = session.lastActivityAt;
      if (typeof last !== 'number' || last <= 0) continue;
      const idleMs = now - last;
      if (idleMs <= this.ttlMs) continue;
      candidates.push({ chatId, userId: session.userId, idleMs });
    }

    const reaped: string[] = [];
    for (const { chatId, userId, idleMs } of candidates) {
      try {
        const ok = await this.deps.claudeService.stopSession(chatId, userId);
        if (!ok) continue;
        reaped.push(chatId);
        console.log(
          `[SessionReaperService] Reaped idle session ${chatId} (idle ${Math.round(
            idleMs / 1000
          )}s > ttl ${Math.round(this.ttlMs / 1000)}s) — session_id preserved for resume`
        );
        if (userId) this.deps.onReap(userId, chatId, idleMs);
      } catch (err) {
        console.error(`[SessionReaperService] Error reaping ${chatId}:`, err);
      }
    }
    return reaped;
  }
}
