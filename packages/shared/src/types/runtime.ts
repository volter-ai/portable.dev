/**
 * Runtime types - tunnels, processes
 */

// ============================================================================
// TUNNEL DATA
// ============================================================================

export interface TunnelData {
  port: number;
  url: string;
  name: string;
  description?: string;
  main?: boolean;
  createdAt: number;
  active?: boolean;
  createdByChatId?: string;
  createdByRepoPath?: string;
}

/**
 * Result of a lazy, on-demand tunnel repair (mobile "touch a dead preview →
 * re-create + reload" flow). A per-port dev-server Quick Tunnel
 * (`*.trycloudflare.com`) dies whenever its `cloudflared` child dies — a PC/dev
 * restart, the free tunnel flapping, or the PC dropping its network — and then
 * Cloudflare's edge answers a Bad Gateway. Repair is keyed by PORT and is one of:
 * - `repaired`        — the dev server is still listening, so a FRESH tunnel was
 *                       spawned; `url` is the new `*.trycloudflare.com` to reload.
 * - `dev_server_down` — nothing is listening on the port (the dev server stopped
 *                       too), so there is nothing to tunnel; the stale tunnel was
 *                       cleared. The client should prompt to restart the dev server
 *                       instead of showing a confusing Cloudflare error page.
 */
export type TunnelRepairResult =
  | { status: 'repaired'; port: number; url: string }
  | { status: 'dev_server_down'; port: number };

// ============================================================================
// PROCESS DATA
// ============================================================================

export interface ProcessData {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  description?: string;
  startedAt: number;
  chatId: string;
  repoPath?: string;
  outputFilePath?: string;
  stdout?: string;
  stderr?: string;
}

// ============================================================================
// CLAUDE SESSION DATA (chat process lifecycle)
// ============================================================================

/**
 * Lifecycle status of a live Claude session as surfaced in the runtime panel.
 * - `running`  — actively generating a response (subprocess busy).
 * - `waiting`  — paused awaiting a user permission decision (subprocess alive).
 * - `idle`     — alive between turns, waiting for the next message (reap target).
 *
 * Only sessions holding a LIVE subprocess (query + inputQueue) are surfaced —
 * a fully-torn-down chat retains only a `session_id` string and is omitted.
 */
export type ClaudeSessionStatus = 'running' | 'idle' | 'waiting';

/**
 * Where a live Claude session runs (rev12 cross-surface presence):
 * - `portable` — spawned by the Portable api (the Agent SDK subprocess).
 * - `terminal` — the user's own terminal `claude` on the PC, observed via the
 *   launcher-installed lifecycle hooks. For these, `chatId` is the Claude Code
 *   SESSION id — which is also the discovered chat's id, so clients join the
 *   presence badge to a chat row by plain id equality.
 */
export type ClaudeSessionOrigin = 'portable' | 'terminal';

/** One live Claude session as it appears on the `user:runtime_state` wire. */
export interface RuntimeClaudeSessionPayload {
  /** Owning chat id (also the resume key). */
  chatId: string;
  /** Workspace repo path the session runs against (clients derive owner/repo). */
  repoPath?: string;
  status: ClaudeSessionStatus;
  /** True while Claude is actively generating (status `running`/`waiting`). */
  isProcessing: boolean;
  /** Epoch ms of the last activity (turn start/complete); 0 if never recorded. */
  lastActivityAt: number;
  /** `now - lastActivityAt` at serialization for `idle` sessions; 0 otherwise. */
  idleMs: number;
  /** True when the session has a `session_id` and can be transparently resumed. */
  resumable: boolean;
  /**
   * Session origin (rev12). Absent on older payloads — treat as `portable`
   * (the pre-rev12 wire only ever carried api-spawned sessions).
   */
  origin?: ClaudeSessionOrigin;
}

/**
 * A command delivered over the mcp-sidecar channel (rev12 D58/D59) — the api
 * pushes it to the `portable mcp-sidecar` child of a terminal `claude`
 * session; the sidecar signals its parent CLI.
 */
export interface SidecarCommand {
  command: 'stop';
  /** `interrupt` (SIGINT, ≈ Ctrl+C) or `end` (SIGTERM). */
  mode: 'interrupt' | 'end';
}

// ============================================================================
// RUNTIME RESOURCE
// ============================================================================

export interface RuntimeResource {
  type: 'tunnel' | 'process';
  id: string;
}

// ============================================================================
// RUNTIME VIEW & MODE
// ============================================================================

export type RuntimeView = 'overview' | 'tunnels' | 'processes' | 'storage';
export type RuntimeMode = 'overlay' | 'full-page';

// ============================================================================
// HOST METRICS (CPU / RAM / uptime — emitted ~2s by the PC HostMetricsService)
// ============================================================================

/**
 * Local-first host metrics for the Runtime panel. Reshaped from the cloud
 * sandbox shape: no plan limits / event-loop lag / `startedAt` /
 * `planTier`. `cpuLimitCores` is the machine's physical cores, `memoryLimitMB`
 * is total host RAM. RAM is host free-vs-total (`os.freemem()` excludes
 * reclaimable cache, so it reads higher than Activity Monitor — not "pressure").
 */
export interface SandboxMetrics {
  cpuUsagePercent: number; // host CPU busy % (os.cpus() busy/total delta)
  cpuCores: number; // approx cores in use (cpuUsagePercent/100 * cpuLimitCores)
  cpuLimitCores: number; // physical cores (os.cpus().length)
  memoryUsedMB: number; // host RAM used (totalmem - freemem)
  memoryLimitMB: number; // total host RAM (os.totalmem())
  memoryPercent: number; // (usedMB / limitMB) * 100 — host free-vs-total
  workspaceSizeGB: number; // total size of WORKSPACE_DIR (best-effort, cached)
  uptimeSeconds: number; // process.uptime()
}
