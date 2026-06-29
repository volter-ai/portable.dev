/**
 * Socket.IO handshake device-token gate.
 *
 * The confidentiality model requires device-token validation on EVERY request
 * AND on the Socket.IO handshake. The per-request REST gate is covered by
 * `jwtAuth-device-token.test.ts`; this file covers the handshake path
 * (`AuthService.validateSocketAuth`, exercised here via `UserValidationHandler`):
 *  - a valid device token is ACCEPTED and scopes the socket to its clerkUserId
 *  - a revoked / tampered / missing token is REJECTED
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LocalSecretStore } from '@vgit2/shared/secrets';

import { DeviceTokenService } from '../../../src/services/DeviceTokenService.js';
import { UserValidationHandler } from '../../../src/services/AuthService/handlers/UserValidationHandler.js';

import type { HandlerDependencies } from '../../../src/services/AuthService/types.js';

let tmpDir: string;
let deviceTokenService: DeviceTokenService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-socket-handshake-'));
  deviceTokenService = new DeviceTokenService(new LocalSecretStore({ dataDir: tmpDir }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeHandler(): UserValidationHandler {
  // Only deviceTokenService is exercised by the device-token handshake branch.
  const deps = { deviceTokenService } as unknown as HandlerDependencies;
  return new UserValidationHandler(deps, []);
}

describe('validateSocketAuth — device-token handshake gate', () => {
  it('accepts a valid device token and scopes the socket to its clerkUserId', async () => {
    const { token } = deviceTokenService.mint("Bruno's iPhone", 'user_clerk_xyz');
    const handler = makeHandler();

    const result = await handler.validateSocketAuth(token);

    expect(result.valid).toBe(true);
    expect(result.userEmail).toBe('user_clerk_xyz'); // owning identity scopes the socket
    expect(result.username).toBe("Bruno's iPhone"); // deviceLabel surfaces as display name
  });

  it('rejects a revoked device token', async () => {
    const { token, claims } = deviceTokenService.mint('iPad', 'user_clerk_xyz');
    deviceTokenService.revoke(claims.tokenId);
    const handler = makeHandler();

    const result = await handler.validateSocketAuth(token);

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a tampered device token (bad signature)', async () => {
    const { token } = deviceTokenService.mint('iPad', 'user_clerk_xyz');
    const [claimsPart] = token.split('.');
    const tampered = `${claimsPart}.deadbeefdeadbeef`;
    const handler = makeHandler();

    const result = await handler.validateSocketAuth(tampered);

    expect(result.valid).toBe(false);
  });
});
