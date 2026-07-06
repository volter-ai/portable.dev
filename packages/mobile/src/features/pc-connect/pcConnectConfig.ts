/**
 * pcConnectConfig (QR pairing) — the production wiring for the app-shell's
 * PC-connect gate.
 *
 * After the local-first pivot the app boots through {@link PcConnectGate} instead
 * of the old onboarding/provisioning gates. Connection is QR-ONLY: the
 * `/my-pcs` Clerk-authed discovery is dropped, and the QR already carries the
 * PC-minted data-path JWT, so linking is just persisting that JWT keyed by `pcId`
 * (no gateway round-trip, no Clerk session token). A returning device
 * reconnects to the PC it already holds a token for; a fresh device scans the QR
 * shown in the launcher's terminal.
 *
 * No `@clerk/clerk-expo` is imported here (it hangs Jest at module load) — and this
 * path needs no Clerk token at all. {@link buildPcConnectConfig} produces the
 * {@link PcConnectConfig} the shell mounts; router-level tests inject a config
 * directly.
 */

import { GatewayClient } from '../../services/gatewayClient';
import { getGatewayUrl } from '../auth/gatewayConfig';
import { getAuthToken } from '../auth/secureAuthStore';

import { connectToPc } from './connectToPc';
import { getConnectedPcId } from './connectedPcStore';
import { getE2eKey } from './deviceTokenStore';
import { linkPc } from './linkPc';

import type { MobileRnAppleReviewerCredentialsResponse, QrLinkPayload } from '@vgit2/shared/types';

/**
 * The seams the app-shell's PC-connect gate needs. The device build supplies the
 * implementation ({@link buildPcConnectConfig}); tests inject fakes so the gate runs
 * with no native module / network.
 */
export interface PcConnectConfig {
  /**
   * Read the currently-connected PC id (null when the app is not yet pointed at a
   * PC). Default: the SecureStore reader.
   */
  getConnectedPcId?: () => Promise<string | null>;
  /**
   * Read the per-PC E2E pre-shared key (base64), or null when this device never
   * stored one for `pcId`. Default: the SecureStore reader. Used by the host to
   * self-heal the E2E migration gap (portable.dev#13): a device paired BEFORE
   * E2E existed holds a JWT for its pcId but no e2eKey, and since E2E is
   * mandatory on the relay data path EVERY `/api/*` request would then throw
   * deep in the app — so a returning device missing the key is routed back to
   * the QR scanner instead of dead-ending.
   */
  getE2eKey?: (pcId: string) => Promise<string | null>;
  /**
   * Connect to a PC this device already holds a data-path JWT for.
   * Resolves `true` when the app is now pointed at the PC (the stable relay base
   * is live), `false` when the PC is unreachable / unlinked (stay on the scanner).
   */
  onConnect: (pcId: string) => Promise<boolean>;
  /**
   * Persist the scanned QR's data-path JWT keyed by `pcId` (save-only, no gateway
   * round-trip). Resolves on success.
   */
  onLink: (payload: QrLinkPayload) => Promise<void>;
  /**
   * OPTIONAL Apple-reviewer fast path: when this device holds no connected
   * PC (or holds a pairing missing its E2E key, portable.dev#15), the host calls
   * this BEFORE mounting the QR scanner. A `200` payload
   * (`{ gatewayBase, pcId, token, e2eKey }` — the SAME shape the QR carries) lets
   * the dedicated App-Store reviewer connect WITHOUT scanning; `null` (a `403`
   * non-reviewer / any error) — or a keyless response, which the host refuses to
   * link (unusable under mandatory E2E) — falls through to the normal QR gate.
   * Omitted (or always-`null`) ⇒ the non-reviewer flow is byte-identical.
   * Injectable so tests never pull `@clerk/clerk-expo` into the graph.
   */
  getReviewerCredentials?: () => Promise<MobileRnAppleReviewerCredentialsResponse | null>;
}

/**
 * Build the production {@link PcConnectConfig}. `onLink` persists the QR's JWT
 * (save-only); `onConnect` reuses the stored JWT via {@link connectToPc} against the
 * fixed gateway base. No Clerk token is needed — possession of the QR is the single
 * capability.
 */
export function buildPcConnectConfig(): PcConnectConfig {
  return {
    getConnectedPcId,
    getE2eKey,
    onConnect: async (pcId: string) => {
      const result = await connectToPc(pcId, { gatewayBase: getGatewayUrl() });
      return result.ready;
    },
    // Boot/gate pairing is save-only via the SINGLE canonical linkPc (JWT + the
    // QR-carried E2E pre-shared key — the phone's half of the E2E trust bootstrap,
    // portable.dev#13). It does NOT clear first (unlike the in-app re-scan's
    // resetAndLinkPc): a first pairing / a post-disconnect one has nothing stale
    // to drop. Every caller carries the E2E key — the QR requires it and the host
    // aborts a keyless reviewer bypass (portable.dev#15).
    onLink: (payload: QrLinkPayload) => linkPc(payload).then(() => {}),
    // Apple-reviewer fast path: read the persisted authToken and ask the
    // gateway whether the signed-in account is the dedicated reviewer. A non-reviewer
    // gets a `403` (→ GatewayHttpError) which we swallow to `null` so the host falls
    // through to the normal QR scanner — the only extra cost for everyone else is one
    // fast-failing request.
    getReviewerCredentials: async () => {
      let token: string | null;
      try {
        token = await getAuthToken();
      } catch {
        return null;
      }
      if (!token) return null;
      try {
        return await new GatewayClient({ gatewayUrl: getGatewayUrl() }).getAppleReviewerCredentials(
          token
        );
      } catch {
        // 403 (not a reviewer) or any network/parse error → normal QR flow.
        return null;
      }
    },
  };
}
