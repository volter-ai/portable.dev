/**
 * connectToPc — connect to an already-linked PC, no QR.
 *
 * Once a device holds a device token for `pcId` ({@link linkPc} persisted it),
 * reconnecting needs no QR: read the stored token, then **body-validate** the PC
 * is really reachable via {@link verifyTunnelAddress} (`GET /api/health` through
 * the relay over TLS, accepting only the real `{ status: 'ok' }` body — the app
 * does the 200+HTML discrimination, the relay does not) before marking ready.
 *
 * Returns a structured result rather than throwing so the picker can branch:
 *   - `no-token`  → this device never linked `pcId` (fall back to the QR scanner).
 *   - `unhealthy` → linked, but the PC isn't answering (re-probe / re-pick — a
 *     rotation re-points automatically on the next request).
 *   - ready       → the app is now POINTED at this PC (the connected pcId is
 *     persisted, so `getRelayUrl()` resolves the stable base
 *     `<gatewayBase>/t/<pcId>` and the Socket.IO/`/api/*` traffic routes through
 *     the relay).
 *
 * Marking `ready` persists the chosen PC ({@link saveConnectedPcId}) — that IS the
 * "render the app against the PC" wiring: every existing consumer reads the stable
 * base through `getRelayUrl()`. Picking another PC just calls this again. All I/O
 * is injectable.
 */

import { saveConnectedPcId } from './connectedPcStore';
import { getDeviceToken } from './deviceTokenStore';
import { verifyTunnelAddress } from './verifyTunnelAddress';

export interface ConnectToPcDeps {
  /** Base URL of the online relay gateway (the stable per-PC endpoint host). */
  gatewayBase: string;
  /** Seam: read the stored device token. Defaults to {@link getDeviceToken}. */
  getToken?: (pcId: string) => Promise<string | null>;
  /**
   * Seam: body-validate the PC is reachable. Defaults to
   * {@link verifyTunnelAddress} over `<gatewayBase>/t/<pcId>/api/health`.
   */
  verify?: (gatewayBase: string, pcId: string, deviceToken: string) => Promise<boolean>;
  /**
   * Seam: point the app at this PC on success (persist the connected pcId).
   * Defaults to {@link saveConnectedPcId}.
   */
  setConnectedPc?: (pcId: string) => Promise<void>;
  /**
   * Seam: report the first successful PC connection to the gateway. Fired
   * FIRE-AND-FORGET on the `ready` path AFTER the connected pcId is persisted — it
   * is one-shot-guarded per pcId on-device and must NEVER block or fail the
   * `{ ready: true }` return. Default: a lazy-required gateway report (the
   * `disconnectPc` pattern) so the gateway + MMKV-guard graph stays OUT of this
   * file's static imports.
   */
  reportFirstConnection?: (pcId: string) => void;
  /** Injectable fetch for the default `verify` probe (eases testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Default first-PC-connection reporter: lazy-require the gateway report so the
 * gateway + MMKV-guard graph never enters `connectToPc`'s STATIC import graph (the
 * `disconnectPc` → `relayUrlStore` pattern). Fire-and-forget + fully guarded — a
 * `require`/report failure can never affect the connect result.
 */
function defaultReportFirstConnection(pcId: string): void {
  try {
    const { reportFirstPcConnection } =
      require('./reportFirstPcConnection') as typeof import('./reportFirstPcConnection');
    void reportFirstPcConnection(pcId);
  } catch {
    /* best-effort — the activation report is non-essential to connecting */
  }
}

export type ConnectToPcReason = 'no-token' | 'unhealthy';

export interface ConnectToPcResult {
  /** True only when a stored token exists AND the health probe validated. */
  ready: boolean;
  /** The stored device token (null when this device never linked the PC). */
  deviceToken: string | null;
  /** Why the connect is not ready (absent when `ready`). */
  reason?: ConnectToPcReason;
}

/**
 * Try to connect to `pcId` using a previously-stored device token, gating on a
 * body-validated `/api/health` probe. Never throws.
 */
export async function connectToPc(pcId: string, deps: ConnectToPcDeps): Promise<ConnectToPcResult> {
  const getToken = deps.getToken ?? getDeviceToken;
  const setConnectedPc = deps.setConnectedPc ?? saveConnectedPcId;
  const verify =
    deps.verify ??
    ((gatewayBase: string, id: string, token: string) =>
      verifyTunnelAddress(gatewayBase, id, token, { fetchImpl: deps.fetchImpl }));

  const deviceToken = await getToken(pcId);
  console.warn(
    '[QRDBG] connectToPc pcId=',
    pcId,
    'gatewayBase=',
    deps.gatewayBase,
    'hasToken=',
    !!deviceToken
  );
  if (!deviceToken) {
    return { ready: false, deviceToken: null, reason: 'no-token' };
  }

  const healthy = await verify(deps.gatewayBase, pcId, deviceToken);
  console.warn('[QRDBG] connectToPc verify →', healthy ? 'HEALTHY' : 'UNHEALTHY');
  if (!healthy) {
    // Linked but not answering — re-pick / re-probe (a rotation re-points
    // automatically). Do NOT point the app at a dead PC.
    return { ready: false, deviceToken, reason: 'unhealthy' };
  }

  // Point the app's stable base at this PC: `getRelayUrl()` now resolves
  // `<gatewayBase>/t/<pcId>` and all `/api/*` + Socket.IO traffic flows there.
  await setConnectedPc(pcId);

  // Fire-and-forget the first-PC-connection activation report. One-shot per
  // pcId; it must NEVER block or fail the `{ ready: true }` return below.
  const reportFirstConnection = deps.reportFirstConnection ?? defaultReportFirstConnection;
  try {
    reportFirstConnection(pcId);
  } catch {
    /* best-effort — the report can never affect the connect result */
  }

  return { ready: true, deviceToken };
}
