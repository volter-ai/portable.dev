/**
 * SidecarChannelService — the api half of the mcp-sidecar channel (rev12 D58).
 *
 * Every terminal `claude` session spawns a `portable mcp-sidecar` child that
 * registers `{ppid, cwd}` here and long-polls for commands. This service:
 * - correlates a registering sidecar to its session in the presence registry
 *   (pid match first, else a unique-cwd live session) and CONFIRMS the pid —
 *   upgrading the registry's death detection from heuristic to authoritative;
 * - parks long-poll requests per pid and delivers queued commands (today only
 *   `stop`, the Stop-on-PC delivery path, D59);
 * - tracks per-pid lastSeen so a silent channel reads as evidence.
 *
 * Everything is in-memory: a channel is exactly as alive as its polling
 * process; nothing here needs to survive a restart.
 */
import type { ExternalClaudeSessionService } from './ExternalClaudeSessionService.js';
import type { SidecarCommand } from '@vgit2/shared/types';

interface Waiter {
  resolve: (command: SidecarCommand | null) => void;
  timer: NodeJS.Timeout;
}

interface Channel {
  cwd: string;
  lastSeenAt: number;
  queue: SidecarCommand[];
  waiter: Waiter | null;
}

/** Long-poll park window ceiling (the sidecar asks for 25s). */
const MAX_WAIT_MS = 30_000;

export class SidecarChannelService {
  private readonly channels = new Map<number, Channel>();

  constructor(private externalSessions?: ExternalClaudeSessionService) {}

  /**
   * A sidecar announced itself. Correlate to the presence registry: an exact
   * live-pid match confirms in place; otherwise a UNIQUE live session in the
   * same cwd adopts this pid (hook ancestry may have surfaced only the shell).
   * Returns the matched sessionId when correlation succeeded.
   */
  register(ppid: number, cwd: string, now: number = Date.now()): string | null {
    const existing = this.channels.get(ppid);
    if (existing) {
      existing.cwd = cwd;
      existing.lastSeenAt = now;
    } else {
      this.channels.set(ppid, { cwd, lastSeenAt: now, queue: [], waiter: null });
    }
    try {
      return this.externalSessions?.confirmSidecarPid(ppid, cwd, now) ?? null;
    } catch (error) {
      console.error('[SidecarChannel] pid correlation failed:', error);
      return null;
    }
  }

  /**
   * Long-poll: resolve immediately with a queued command, else park up to
   * `waitMs` (one waiter per pid — a newer poll replaces an older one, which
   * resolves empty). Resolves null on timeout.
   */
  poll(ppid: number, waitMs: number, now: number = Date.now()): Promise<SidecarCommand | null> {
    let channel = this.channels.get(ppid);
    if (!channel) {
      channel = { cwd: '', lastSeenAt: now, queue: [], waiter: null };
      this.channels.set(ppid, channel);
    }
    channel.lastSeenAt = now;

    const queued = channel.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (channel.waiter) {
      clearTimeout(channel.waiter.timer);
      channel.waiter.resolve(null);
      channel.waiter = null;
    }

    const bounded = Math.min(Math.max(0, waitMs), MAX_WAIT_MS);
    return new Promise<SidecarCommand | null>((resolve) => {
      const timer = setTimeout(() => {
        if (channel.waiter?.resolve === resolve) channel.waiter = null;
        resolve(null);
      }, bounded);
      timer.unref?.();
      channel.waiter = { resolve, timer };
    });
  }

  /**
   * Deliver a command to a sidecar (Stop-on-PC, D59). Resolves a parked poll
   * immediately, else queues for the next poll. Returns false when no channel
   * has EVER registered for this pid (nothing to deliver to).
   */
  send(ppid: number, command: SidecarCommand): boolean {
    const channel = this.channels.get(ppid);
    if (!channel) return false;
    if (channel.waiter) {
      clearTimeout(channel.waiter.timer);
      const { resolve } = channel.waiter;
      channel.waiter = null;
      resolve(command);
      return true;
    }
    channel.queue.push(command);
    return true;
  }

  /** ms since this pid's sidecar last checked in; null when never seen. */
  msSinceSeen(ppid: number, now: number = Date.now()): number | null {
    const channel = this.channels.get(ppid);
    return channel ? Math.max(0, now - channel.lastSeenAt) : null;
  }

  /** True when a live channel exists (a poll within the given window). */
  isChannelLive(ppid: number, windowMs = 60_000, now: number = Date.now()): boolean {
    const since = this.msSinceSeen(ppid, now);
    return since !== null && since <= windowMs;
  }
}
