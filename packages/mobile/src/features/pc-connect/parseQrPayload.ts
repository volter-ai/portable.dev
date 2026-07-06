/**
 * QR-pairing payload parsing (QR pairing).
 *
 * Connecting to a PC is done by SCANNING the QR shown in the launcher's terminal
 * (or its loopback pairing page) — there is no manual-entry path (the user never
 * sees the payload). The QR encodes the `QrLinkPayload` JSON —
 * `{ gatewayBase, pcId, token }` — where
 * `token` IS the PC-minted data-path JWT (the launcher mints it locally with the
 * repo's `@vgit2/shared/jwt` and the PC validates it locally on every request).
 * There is no link-secret and no `/link-pc` round-trip: the QR already
 * carries the credential, which the app stores per `pcId`.
 *
 * This module only PARSES + VALIDATES the scanned payload and surfaces an
 * error/retry on a malformed one; persisting the token + connecting is the
 * caller's job (`linkPc` → `connectToPc`).
 */

import type { QrLinkPayload } from '@vgit2/shared/types';

/** A trimmed string field is "present" only when non-empty. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse a scanned QR string into a validated {@link QrLinkPayload}, or
 * `null` when it is not a well-formed pairing payload (not JSON, or missing any of
 * the four required fields — a pre-E2E QR without `e2eKey` is malformed too; the
 * user restarts `portable` to get a fresh QR). The caller turns `null` into the
 * visible `qr-scanner-error` + retry.
 *
 * `gatewayBase` is additionally required to be an `http(s)` URL so a bogus base
 * can never become the relay origin; `token` is the non-empty JWT string the app
 * will present on every request.
 */
export function parseQrPayload(raw: string): QrLinkPayload | null {
  if (!isNonEmptyString(raw)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  const { gatewayBase, pcId, token, e2eKey } = candidate;
  if (
    !isNonEmptyString(gatewayBase) ||
    !isNonEmptyString(pcId) ||
    !isNonEmptyString(token) ||
    !isNonEmptyString(e2eKey)
  ) {
    return null;
  }

  if (!/^https?:\/\//i.test(gatewayBase.trim())) return null;

  return {
    gatewayBase: gatewayBase.trim(),
    pcId: pcId.trim(),
    token: token.trim(),
    e2eKey: e2eKey.trim(),
  };
}
