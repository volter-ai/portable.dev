/**
 * HostMetricsService Unit Tests (rev11).
 *
 * The local-first host CPU/RAM/uptime collector that revives the Runtime panel
 * Metrics card. All I/O is injected (cpus / totalmem / freemem / uptime / now /
 * workspace / timer), so the delta-sampled CPU%, the freemem-derived RAM%, and the
 * cached workspace size are asserted deterministically with NO real timers and NO
 * real `os` reads. `os.loadavg()` is intentionally never used (`[0,0,0]` on Windows)
 * — the key-set assertion below pins the reshaped local-first SandboxMetrics shape.
 */

import { describe, it, expect } from 'bun:test';

import {
  HostMetricsService,
  type HostMetricsDeps,
} from '../../../src/services/HostMetricsService.js';

const GB = 1024 * 1024 * 1024;

/** A CpuInfo[] with `busy` non-idle ticks + `idle` idle ticks per core. */
function cpus(idle: number, busy: number, cores = 2) {
  return Array.from({ length: cores }, () => ({
    model: 'test',
    speed: 2400,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

interface Harness {
  svc: HostMetricsService;
  emitted: ReturnType<HostMetricsService['sample']>[];
  setCpus: (c: ReturnType<typeof cpus>) => void;
  runTick: () => void;
  hasTimer: () => boolean;
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function harness(overrides: Partial<HostMetricsDeps> = {}): Harness {
  const emitted: ReturnType<HostMetricsService['sample']>[] = [];
  let cpuState = cpus(100, 0); // baseline: fully idle (2 cores → idle 200 / total 200)
  let tickFn: (() => void) | null = null;
  const deps: HostMetricsDeps = {
    emit: (m) => emitted.push(m),
    workspaceDir: '/ws',
    cpus: () => cpuState,
    totalmem: () => 2 * GB,
    freemem: () => 1 * GB,
    uptime: () => 120,
    now: () => 1_000_000,
    workspaceSize: async () => 3 * GB,
    setIntervalImpl: (fn) => {
      tickFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalImpl: () => {
      tickFn = null;
    },
    ...overrides,
  };
  const svc = new HostMetricsService(deps);
  return {
    svc,
    emitted,
    setCpus: (c) => {
      cpuState = c;
    },
    runTick: () => tickFn?.(),
    hasTimer: () => tickFn !== null,
  };
}

describe('HostMetricsService', () => {
  it('delta-samples CPU% (100% when all idle ticks turn busy across the interval)', async () => {
    const h = harness();
    h.svc.start(); // seeds the baseline (idle 200 / total 200)
    await flush();
    h.setCpus(cpus(100, 100)); // +100 busy ticks per core, idle unchanged → 100% busy
    h.runTick();
    const m = h.emitted.at(-1)!;
    expect(m.cpuUsagePercent).toBe(100);
    expect(m.cpuLimitCores).toBe(2);
    expect(m.cpuCores).toBeCloseTo(2, 5);
  });

  it('reports a half-busy delta as ~50% CPU', async () => {
    const h = harness();
    h.svc.start();
    await flush();
    h.setCpus(cpus(200, 100)); // idle +100, busy +100 → 50% busy
    h.runTick();
    expect(h.emitted.at(-1)!.cpuUsagePercent).toBeCloseTo(50, 5);
  });

  it('emits 0% on the first sample (no baseline yet)', () => {
    const h = harness();
    // sample() with no start() → prevCpu null → 0% (and seeds the baseline).
    expect(h.svc.sample().cpuUsagePercent).toBe(0);
  });

  it('derives RAM% from totalmem/freemem (host free-vs-total)', async () => {
    const h = harness();
    h.svc.start();
    await flush();
    h.runTick();
    const m = h.emitted.at(-1)!;
    expect(m.memoryLimitMB).toBe(2048);
    expect(m.memoryUsedMB).toBe(1024);
    expect(m.memoryPercent).toBeCloseTo(50, 5);
  });

  it('carries the cached workspace size + process uptime', async () => {
    const h = harness();
    h.svc.start();
    await flush(); // the start() workspace recompute (3 GB) resolves
    h.runTick();
    const m = h.emitted.at(-1)!;
    expect(m.workspaceSizeGB).toBeCloseTo(3, 5);
    expect(m.uptimeSeconds).toBe(120);
  });

  it('emits ONLY the reshaped local-first fields (no planTier/maxLagMs/startedAt/loadavg)', async () => {
    const h = harness();
    h.svc.start();
    await flush();
    h.runTick();
    expect(Object.keys(h.emitted.at(-1)!).sort()).toEqual([
      'cpuCores',
      'cpuLimitCores',
      'cpuUsagePercent',
      'memoryLimitMB',
      'memoryPercent',
      'memoryUsedMB',
      'uptimeSeconds',
      'workspaceSizeGB',
    ]);
  });

  it('start() is idempotent; stop() clears the timer', () => {
    const h = harness();
    h.svc.start();
    expect(h.hasTimer()).toBe(true);
    h.svc.start(); // no-op (already running)
    h.svc.stop();
    expect(h.hasTimer()).toBe(false);
  });

  it('a throwing emit never crashes the tick loop', () => {
    const h = harness({
      emit: () => {
        throw new Error('boom');
      },
    });
    h.svc.start();
    expect(() => h.runTick()).not.toThrow();
  });
});
