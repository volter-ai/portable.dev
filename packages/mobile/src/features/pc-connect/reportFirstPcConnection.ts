/**
 * Report the first successful PC connection to the gateway.
 *
 * On the FIRST time this device points the app at a given PC (`connectToPc` →
 * `ready`), the gateway upserts the user's `user_attribution` row and stamps
 * `first_use_at` / `first_pc_connection_at` — the local-first activation signal
 * that replaced the old "sandbox provisioned" event. The report is:
 *
 *   - Bearer-authenticated: the gateway derives the userId + email from the
 *     VERIFIED authToken, never the body (the client only sends `{ pcId }`).
 *   - One-shot per pcId: a {@link useFirstPcConnectionStore} MMKV flag stops a
 *     healthy reconnect from re-firing it every launch (the server is idempotent
 *     too, but this avoids a pointless request).
 *   - Fire-and-forget + best-effort: resolves `false` on ANY failure (already
 *     reported / no token / network / non-2xx) and NEVER throws, so the caller
 *     ({@link connectToPc}) can fire it without blocking or failing `ready`.
 */

import { GatewayClient } from '../../services/gatewayClient';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { getAuthToken } from '../auth/secureAuthStore';

import { useFirstPcConnectionStore } from './firstPcConnectionStore';

export interface ReportFirstPcConnectionDeps {
  /** Injectable gateway client (defaults to one built from the live gateway URL). */
  gateway?: Pick<GatewayClient, 'reportFirstPcConnection'>;
  /** Injectable authToken reader (defaults to SecureStore `getAuthToken`). */
  getToken?: () => Promise<string | null>;
  /** One-shot guard read (defaults to the MMKV flag store). */
  hasReported?: (pcId: string) => boolean;
  /** One-shot guard write (defaults to the MMKV flag store). */
  markReported?: (pcId: string) => void;
}

export async function reportFirstPcConnection(
  pcId: string,
  deps: ReportFirstPcConnectionDeps = {}
): Promise<boolean> {
  const hasReported =
    deps.hasReported ?? ((id: string) => useFirstPcConnectionStore.getState().hasReported(id));
  const markReported =
    deps.markReported ?? ((id: string) => useFirstPcConnectionStore.getState().markReported(id));
  const getToken = deps.getToken ?? getAuthToken;

  // One-shot per pcId — a healthy reconnect must not re-fire the activation report.
  try {
    if (hasReported(pcId)) return false;
  } catch {
    // A broken guard store must never wedge the connect; fall through and try once.
  }

  let token: string | null;
  try {
    token = await getToken();
  } catch {
    return false;
  }
  if (!token) return false;

  const gateway = deps.gateway ?? new GatewayClient({ gatewayUrl: getGatewayUrl() });
  try {
    await gateway.reportFirstPcConnection(token, { pcId });
  } catch {
    // Best-effort: leave the guard UNSET so the next connect retries.
    return false;
  }

  // Latch one-and-done only AFTER a successful report.
  try {
    markReported(pcId);
  } catch {
    /* a failed guard write just means a harmless idempotent re-report later */
  }
  return true;
}
