/**
 * linkPc (QR pairing) — SAVE-ONLY persistence of the QR's data-path JWT.
 *
 * After scanning the pairing QR (`{ gatewayBase, pcId, token }` —
 * {@link parseQrPayload}) the app does NOT round-trip the gateway: the QR already
 * carries the credential. `token` IS the PC-minted data-path JWT (the launcher
 * minted it locally with `@vgit2/shared/jwt`; the PC validates it locally on every
 * request). So linking is just:
 *
 *   - Persist `token` in SecureStore keyed by `pcId` ({@link saveDeviceToken}) —
 *     thereafter {@link connectToPc} reuses it (no QR), presenting it on every
 *     request + the Socket.IO handshake.
 *
 * There is NO `/link-pc` handshake, NO device-token mint, NO Clerk session token,
 * and NO `clerkUserId` binding: possession of the QR is the single
 * capability and the gateway never inspects the JWT. The persistence seam is
 * injectable so the save unit-tests with no native module.
 */

import { saveDeviceToken } from './deviceTokenStore';

/** Everything the QR carries to link a (device, PC) pair. */
export interface LinkPcInput {
  /** Base URL of the online relay gateway (from the scanned QR). */
  gatewayBase: string;
  /** The PC to link to (from the scanned QR). */
  pcId: string;
  /** The PC-minted data-path JWT (from the scanned QR). */
  token: string;
  /** Human-readable label for THIS device (optional; not sent anywhere). */
  deviceLabel?: string;
}

export interface LinkPcDeps {
  /** Seam: persist the QR's JWT. Defaults to {@link saveDeviceToken}. */
  saveToken?: (pcId: string, token: string) => Promise<void>;
}

/** What {@link linkPc} resolves with: the linked PC. */
export interface LinkPcResult {
  /** The PC the credential was stored for. */
  pcId: string;
}

/**
 * Persist the QR's data-path JWT keyed by `pcId` so a future
 * `connectToPc(pcId)` reuses it without re-scanning. No gateway round-trip.
 */
export async function linkPc(input: LinkPcInput, deps: LinkPcDeps = {}): Promise<LinkPcResult> {
  const { pcId, token } = input;
  const saveToken = deps.saveToken ?? saveDeviceToken;

  await saveToken(pcId, token);

  return { pcId };
}
