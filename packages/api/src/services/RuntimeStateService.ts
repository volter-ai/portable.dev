import { getClaudeSessionIdleTtlMs } from './SessionReaperService.js';

import type { IOutputEmitter } from './emitters/IOutputEmitter.js';
import type { ExternalClaudeSessionService } from './ExternalClaudeSessionService.js';
import type { RuntimeStateFormatter } from './RuntimeStateFormatter.js';
import type { TunnelService } from './TunnelService.js';
import type { RuntimeClaudeSessionPayload } from '@vgit2/shared/types';

/** Minimal slice of ClaudeService used to surface live sessions. */
interface ClaudeSessionProvider {
  getClaudeSessionInfos(userId: string): RuntimeClaudeSessionPayload[];
}

/**
 * RuntimeStateService
 *
 * Collects and broadcasts runtime state (tunnels, processes).
 * Extracts runtime state logic from SocketIOService for better separation of concerns.
 *
 * Runtime state includes:
 * - Active Cloudflare tunnels (for dev servers)
 * - Active background processes
 */
export class RuntimeStateService {
  constructor(
    private tunnelService?: TunnelService,
    private processTrackerService?: any, // ProcessTrackerService
    private runtimeStateFormatter?: RuntimeStateFormatter,
    private claudeService?: ClaudeSessionProvider, // live Claude sessions
    // rev12: TERMINAL `claude` sessions on this PC (hook-fed presence registry)
    private externalClaudeSessionService?: ExternalClaudeSessionService
  ) {
    console.log('[RuntimeStateService] Initialized');
  }

  /**
   * TERMINAL sessions folded into the same claudeSessions array as the
   * api-spawned ones, tagged `origin: 'terminal'` (rev12 D55). A terminal
   * session's chatId is its Claude Code session id (== the discovered chat's
   * id, the client's badge join key). Sessions whose id collides with an
   * api-spawned entry are dropped — an adopted chat that the api is currently
   * running must not appear twice (the registry row from its terminal era can
   * lag behind reality).
   */
  private collectExternalSessions(
    apiSessions: RuntimeClaudeSessionPayload[]
  ): RuntimeClaudeSessionPayload[] {
    if (!this.externalClaudeSessionService) return [];
    try {
      const apiChatIds = new Set(apiSessions.map((s) => s.chatId));
      const now = Date.now();
      return this.externalClaudeSessionService
        .getLiveSessions(now)
        .filter((s) => !apiChatIds.has(s.sessionId))
        .map((s) => ({
          chatId: s.sessionId,
          repoPath: s.cwd || undefined,
          status: (s.state === 'live-running' ? 'running' : 'idle') as 'running' | 'idle',
          isProcessing: s.state === 'live-running',
          lastActivityAt: s.updatedAt,
          idleMs: s.state === 'live-running' ? 0 : Math.max(0, now - s.updatedAt),
          resumable: true,
          origin: 'terminal' as const,
        }));
    } catch (error) {
      console.error('[RuntimeStateService] external session collection failed:', error);
      return [];
    }
  }

