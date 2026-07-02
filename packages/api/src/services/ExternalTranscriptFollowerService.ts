/**
 * ExternalTranscriptFollowerService — rev12 D62 (mid-turn live-follow).
 *
 * While a TERMINAL `claude` turn is running on this PC (registry state
 * `live-running`) AND someone has the chat open on the phone (its Socket.IO
 * room has members), follow the session's transcript JSONL and push each
 * newly-persisted row to the room as `chat:external_messages`. The CLI writes
 * the transcript PROGRESSIVELY — every block (text / tool_use / tool_result)
 * lands as its own line the moment it completes (verified empirically, PRD
 * §10) — so this is what makes a terminal turn visible on the phone AS IT
 * HAPPENS, instead of only after the Stop hook's turn-complete refresh.
 *
 * Scope discipline (zero cost when nobody is watching):
 *  - follow starts only on a `UserPromptSubmit` hook for a chat whose room has
 *    members, or on a `chat:join` of a chat whose session is `live-running`;
 *  - every check re-verifies room membership + registry state, unfollowing on
 *    an empty room or an `ended` session (a decayed `live-idle` keeps the
 *    follow — RUNNING_DECAY only means "no hook for 2h", not "turn over");
 *  - the Stop / StopFailure / SessionEnd hooks unfollow immediately — the
 *    existing `chat:external_turn_completed` refresh is the final reconcile,
 *    so any tail rows the debounce missed arrive with that snapshot.
 *
 * Read path: the injected `getMessages` (ChatService → the ClaudeProjects
 * transcript reader) returns rows with the synthesized monotonic numeric id,
 * so "new" is a plain `id > cursor` filter and the payload is the exact
 * `chat:join` wire shape. A stat-size gate skips re-reads when the file has
 * not grown; fs.watch (debounced) is the fast path and an unref'd interval
 * poll is the cross-platform backstop.
 */
import fs from 'fs';

import type { BufferedMessage } from '@vgit2/shared/types';

/**
 * Event name as a string literal — the api deliberately does not import the
 * shared socket barrel at runtime (it pulls `socket.io-client`, a mobile dep).
 * Mirrors `SERVER_EVENTS.CHAT_EXTERNAL_MESSAGES` in `@vgit2/shared/socket`.
 */
export const CHAT_EXTERNAL_MESSAGES_EVENT = 'chat:external_messages';

/** The slice of a hook-relay event this service reads (mirrors ExternalHookEvent). */
export interface FollowerHookEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
}

export interface TranscriptFollowerDeps {
  /** Registry read (PID/TTL-revalidated) — null when the session is unknown. */
  getSession: (sessionId: string) => { state: string; transcriptPath: string } | null;
  /** Full transcript read in the `chat:join` wire shape (ascending ids). */
  getMessages: (chatId: string) => Promise<BufferedMessage[]>;
  broadcastToRoom: (room: string, event: string, payload: unknown) => void;
  roomHasMembers: (room: string) => boolean;
  /** Injectable fs seams (tests). Defaults: fs.statSync / debounced fs.watch. */
  statSize?: (path: string) => number | null;
  watchFile?: (path: string, onChange: () => void) => (() => void) | null;
  /** Backstop poll cadence while following (fs.watch is the fast path). */
  pollIntervalMs?: number;
}

interface FollowedSession {
  transcriptPath: string;
  /** Highest row id already delivered (baseline = on-disk max at follow start). */
  lastId: number;
  /** Transcript byte size at the last read — the cheap "did it grow" gate. */
  lastSize: number;
  reading: boolean;
  pending: boolean;
  unwatch: (() => void) | null;
  interval: ReturnType<typeof setInterval>;
}

const DEFAULT_POLL_INTERVAL_MS = 700;
const WATCH_DEBOUNCE_MS = 150;

function statSizeDefault(path: string): number | null {
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

function watchFileDefault(path: string, onChange: () => void): (() => void) | null {
  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watcher = fs.watch(path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
    });
    // A watcher error (file rotated/removed) must never crash the process —
    // the interval poll keeps the follower alive.
    watcher.on('error', () => {});
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return null; // fs.watch unavailable here — the interval poll carries it
  }
}

export class ExternalTranscriptFollowerService {
  private readonly deps: TranscriptFollowerDeps;
  private readonly followed = new Map<string, FollowedSession>();

  constructor(deps: TranscriptFollowerDeps) {
    this.deps = deps;
  }

