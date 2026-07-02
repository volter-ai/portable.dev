/**
 * useStopOnPc — the "Stop on PC" mutation (rev12 D59/D60).
 *
 * Asks the PC to stop a live TERMINAL `claude` session (the chat id IS the
 * Claude Code session id) via `POST /api/chat/:sessionId/stop-on-pc`. The
 * backend delivers the signal (sidecar or direct kill) and WAITS for evidence,
 * so the returned `stopped` is authoritative: `true` ⇒ the session ended and a
 * follow-up send will continue the SAME conversation here (adopt-on-first-write
 * bypasses the mtime guard on positive kill evidence); `false` ⇒ unconfirmed,
 * so a send would fork (never data loss).
 *
 * `mode` defaults to `end` (SIGTERM — fully ends the terminal session so the
 * hand-off adopts). `interrupt` (SIGINT) just stops the current turn.
 */
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { useOptionalApi } from '../api/ApiProvider';

/** Response of the stop-on-pc route (no shared type — local superset). */
export interface StopOnPcResponse {
  stopped: boolean;
  reason: string;
  via?: 'sidecar' | 'direct-kill';
}

export function useStopOnPc(
  chatId: string
): UseMutationResult<StopOnPcResponse, Error, { mode?: 'interrupt' | 'end' } | void> {
  // NON-throwing: the banner is mounted inside ActiveChatScreen, which can
  // render before the ApiProvider (mirroring `useOptionalSocket`). The mutation
  // is only fired on a button tap — by then the provider is present in the real
  // app; a missing client rejects with a clear error the banner surfaces.
  const api = useOptionalApi();
  return useMutation({
    mutationFn: async (vars) => {
      if (!api) throw new Error('Not connected to your PC.');
      const mode = (vars && 'mode' in vars ? vars.mode : undefined) ?? 'end';
      return api.post<StopOnPcResponse>(`/api/chat/${encodeURIComponent(chatId)}/stop-on-pc`, {
        mode,
      });
    },
  });
}
