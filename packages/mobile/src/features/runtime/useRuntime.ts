/**
 * useRuntime — the RuntimeBox ViewModel.
 *
 * Reads the socket-sourced `runtimeStore` (rebuilt per connect, fed by
 * `useNativeSocket`'s `user:runtime_state` / `sandbox:metrics` handlers) and
 * exposes the per-chat Claude-session kill emit. The socket is INJECTED
 * (the screen passes `useOptionalSocket()`), mirroring `useChatStream(socket, chatId)`.
 */

import { useCallback } from 'react';

import type { ProcessData } from '@vgit2/shared/types';

import type { NativeSocket } from '../socket';
import { useRuntimeStore } from '../state/runtimeStore';

/**
 * Defensive dedupe-by-id over the background tasks: the in-memory
 * `ProcessTrackerService` keys by id and `applySnapshot` REPLACES, so duplicates
 * shouldn't reach here — but a belt-and-braces uniq guarantees one row per id even
 * if a wire ever delivers the same id twice.
 */
function uniqById(processes: ProcessData[]): ProcessData[] {
  const seen = new Set<string>();
  return processes.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export function useRuntime(socket: NativeSocket | null) {
  const processesRaw = useRuntimeStore((s) => s.processes);
  const tunnels = useRuntimeStore((s) => s.tunnels);
  const claudeSessions = useRuntimeStore((s) => s.claudeSessions);
  const claudeSessionIdleTtlMs = useRuntimeStore((s) => s.claudeSessionIdleTtlMs);
  const sandboxMetrics = useRuntimeStore((s) => s.sandboxMetrics);

  /** `chat:kill-session` — user-initiated session termination. */
  const killSession = useCallback(
    (chatId: string): Promise<void> => {
      if (!socket) return Promise.resolve();
      return socket.emitters
        .killSession({ chatId })
        .then(() => undefined)
        .catch(() => undefined);
    },
    [socket]
  );

  return {
    tunnels,
    processes: uniqById(processesRaw),
    claudeSessions,
    claudeSessionIdleTtlMs,
    sandboxMetrics,
    killSession,
  };
}
