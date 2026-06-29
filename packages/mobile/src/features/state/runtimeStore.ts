/**
 * Runtime slice — client state.
 *
 * Socket-sourced ephemeral state (live tunnels / background tasks / Claude
 * sessions / host metrics) plus the active runtime view. This is NOT persisted —
 * it is rebuilt from the Socket.IO stream on each connect, so there is
 * nothing durable to write to either backend. (Navigation lives in Expo Router
 * for the native app — this slice carries
 * only the data + the active view/resource selection.)
 */

import type {
  ProcessData,
  RuntimeClaudeSessionPayload,
  RuntimeResource,
  RuntimeView,
  SandboxMetrics,
  TunnelData,
} from '@vgit2/shared/types';
import { create } from 'zustand';

export type ClaudeSessionData = RuntimeClaudeSessionPayload;

/** Atomic `user:runtime_state` snapshot — all arrays REPLACE the prior. */
export interface RuntimeSnapshot {
  tunnels: TunnelData[];
  processes: ProcessData[];
  /** Live Claude sessions. */
  claudeSessions: ClaudeSessionData[];
  /** Idle TTL after which a session is auto-reaped (ms); null when unknown. */
  claudeSessionIdleTtlMs: number | null;
}

export interface RuntimeState {
  tunnels: TunnelData[];
  /** Background tasks — Claude-SDK `run_in_background` bash (NOT a machine `ps`). */
  processes: ProcessData[];
  /** Live Claude sessions, keyed by their chatId order from the wire. */
  claudeSessions: ClaudeSessionData[];
  /** Idle TTL after which a session is auto-reaped (ms); null when unknown. */
  claudeSessionIdleTtlMs: number | null;
  /** Host CPU/RAM metrics (`sandbox:metrics`, emitted ~2s by HostMetricsService). */
  sandboxMetrics: SandboxMetrics | null;
  activeView: RuntimeView;
  activeResource: RuntimeResource | null;

  setTunnels: (tunnels: TunnelData[]) => void;
  setProcesses: (processes: ProcessData[]) => void;
  /** Optimistically drop a reaped/killed Claude session (`session:reaped`). */
  removeClaudeSession: (chatId: string) => void;
  setSandboxMetrics: (metrics: SandboxMetrics | null) => void;
  /** Apply a full `user:runtime_state` snapshot in a single update. */
  applySnapshot: (snapshot: RuntimeSnapshot) => void;
  setActiveView: (view: RuntimeView) => void;
  setActiveResource: (resource: RuntimeResource | null) => void;
  reset: () => void;
}

const initialRuntimeState = {
  tunnels: [] as TunnelData[],
  processes: [] as ProcessData[],
  claudeSessions: [] as ClaudeSessionData[],
  claudeSessionIdleTtlMs: null as number | null,
  sandboxMetrics: null as SandboxMetrics | null,
  activeView: 'overview' as RuntimeView,
  activeResource: null as RuntimeResource | null,
};

export const useRuntimeStore = create<RuntimeState>()((set, get) => ({
  ...initialRuntimeState,
  setTunnels: (tunnels) => set({ tunnels }),
  setProcesses: (processes) => set({ processes }),
  removeClaudeSession: (chatId) =>
    set({ claudeSessions: get().claudeSessions.filter((s) => s.chatId !== chatId) }),
  setSandboxMetrics: (sandboxMetrics) => set({ sandboxMetrics }),
  applySnapshot: ({ tunnels, processes, claudeSessions, claudeSessionIdleTtlMs }) =>
    set({ tunnels, processes, claudeSessions, claudeSessionIdleTtlMs }),
  setActiveView: (activeView) => set({ activeView }),
  setActiveResource: (activeResource) => set({ activeResource }),
  reset: () => set({ ...initialRuntimeState }),
}));
