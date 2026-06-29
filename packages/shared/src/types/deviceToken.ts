/**
 * Device-token + QR-link handshake types
 *
 * In the local-first model the PC (packages/api) is the sole per-request auth
 * gate. It mints long-lived **device tokens** bound to the owning Clerk account
 * (`clerkUserId`, bound at link time) and to a specific device
 * (`deviceId`). The device token — NOT a Clerk JWT — is presented on every
 * request (Authorization: Bearer) and on the Socket.IO handshake; Clerk is only
 * used at link/discovery time. See docs/security/local-first-threat-model.md.
 *
 * The token is HMAC-signed with a per-install secret held in the local encrypted
 * store (LocalSecretStore) — it is intentionally distinct from the
 * Gateway's `AuthTokenPayload` JWT so the two auth paths never get confused.
 */

/**
 * The verified claims carried by a device token. These are the fields the PC
 * trusts after a successful `DeviceTokenService.validate(token)`.
 */
export interface DeviceTokenClaims {
  /** Unique id for this minted token (the revocation handle — `revoke(tokenId)`). */
  tokenId: string;
  /** The owning Clerk account this token authenticates as (bound at link time). */
  clerkUserId: string;
  /** Unique id for the linked device (one per (device, PC) pairing). */
  deviceId: string;
  /** Human-readable label for the device (e.g. "Bruno's iPhone"). */
  deviceLabel: string;
  /** Issued-at, epoch seconds. */
  iat: number;
}

/**
 * The persisted record for a minted token (claims + revocation state). Returned
 * by `DeviceTokenService.list()`; the signature/token string itself is never
 * stored (only the HMAC secret is, separately).
 */
export interface DeviceTokenRecord extends DeviceTokenClaims {
  /** True once `revoke(tokenId)` has been called; a revoked token fails validate. */
  revoked: boolean;
  /** When the token was revoked, epoch seconds (absent if not revoked). */
  revokedAt?: number;
}

/** Result of `DeviceTokenService.mint()`: the opaque token + its claims. */
export interface MintedDeviceToken {
  /** The signed, opaque device token to present on requests. */
  token: string;
  /** The claims embedded in `token` (also persisted as a record). */
  claims: DeviceTokenClaims;
}

/**
 * The QR payload scanned by the mobile app to connect to a PC (QR pairing).
 * The `token` IS the data-path JWT — the launcher mints it locally with the
 * repo's `@vgit2/shared/jwt` (`generateAuthToken`) and the PC validates it
 * locally (`verifyAuthToken`) on every request. There is **no link-secret, no
 * `/link-pc` round-trip, and no device-token mint**: the QR already carries the
 * credential, which the app stores per `pcId`. The gateway only relays and never
 * inspects the JWT. See docs/security/local-first-threat-model.md.
 */
export interface QrLinkPayload {
  /** Base URL of the online relay gateway (e.g. https://app.portable.dev). */
  gatewayBase: string;
  /** The PC's globally-unique routing id (a routing key, not a secret). */
  pcId: string;
  /** The PC-minted data-path JWT — the credential the app presents on every request. */
  token: string;
}