  /**
   * Get runtime state for a user
   * @param userId - User email (acts as user ID)
   * @returns Runtime state object
   */
  async getRuntimeState(userId: string): Promise<any> {
    try {
      // Collect active tunnels
      const tunnels = this.tunnelService?.getUserTunnels(userId) || [];

      // Collect active background processes
      const backgroundProcesses =
        this.processTrackerService.getAllProcesses().filter((p: any) => p.userId === userId) || [];

      // Collect live Claude sessions: api-spawned (origin 'portable') + the
      // PC's terminal sessions (origin 'terminal', rev12 presence registry).
      const apiSessions = (this.claudeService?.getClaudeSessionInfos(userId) ?? []).map((s) => ({
        ...s,
        origin: s.origin ?? ('portable' as const),
      }));
      const claudeSessions = [...apiSessions, ...this.collectExternalSessions(apiSessions)];

      // Only return state if there's something active
      if (tunnels.length === 0 && backgroundProcesses.length === 0 && claudeSessions.length === 0) {
        return null;
      }

      // Format tunnels
      const formattedTunnels = tunnels.map((tunnel) => ({
        port: tunnel.port,
        url: tunnel.url,
        name: tunnel.name,
        description: tunnel.description,
        main: tunnel.main,
        createdAt: tunnel.createdAt,
        active: tunnel.active,
        createdByChatId: tunnel.createdByChatId,
        createdByRepoPath: tunnel.createdByRepoPath,
      }));

      // Format processes
      const formattedProcesses = backgroundProcesses.map((proc: any) => {
        // Get cached output if available
        const cachedOutput = this.processTrackerService.getCachedOutput(proc.id);
        return {
          id: proc.id,
          command: proc.command,
          description: proc.description,
          chatId: proc.chatId,
          repoPath: proc.repoPath,
          status: proc.status,
          startedAt: proc.startedAt,
          isRefreshing: proc.isRefreshing || false,
          lastOutputUpdate: proc.lastOutputUpdate,
          outputFilePath: proc.outputFilePath,
          stdout: cachedOutput?.stdout || '',
          stderr: cachedOutput?.stderr || '',
        };
      });

      return {
        tunnels: formattedTunnels,
        backgroundProcesses: formattedProcesses,
        claudeSessions,
        claudeSessionIdleTtlMs: getClaudeSessionIdleTtlMs(),
      };
    } catch (error) {
      console.error(`[RuntimeStateService] Error collecting runtime state for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Check if user has any active runtime resources
   * @param userId - User email (acts as user ID)
   * @returns true if user has active sessions, tunnels, or processes
   */
  async hasActiveRuntimeState(userId: string): Promise<boolean> {
    const state = await this.getRuntimeState(userId);
    return state !== null;
  }

  /**
   * A well-formed EMPTY runtime-state snapshot (all arrays empty). Used so a
   * broadcast ALWAYS sends a full snapshot the client can converge on — even when
   * nothing is active — instead of sending nothing. Without this, after a restart
   * (or any drop to zero resources) `getRuntimeState` returns `null`, the broadcast
   * is skipped, and the client keeps its LAST non-empty snapshot forever — leaving a
   * dead tunnel/preview "stuck" in the runtime (the stale `*.trycloudflare.com` →
   * Cloudflare Bad Gateway bug). The shape mirrors `getRuntimeState`'s wire payload.
   */
  buildEmptyRuntimeState(): {
    tunnels: never[];
    backgroundProcesses: never[];
    claudeSessions: never[];
    claudeSessionIdleTtlMs: number;
  } {
    return {
      tunnels: [],
      backgroundProcesses: [],
      claudeSessions: [],
      claudeSessionIdleTtlMs: getClaudeSessionIdleTtlMs(),
    };
  }

  /**
   * Runtime state for BROADCAST — never null. Returns the live snapshot, or the
   * empty snapshot when nothing is active, so every send overwrites the client's
   * view (clearing stale sessions/tunnels/processes). Use this for all client
   * broadcasts; keep {@link getRuntimeState} (nullable) for `hasActiveRuntimeState`.
   */
  async getRuntimeStateForBroadcast(userId: string): Promise<any> {
    const state = await this.getRuntimeState(userId);
    return state ?? this.buildEmptyRuntimeState();
  }

  /**
   * Broadcast runtime state to user via emitter
   * @param userId - User email (acts as user ID)
   * @param emitter - Output emitter (SocketEmitter or NoOpEmitter)
   */
  async broadcastRuntimeState(userId: string, emitter: IOutputEmitter): Promise<void> {
    try {
      // ALWAYS broadcast a full snapshot (empty when nothing is active) so the
      // client converges on the truth and never keeps a stale (dead) tunnel.
      const runtimeState = await this.getRuntimeStateForBroadcast(userId);

      console.log(`[RuntimeStateService] Broadcasting runtime state to ${userId}:`, {
        tunnels: runtimeState.tunnels.length,
        backgroundProcesses: runtimeState.backgroundProcesses.length,
        claudeSessions: runtimeState.claudeSessions?.length ?? 0,
      });

      // Use emitter to broadcast (works for both Socket.IO and headless)
      if (emitter.emitToUser) {
        emitter.emitToUser(userId, 'user:runtime_state', runtimeState);
      }
    } catch (error) {
      console.error(`[RuntimeStateService] Error broadcasting runtime state to ${userId}:`, error);
    }
  }
}
