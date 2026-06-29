/**
 * verifyTunnelAddress (token-validity hardening) — validate that a
 * PC is really reachable AND that the device token will actually be accepted,
 * before marking a connection ready.
 *
 * The app talks to its chosen PC over the stable relay endpoint
 * `<gatewayBase>/t/<pcId>` (the gateway reverse-proxies to the PC's current
 * cloudflared tunnel). Two checks happen here, in order:
 *
 *   1. **Liveness / 200+HTML discrimination** — a plain HTTP 200 is NOT proof of
 *      life: a dead tunnel's edge can keep answering `200` with an HTML page, and
 *      the relay deliberately does NOT inspect bodies. So we probe
 *      `GET /api/health` and accept ONLY the backend's real JSON `{ status: 'ok' }`
 *      body (`isHealthyHealthResponse`, shared with the steady-state monitor). A
 *      404 (`unknown pcId`) / 503 (`pc_offline`) / 200-HTML / network error → not
 *      ready.
 *   2. **Token validity (fail-fast)** — `/api/health` is a PUBLIC route on the PC
 *      (the launcher polls it tokenless), so a LIVE health check does NOT prove the
 *      pairing JWT is valid. A token minted with a different `JWT_SECRET` than the
 *      PC validates with (e.g. the api wasn't started by `portable start`) passes
 *      health but then 401s every real request — leaving the user on a broken home
 *      with no clue. So we additionally probe an AUTHED endpoint (`/api/user-settings`,
 *      a cheap local read behind the PC's `jwtMiddleware`): a `401`/`403` means the
 *      PC REJECTED the token → not ready (the caller surfaces a clear error and the
 *      user re-scans / fixes their PC). Any OTHER outcome (2xx/404/5xx/network) is
 *      NOT treated as a rejection — liveness already passed, so a flaky second
 *      request must never block a genuinely-valid token.
 *
 * Used by {@link connectToPc} to gate "ready"; a re-point on rotation
 * is automatic on the next request, so a transient failure just means "probe
 * again".
 */

import { isHealthyHealthResponse } from '@vgit2/shared/sandbox';

import { relayBaseForPc } from './connectedPcStore';

export interface VerifyTunnelAddressDeps {
  /** Injectable fetch (defaults to global fetch) — eases testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the relay health URL for a PC: `<gatewayBase>/t/<pcId>/api/health`.
 * Reuses {@link relayBaseForPc} (the SAME stable base `getRelayUrl()` resolves)
 * so the health probe can never target a different shape than the live data path.
 */
export function relayHealthUrl(gatewayBase: string, pcId: string): string {
  return `${relayBaseForPc(gatewayBase, pcId)}/api/health`;
}

/**
 * Build the relay AUTHED-probe URL: `<gatewayBase>/t/<pcId>/api/user-settings`.
 * A cheap local read behind the PC's `jwtMiddleware` — a `401`/`403` here proves
 * the device token is rejected (token-validity fail-fast, step 2 above).
 */
export function relayAuthCheckUrl(gatewayBase: string, pcId: string): string {
  return `${relayBaseForPc(gatewayBase, pcId)}/api/user-settings`;
}

/**
 * Validate `pcId` is reachable AND the device token is accepted. Returns `true`
 * only when (1) `GET /api/health` answered with a real `{ status: 'ok' }` body AND
 * (2) the authed probe did NOT come back `401`/`403`. Never throws.
 */
export async function verifyTunnelAddress(
  gatewayBase: string,
  pcId: string,
  deviceToken: string,
  deps: VerifyTunnelAddressDeps = {}
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${deviceToken}` };

  // 1. Liveness + 200-HTML discrimination.
  try {
    const url = relayHealthUrl(gatewayBase, pcId);
    console.warn('[QRDBG] verify health GET', url);
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      // Never send or store cookies (parity with GatewayClient).
      credentials: 'omit',
    });
    const ok = await isHealthyHealthResponse(res.clone ? res.clone() : res);
    console.warn('[QRDBG] verify health status=', res.status, 'isHealthy=', ok);
    if (!ok) return false;
  } catch (e) {
    console.warn('[QRDBG] verify health THREW:', String((e as Error)?.message ?? e));
    // A transport blip is "not yet ready", never a hard failure — the caller
    // re-probes (rotation re-points automatically).
    return false;
  }

  // 2. Token validity (fail-fast). The PC is live; only a clear 401/403 here means
  // it REJECTED the pairing JWT (e.g. a JWT_SECRET mismatch). Anything else is not
  // a rejection — never block a valid token on a flaky second request.
  try {
    const authed = await fetchImpl(relayAuthCheckUrl(gatewayBase, pcId), {
      method: 'GET',
      headers,
      credentials: 'omit',
    });
    if (authed.status === 401 || authed.status === 403) return false;
  } catch {
    // Liveness already passed; a transport error on the authed probe is not a
    // token rejection.
  }
  return true;
}
