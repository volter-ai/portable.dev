import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import type { SandboxMetrics } from '@vgit2/shared/types';

const DEFAULT_INTERVAL_MS = 2000;
const WORKSPACE_RECOMPUTE_EVERY_TICKS = 15; // ~30s at 2s ticks
const WORKSPACE_SIZE_DEADLINE_MS = 1200; // best-effort time budget for the dir walk

type CpuInfoList = ReturnType<typeof os.cpus>;

interface CpuSnapshot {
  idle: number;
  total: number;
}

export interface HostMetricsDeps {
  /** Broadcast one metrics sample (wired to `SocketIOService.broadcastSandboxMetrics`). */
  emit: (metrics: SandboxMetrics) => void;
  /** Workspace dir to size (best-effort, cached). Omitted → `workspaceSizeGB` stays 0. */
  workspaceDir?: string;
  /** Sample/emit interval in ms (default 2000). */
  intervalMs?: number;
  // Injectable seams for deterministic unit tests (default to Node built-ins):
  cpus?: () => CpuInfoList;
  totalmem?: () => number;
  freemem?: () => number;
  uptime?: () => number;
  now?: () => number;
  /** Workspace-size reader in bytes (default: a bounded recursive fs walk). */
  workspaceSize?: (dir: string) => Promise<number>;
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * HostMetricsService — local-first PC CPU / RAM / uptime collector (rev11).
 *
 * Revives the Runtime panel's Metrics card. The cloud `SandboxMetricsService` was
 * deleted in the local-first pivot (rev7 / E2), so NOTHING emitted `sandbox:metrics`
 * and the card sat on "Loading metrics…" forever. This rebuilds it on Node built-ins
 * only (no new dep, works on Linux / macOS / Windows):
 *  - CPU% via an `os.cpus()` busy/total **delta** across the sample interval —
 *    stateful, so the first tick has no baseline and emits 0%.
 *  - RAM% via `os.totalmem()/os.freemem()` (host free-vs-total; on macOS `freemem`
 *    excludes reclaimable cache, so "used" reads higher than Activity Monitor).
 *  - workspace size via a best-effort, time-bounded dir walk (cached, recomputed
 *    every ~30s, never blocks the emit).
 *  - `process.uptime()` for uptime.
 *
 * `os.loadavg()` is deliberately NOT used (`[0,0,0]` on Windows). Emits ~2s through
 * the injected broadcast seam (no-op when no client is connected). This is purely
 * the informational gauge — NOT the removed sandbox memory-WATCHDOG (no auto-kill on
 * a personal PC; the soft warn-only guard stays deferred, OQ-09).
 */
export class HostMetricsService {
  private readonly deps: HostMetricsDeps;
  private readonly intervalMs: number;
  private readonly cpus: () => CpuInfoList;
  private readonly totalmem: () => number;
  private readonly freemem: () => number;
  private readonly uptime: () => number;
  private readonly now: () => number;
  private readonly readWorkspaceSize: (dir: string) => Promise<number>;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private prevCpu: CpuSnapshot | null = null;
  private workspaceSizeBytes = 0;
  private workspaceSizeInFlight = false;
  private tickCount = 0;

  constructor(deps: HostMetricsDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cpus = deps.cpus ?? (() => os.cpus());
    this.totalmem = deps.totalmem ?? (() => os.totalmem());
    this.freemem = deps.freemem ?? (() => os.freemem());
    this.uptime = deps.uptime ?? (() => process.uptime());
    this.now = deps.now ?? (() => Date.now());
    this.readWorkspaceSize =
      deps.workspaceSize ??
      ((dir) => dirSizeBytes(dir, this.now() + WORKSPACE_SIZE_DEADLINE_MS, this.now));
    this.setIntervalImpl = deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = deps.clearIntervalImpl ?? ((h) => clearInterval(h));
  }

  start(): void {
    if (this.timer) return;
    // Seed the CPU baseline so the FIRST emitted tick already carries a real delta.
    this.prevCpu = this.cpuSnapshot();
    // Kick the first (async, best-effort) workspace-size computation.
    void this.recomputeWorkspaceSize();
    this.timer = this.setIntervalImpl(() => this.tick(), this.intervalMs);
    // Don't keep the process alive just for metrics (Node Timeout / Bun Timer).
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  /** One sample → emit. Public so unit tests can drive ticks without a real timer. */
  tick(): void {
    const sample = this.sample();
    this.tickCount += 1;
    if (this.tickCount % WORKSPACE_RECOMPUTE_EVERY_TICKS === 0) {
      void this.recomputeWorkspaceSize();
    }
    try {
      this.deps.emit(sample);
    } catch {
      // A broken emit must never crash the metrics loop.
    }
  }

  /** Compute one metrics sample (also advances the CPU delta baseline). */
  sample(): SandboxMetrics {
    const coreCount = Math.max(1, this.cpus().length);
    const cpuPercent = this.cpuUsagePercent();
    const total = this.totalmem();
    const free = this.freemem();
    const usedBytes = Math.max(0, total - free);
    const memoryUsedMB = Math.round(usedBytes / (1024 * 1024));
    const memoryLimitMB = Math.round(total / (1024 * 1024));
    const memoryPercent = total > 0 ? (usedBytes / total) * 100 : 0;
    return {
      cpuUsagePercent: cpuPercent,
      cpuCores: (cpuPercent / 100) * coreCount,
      cpuLimitCores: coreCount,
      memoryUsedMB,
      memoryLimitMB,
      memoryPercent,
      workspaceSizeGB: this.workspaceSizeBytes / (1024 * 1024 * 1024),
      uptimeSeconds: Math.round(this.uptime()),
    };
  }

  private cpuSnapshot(): CpuSnapshot {
    let idle = 0;
    let total = 0;
    for (const cpu of this.cpus()) {
      for (const value of Object.values(cpu.times)) total += value;
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  private cpuUsagePercent(): number {
    const cur = this.cpuSnapshot();
    const prev = this.prevCpu;
    this.prevCpu = cur;
    if (!prev) return 0;
    const idleDelta = cur.idle - prev.idle;
    const totalDelta = cur.total - prev.total;
    if (totalDelta <= 0) return 0;
    const pct = (1 - idleDelta / totalDelta) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  private async recomputeWorkspaceSize(): Promise<void> {
    const dir = this.deps.workspaceDir;
    if (!dir || this.workspaceSizeInFlight) return;
    this.workspaceSizeInFlight = true;
    try {
      this.workspaceSizeBytes = await this.readWorkspaceSize(dir);
    } catch {
      // best-effort — keep the last cached value.
    } finally {
      this.workspaceSizeInFlight = false;
    }
  }
}

/**
 * Best-effort recursive directory size in bytes, bounded by a wall-clock
 * `deadlineMs` (a huge workspace — node_modules, clones — must never block the
 * event loop). Symlinks are skipped (no cycles / no double counting); unreadable
 * entries are silently skipped.
 */
async function dirSizeBytes(dir: string, deadlineMs: number, now: () => number): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    if (now() > deadlineMs) break;
    const current = stack.pop() as string;
    try {
      // `{ withFileTypes: true }` → Dirent[] (string names); inferred so the
      // overload resolves correctly (an explicit annotation picks the Buffer one).
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(full);
            total += stat.size;
          } catch {
            // skip unreadable file
          }
        }
      }
    } catch {
      // skip unreadable dir
    }
  }
  return total;
}