  /**
   * Hook-ingest tap (server.ts `onHookEvent`). `UserPromptSubmit` starts a
   * follow; the turn/session-end hooks stop it (the turn-complete refresh is
   * the final reconcile). Safe to fire-and-forget.
   */
  async onHookEvent(event: FollowerHookEvent): Promise<void> {
    const name = typeof event.hook_event_name === 'string' ? event.hook_event_name : '';
    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    if (!sessionId) return;
    if (name === 'UserPromptSubmit') {
      await this.follow(sessionId);
    } else if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') {
      this.unfollow(sessionId);
    }
  }

  /** `chat:join` tap — covers opening the chat while the turn is already running. */
  async onChatJoined(chatId: string): Promise<void> {
    await this.follow(chatId);
  }

  /** Sessions currently followed (tests / diagnostics). */
  followedCount(): number {
    return this.followed.size;
  }

  unfollowAll(): void {
    for (const sessionId of [...this.followed.keys()]) this.unfollow(sessionId);
  }

  private async follow(sessionId: string): Promise<void> {
    if (this.followed.has(sessionId)) return;
    const session = this.deps.getSession(sessionId);
    if (!session || session.state !== 'live-running' || !session.transcriptPath) return;
    if (!this.deps.roomHasMembers(sessionId)) return;

    // Reserve the slot SYNCHRONOUSLY (before the async baseline read) so a
    // hook and a join racing on the same session can never double-start.
    const statSize = this.deps.statSize ?? statSizeDefault;
    const state: FollowedSession = {
      transcriptPath: session.transcriptPath,
      lastId: 0,
      lastSize: statSize(session.transcriptPath) ?? 0,
      reading: false,
      pending: false,
      unwatch: null,
      interval: setInterval(
        () => void this.checkNow(sessionId),
        this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
      ),
    };
    (state.interval as unknown as { unref?: () => void }).unref?.();
    this.followed.set(sessionId, state);

    try {
      // Baseline: everything already on disk was delivered by the join ack /
      // is reachable via load-more — only rows AFTER this point get pushed.
      const rows = await this.deps.getMessages(sessionId);
      state.lastId = rows.length > 0 ? rows[rows.length - 1].id : 0;
    } catch (error) {
      // Unreadable transcript (e.g. a session outside the workspace scope) —
      // nothing to follow.
      console.error(`[TranscriptFollower] baseline read failed for ${sessionId}:`, error);
      this.unfollow(sessionId);
      return;
    }

    const watchFile = this.deps.watchFile ?? watchFileDefault;
    state.unwatch = watchFile(session.transcriptPath, () => void this.checkNow(sessionId));
  }

  private unfollow(sessionId: string): void {
    const state = this.followed.get(sessionId);
    if (!state) return;
    clearInterval(state.interval);
    state.unwatch?.();
    this.followed.delete(sessionId);
  }

  /**
   * One read-and-push cycle (watch callback, interval backstop, and tests).
   * Serialized per session; a change landing mid-read schedules exactly one
   * follow-up pass so the tail is never dropped.
   */
  async checkNow(sessionId: string): Promise<void> {
    const state = this.followed.get(sessionId);
    if (!state) return;
    if (!this.deps.roomHasMembers(sessionId)) {
      this.unfollow(sessionId); // re-startable by the next chat:join
      return;
    }
    const session = this.deps.getSession(sessionId);
    if (!session || session.state === 'ended') {
      this.unfollow(sessionId);
      return;
    }
    const statSize = this.deps.statSize ?? statSizeDefault;
    const size = statSize(state.transcriptPath);
    if (size === null || size === state.lastSize) return;
    if (state.reading) {
      state.pending = true;
      return;
    }
    state.reading = true;
    try {
      const rows = await this.deps.getMessages(sessionId);
      // Record the size statted BEFORE the read — rows written DURING the read
      // grow it again, so the next watch/poll pass re-reads (id filter dedups).
      state.lastSize = size;
      const newRows = rows.filter((r) => typeof r.id === 'number' && r.id > state.lastId);
      if (newRows.length > 0 && this.followed.get(sessionId) === state) {
        state.lastId = newRows[newRows.length - 1].id;
        this.deps.broadcastToRoom(sessionId, CHAT_EXTERNAL_MESSAGES_EVENT, {
          chatId: sessionId,
          messages: newRows,
        });
      }
    } catch (error) {
      console.error(`[TranscriptFollower] transcript read failed for ${sessionId}:`, error);
    } finally {
      state.reading = false;
    }
    if (state.pending && this.followed.get(sessionId) === state) {
      state.pending = false;
      await this.checkNow(sessionId);
    }
  }
}
