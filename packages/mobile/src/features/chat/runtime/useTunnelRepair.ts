/**
 * useTunnelRepair — lazy, on-demand repair of a dead dev-server preview tunnel.
 *
 * A per-port preview is reachable only through its `*.trycloudflare.com` Quick
 * Tunnel, which dies whenever its `cloudflared` child dies (PC/dev restart, the
 * free tunnel flapping, the PC dropping its network) — after which Cloudflare's
 * edge answers a Bad Gateway. Rather than mass-reopening, the embedded preview
 * (Android `react-native-webview`) reports the load error and we re-create ONLY
 * that one tunnel; the fresh URL arrives via the `user:runtime_state` broadcast and
 * the embed reloads itself (single source of truth — we never locally patch the
 * URL). iOS opens the system browser, which the app can't observe, so there is no
 * iOS repair path here — but layers A (always re-broadcast a full snapshot) and B
 * (evict a tunnel the instant its cloudflared child dies) clear a dead tunnel on
 * the next reconnect, so the bubble won't offer a stale preview in the first place.
 *
 * Safety: repairs are bounded (`MAX_REPAIR_ATTEMPTS`) and de-duped per URL so a
 * tunnel that stays dead can never loop; every failure degrades gracefully
 * (`failed` / `dev_server_down`) and the hook never throws.
 */

import type { TunnelData, TunnelRepairResult } from '@vgit2/shared/types';
import { useCallback, useRef, useState } from 'react';

import { useOptionalApi } from '../../api/ApiProvider';

/** Max repair attempts per hook instance — bounds any retry loop. */
export const MAX_REPAIR_ATTEMPTS = 2;

export type TunnelRepairStatus = 'idle' | 'repairing' | 'dev_server_down' | 'failed';

function repairBody(tunnel: TunnelData): Record<string, unknown> {
  return {
    port: tunnel.port,
    chatId: tunnel.createdByChatId,
    repoPath: tunnel.createdByRepoPath,
    name: tunnel.name,
    main: tunnel.main,
  };
}

export function useTunnelRepair() {
  const api = useOptionalApi();

  const [status, setStatus] = useState<TunnelRepairStatus>('idle');
  const inFlightRef = useRef(false);
  const attemptsRef = useRef(0);
  const attemptedUrlsRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    inFlightRef.current = false;
    attemptsRef.current = 0;
    attemptedUrlsRef.current = new Set();
    setStatus('idle');
  }, []);

  /**
   * Ask the PC to re-create this tunnel. Returns the result (or null when it
   * couldn't run). Bounded + de-duped so a persistently-dead tunnel never loops.
   */
  const repair = useCallback(
    async (tunnel: TunnelData): Promise<TunnelRepairResult | null> => {
      if (!api) return null;
      if (inFlightRef.current) return null;
      if (attemptedUrlsRef.current.has(tunnel.url) || attemptsRef.current >= MAX_REPAIR_ATTEMPTS) {
        setStatus('failed');
        return null;
      }
      inFlightRef.current = true;
      attemptedUrlsRef.current.add(tunnel.url);
      attemptsRef.current += 1;
      setStatus('repairing');
      try {
        const result = await api.post<TunnelRepairResult>(
          '/api/tunnels/repair',
          repairBody(tunnel)
        );
        setStatus(result.status === 'dev_server_down' ? 'dev_server_down' : 'idle');
        return result;
      } catch {
        setStatus('failed');
        return null;
      } finally {
        inFlightRef.current = false;
      }
    },
    [api]
  );

  /** Android embed reported a load error — repair this one tunnel (fire-and-forget). */
  const handleEmbedError = useCallback(
    (tunnel: TunnelData): void => {
      void repair(tunnel);
    },
    [repair]
  );

  return { status, repair, handleEmbedError, reset };
}
