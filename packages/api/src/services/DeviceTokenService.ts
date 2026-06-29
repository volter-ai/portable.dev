/**
 * DeviceTokenService — local-first per-request auth gate
 *
 * Mints, validates, revokes, and lists **device tokens**: long-lived opaque
 * credentials the PC (this api process) issues to each linked mobile device. A
 * device token is bound to the owning Clerk account (`clerkUserId`, bound at
 * link time) and to a specific `deviceId`. It — NOT a Clerk JWT — is
 * the per-request gate: presented on Authorization: Bearer and the Socket.IO
 * handshake, validated locally with no network call (the remote
 * TokenValidationService is bypassed in local mode). Clerk is consulted only at
 * link/discovery time. See docs/security/local-first-threat-model.md.
 *
 * Token wire format (deliberately 2 dot-parts so it never collides with a
 * 3-part JWT):
 *   base64url(JSON(claims)) "." base64url(HMAC-SHA256(payloadB64, signingSecret))
 *
 * Both the per-install HMAC signing secret and the minted-token records live in
 * the local encrypted store (LocalSecretStore) — there is no second
 * store. validate() rejects a token whose signature does not match (tampering /
 * wrong PC) and whose record is missing or has been revoked.
 */
import crypto from 'crypto';

import type { LocalSecretStore } from '@vgit2/shared/secrets';
import type { DeviceTokenClaims, DeviceTokenRecord, MintedDeviceToken } from '@vgit2/shared/types';

/** LocalSecretStore key for the per-install HMAC signing secret (hex). */
const SIGNING_SECRET_KEY = 'device-token:signing-secret';
/** LocalSecretStore key for the minted-token record map ({ [tokenId]: record }). */
const RECORDS_KEY = 'device-token:records';

const SIGNING_SECRET_BYTES = 32;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class DeviceTokenService {
  constructor(private readonly store: LocalSecretStore) {}

  /**
   * Mint a new device token bound to `clerkUserId`, with a fresh `deviceId`.
   * Persists a record so the token can later be validated, revoked, and listed.
   */
  mint(deviceLabel: string, clerkUserId: string): MintedDeviceToken {
    if (!clerkUserId) {
      throw new Error('DeviceTokenService.mint: clerkUserId is required');
    }
    const claims: DeviceTokenClaims = {
      tokenId: crypto.randomUUID(),
      clerkUserId,
      deviceId: crypto.randomUUID(),
      deviceLabel: deviceLabel || 'Unnamed device',
      iat: nowSeconds(),
    };

    const token = this.signClaims(claims);

    const records = this.readRecords();
    records[claims.tokenId] = { ...claims, revoked: false };
    this.writeRecords(records);

    return { token, claims };
  }

  /**
   * Validate a device token. Returns its claims on success; throws on a missing,
   * malformed, tampered (bad signature), unknown, or revoked token.
   */
  validate(token: string): DeviceTokenClaims {
    if (!token || typeof token !== 'string') {
      throw new Error('Device token missing');
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new Error('Malformed device token');
    }
    const [payloadB64, providedSig] = parts;

    // Constant-time signature comparison (tamper / wrong-PC rejection).
    const expectedSig = this.signPayload(payloadB64);
    const providedBuf = Buffer.from(providedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      providedBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new Error('Invalid device token signature');
    }

    let claims: DeviceTokenClaims;
    try {
      claims = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8')
      ) as DeviceTokenClaims;
    } catch {
      throw new Error('Invalid device token payload');
    }
    if (!claims?.tokenId || !claims.clerkUserId || !claims.deviceId) {
      throw new Error('Invalid device token claims');
    }

    // Bind validity to local state so revocation works and a stale/foreign
    // token (valid signature but no record) is rejected.
    const record = this.readRecords()[claims.tokenId];
    if (!record) {
      throw new Error('Unknown device token');
    }
    if (record.revoked) {
      throw new Error('Device token revoked');
    }

    return claims;
  }

  /** Revoke a token by its id. Returns true if it existed and was not already revoked. */
  revoke(tokenId: string): boolean {
    const records = this.readRecords();
    const record = records[tokenId];
    if (!record || record.revoked) {
      return false;
    }
    record.revoked = true;
    record.revokedAt = nowSeconds();
    records[tokenId] = record;
    this.writeRecords(records);
    return true;
  }

  /** List all minted token records (incl. revoked) for management/UI. */
  list(): DeviceTokenRecord[] {
    return Object.values(this.readRecords());
  }

  // --- internals ------------------------------------------------------------

  private signClaims(claims: DeviceTokenClaims): string {
    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `${payloadB64}.${this.signPayload(payloadB64)}`;
  }

  private signPayload(payloadB64: string): string {
    return crypto
      .createHmac('sha256', this.getSigningSecret())
      .update(payloadB64)
      .digest('base64url');
  }

  /** Load the per-install HMAC secret, generating + persisting one on first use. */
  private getSigningSecret(): Buffer {
    const existing = this.store.get(SIGNING_SECRET_KEY);
    if (existing) {
      return Buffer.from(existing, 'hex');
    }
    const secret = crypto.randomBytes(SIGNING_SECRET_BYTES);
    this.store.set(SIGNING_SECRET_KEY, secret.toString('hex'));
    return secret;
  }

  private readRecords(): Record<string, DeviceTokenRecord> {
    return this.store.getJSON<Record<string, DeviceTokenRecord>>(RECORDS_KEY) ?? {};
  }

  private writeRecords(records: Record<string, DeviceTokenRecord>): void {
    this.store.setJSON(RECORDS_KEY, records);
  }
}
