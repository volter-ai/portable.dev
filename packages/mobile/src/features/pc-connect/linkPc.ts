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

import { clearPcPairing } from './disconnectPc';
import { saveDeviceToken, saveE2eKey } from './deviceTokenStore';

/** Everything the QR carries to link a (device, PC) pair. */
export interface LinkPcInput {
  /** Base URL of the online relay gateway (from the scanned QR). */
  gatewayBase: string;
  /** The PC to link to (from the scanned QR). */
  pcId: string;
  /** The PC-minted data-path JWT (from the scanned QR). */
  token: string;
  /**
   * The E2E pre-shared key (base64, from the scanned QR — portable.dev#13).
   * Every current caller carries it: the normal QR path requires it
   * (parseQrPayload) and the Apple-reviewer QR-skip aborts without one
   * (portable.dev#15). Kept optional in the type for the historical
   * keyless-reviewer shape; a missing value just skips the key save.
   */
  e2eKey?: string;
  /** Human-readable label for THIS device (optional; not sent anywhere). */
  deviceLabel?: string;
}

export interface LinkPcDeps {
  /** Seam: persist the QR's JWT. Defaults to {@link saveDeviceToken}. */
  saveToken?: (pcId: string, token: string) => Promise<void>;
  /** Seam: persist the QR's E2E key. Defaults to {@link saveE2eKey}. */
  saveE2eKey?: (pcId: string, e2eKey: string) => Promise<void>;
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
  const { pcId, token, e2eKey } = input;
  const saveToken = deps.saveToken ?? saveDeviceToken;
  const saveKey = deps.saveE2eKey ?? saveE2eKey;

  await saveToken(pcId, token);
  if (e2eKey) await saveKey(pcId, e2eKey);

  return { pcId };
}

/** {@link resetAndLinkPc} seams — {@link LinkPcDeps} plus the clear step. */
export interface ResetAndLinkPcDeps extends LinkPcDeps {
  /** Seam: wipe the existing pairing first. Defaults to {@link clearPcPairing}. */
  clearPairing?: () => Promise<void>;
}

/**
 * The SINGLE canonical "re-pair" persistence for every IN-APP reconnection
 * surface (the {@link PcConnectModal} default, which backs Settings / Home /
 * Repos / the ConnectionFailedScreen recovery). It treats a re-scan as a fresh
 * disconnect + connect:
 *
 *   1. {@link clearPcPairing} — drop the currently-stored pcId + that PC's JWT
 *      AND its E2E key, so a stale/rejected/mismatched credential can never
 *      linger and get reused after the re-scan.
 *   2. {@link linkPc} — persist the freshly-scanned QR (JWT **and** E2E key).
 *
 * Centralising this here is what stops the class of drift that shipped the
 * "No E2E key for the connected PC" bug (portable.dev#13): the old per-screen
 * re-scan copies each called `saveDeviceToken` directly and forgot the E2E key.
 * There is now ONE definition — reconnection screens spread the modal default,
 * they never re-implement the save.
 *
 * The boot/gate flow ({@link buildPcConnectConfig}) does NOT use this — a first
 * pairing (or a post-disconnect one) has nothing to clear; it saves via
 * {@link linkPc} directly.
 */
export async function resetAndLinkPc(
  input: LinkPcInput,
  deps: ResetAndLinkPcDeps = {}
): Promise<LinkPcResult> {
  await (deps.clearPairing ?? clearPcPairing)();
  return linkPc(input, deps);
}
