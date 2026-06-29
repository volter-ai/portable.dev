/**
 * DeviceTokenService unit tests.
 *
 * Verifies the local-first per-request auth gate:
 *  - mint -> validate round-trips the claims (incl. clerkUserId + deviceId)
 *  - revoke invalidates a previously-valid token
 *  - a tampered token (mutated payload) is rejected by the signature check
 *  - an unknown / malformed / missing token is rejected
 *  - list() surfaces minted records with revocation state
 *  - the signing secret + records persist across service instances (same store)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { DeviceTokenService } from '../../../src/services/DeviceTokenService.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-device-token-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeService(): DeviceTokenService {
  return new DeviceTokenService(new LocalSecretStore({ dataDir: tmpDir }));
}

describe('DeviceTokenService', () => {
  it('mint -> validate round-trips claims including clerkUserId + deviceId', () => {
    const svc = makeService();
    const { token, claims } = svc.mint("Bruno's iPhone", 'user_clerk_123');

    expect(claims.clerkUserId).toBe('user_clerk_123');
    expect(claims.deviceLabel).toBe("Bruno's iPhone");
    expect(claims.deviceId).toBeTruthy();
    expect(claims.tokenId).toBeTruthy();
    expect(typeof claims.iat).toBe('number');

    const validated = svc.validate(token);
    expect(validated.clerkUserId).toBe('user_clerk_123');
    expect(validated.deviceId).toBe(claims.deviceId);
    expect(validated.tokenId).toBe(claims.tokenId);
  });

  it('mint requires a clerkUserId', () => {
    const svc = makeService();
    expect(() => svc.mint('iPhone', '')).toThrow(/clerkUserId is required/);
  });

  it('revoke invalidates a previously-valid token', () => {
    const svc = makeService();
    const { token, claims } = svc.mint('iPad', 'user_abc');

    // Valid before revoke.
    expect(svc.validate(token).tokenId).toBe(claims.tokenId);

    expect(svc.revoke(claims.tokenId)).toBe(true);
    expect(() => svc.validate(token)).toThrow(/revoked/i);

    // Revoking again is a no-op (already revoked).
    expect(svc.revoke(claims.tokenId)).toBe(false);
  });

  it('rejects a tampered token (mutated payload)', () => {
    const svc = makeService();
    const { token } = svc.mint('Pixel', 'user_xyz');

    const [payloadB64, sig] = token.split('.');
    // Flip a byte in the payload; the HMAC over it no longer matches.
    const mutated = Buffer.from(payloadB64, 'base64url');
    mutated[0] = mutated[0] ^ 0xff;
    const tamperedToken = `${mutated.toString('base64url')}.${sig}`;

    expect(() => svc.validate(tamperedToken)).toThrow(/signature/i);
  });

  it('rejects a token signed by a different install (wrong PC)', () => {
    const svcA = makeService();
    const { token } = svcA.mint('Phone', 'user_1');

    // A separate store/install => a different signing secret.
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-device-token-other-'));
    const svcB = new DeviceTokenService(new LocalSecretStore({ dataDir: otherDir }));
    expect(() => svcB.validate(token)).toThrow(/signature/i);
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('rejects missing / malformed tokens', () => {
    const svc = makeService();
    expect(() => svc.validate('')).toThrow(/missing/i);
    expect(() => svc.validate('not-a-token')).toThrow(/malformed/i);
    expect(() => svc.validate('a.b.c')).toThrow(/malformed/i);
  });

  it('lists minted records with revocation state', () => {
    const svc = makeService();
    const a = svc.mint('A', 'user_1');
    const b = svc.mint('B', 'user_1');
    svc.revoke(a.claims.tokenId);

    const records = svc.list();
    expect(records).toHaveLength(2);
    const recA = records.find((r) => r.tokenId === a.claims.tokenId);
    const recB = records.find((r) => r.tokenId === b.claims.tokenId);
    expect(recA?.revoked).toBe(true);
    expect(recB?.revoked).toBe(false);
  });

  it('persists signing secret + records across service instances (same store)', () => {
    const svc1 = makeService();
    const { token, claims } = svc1.mint('Persistent', 'user_persist');

    // A fresh service over the SAME dataDir must validate the earlier token.
    const svc2 = makeService();
    expect(svc2.validate(token).tokenId).toBe(claims.tokenId);
    expect(svc2.list().some((r) => r.tokenId === claims.tokenId)).toBe(true);
  });
});
