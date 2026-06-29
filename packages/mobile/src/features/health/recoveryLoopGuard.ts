/**
 * recoveryLoopGuard — caps automatic sandbox recovery so a persistently dead
 * sandbox can't loop forever and drain the device battery.
 *
 * The re-provision flow (`requestReprovision` — clear the dead sandbox URL →
 * session-epoch bump → the provisioning gate) is triggered every time the
 * health pipeline confirms a death. If the freshly-provisioned
 * sandbox dies again immediately (a genuinely broken backend, a revoked account,
 * a network black-hole), that loop would re-provision endlessly. This guard caps
 * it at {@link MAX_RECOVERIES_PER_WINDOW} re-provisions per
 * {@link RECOVERY_WINDOW_MS} sliding window; on exhaustion the death handler
 * stops auto-re-provisioning and raises the native ConnectionFailed screen with
 * a manual "Try again" (which calls {@link RecoveryLoopGuard.reset}).
 *
 * Framework-free with an injectable clock so the sliding window is exercised
 * deterministically in Jest without real timers.
 */

/** Max automatic recoveries allowed within one sliding window. */
export const MAX_RECOVERIES_PER_WINDOW = 3;

/** Length of the sliding window (5 minutes). */
export const RECOVERY_WINDOW_MS = 5 * 60 * 1000;

export interface RecoveryLoopGuardOptions {
  /** Wall-clock source (ms). Default: `Date.now`. */
  now?: () => number;
  /** Override the per-window cap (default {@link MAX_RECOVERIES_PER_WINDOW}). */
  maxPerWindow?: number;
  /** Override the window length in ms (default {@link RECOVERY_WINDOW_MS}). */
  windowMs?: number;
}

/**
 * Sliding-window rate limiter for automatic sandbox recoveries. Records the
 * timestamp of each recovery and prunes entries older than the window on every
 * query, so the count always reflects the live window.
 */
export class RecoveryLoopGuard {
  private readonly now: () => number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  /** Timestamps (ms) of recoveries inside the current window, oldest first. */
  private attempts: number[] = [];

  constructor(options: RecoveryLoopGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxPerWindow = options.maxPerWindow ?? MAX_RECOVERIES_PER_WINDOW;
    this.windowMs = options.windowMs ?? RECOVERY_WINDOW_MS;
  }

  /** Drop timestamps that have fallen out of the current window. */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    if (this.attempts.length && this.attempts[0] <= cutoff) {
      this.attempts = this.attempts.filter((t) => t > cutoff);
    }
  }

  /** Number of recoveries recorded within the current sliding window. */
  recoveriesInWindow(): number {
    this.prune();
    return this.attempts.length;
  }

  /** True when another automatic recovery is still allowed in this window. */
  canRecover(): boolean {
    return this.recoveriesInWindow() < this.maxPerWindow;
  }

  /**
   * Atomically consume a recovery slot: if one is available, record the attempt
   * and return `true` (caller should proceed with recovery); otherwise return
   * `false` (the window is exhausted — stop auto-recovery, show ConnectionFailed).
   */
  tryConsume(): boolean {
    if (!this.canRecover()) return false;
    this.attempts.push(this.now());
    return true;
  }

  /** Clear the window — the manual "Try again" resets the counter. */
  reset(): void {
    this.attempts = [];
  }
}
