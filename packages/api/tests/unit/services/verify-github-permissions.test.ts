import { describe, it, expect, mock } from 'bun:test';

import { verifyGitHubPermissionsWithRefresh } from '../../../src/services/AuthService/verifyGitHubPermissions';

import type { GitHubPermissionStatus } from '../../../src/services/AuthService/types';

const CONNECTED: GitHubPermissionStatus = {
  hasPermissions: true,
  authType: 'oauth',
  needsUpgrade: false,
};
const NONE: GitHubPermissionStatus = {
  hasPermissions: false,
  authType: 'none',
  needsUpgrade: true,
};

const noSleep = async () => {};

describe('verifyGitHubPermissionsWithRefresh', () => {
  it('invalidates once and returns immediately when the first read is connected', async () => {
    const invalidate = mock(() => {});
    const check = mock(async () => CONNECTED);

    const status = await verifyGitHubPermissionsWithRefresh(check, invalidate, { sleep: noSleep });

    expect(status.hasPermissions).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    // The cache is flushed BEFORE the read so a re-cached negative can't stick.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('retries (invalidating before each read) until the connection appears', async () => {
    // The just-created connection becomes visible only on the 3rd read.
    let calls = 0;
    const check = mock(async () => {
      calls += 1;
      return calls >= 3 ? CONNECTED : NONE;
    });
    const invalidate = mock(() => {});
    const sleeps: number[] = [];

    const status = await verifyGitHubPermissionsWithRefresh(check, invalidate, {
      attempts: 5,
      delayMs: 800,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(status.hasPermissions).toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledTimes(3); // before each of the 3 reads
    expect(sleeps).toEqual([800, 800]); // two waits between the three reads
  });

  it('gives up after the attempt budget and returns the last (disconnected) status', async () => {
    const invalidate = mock(() => {});
    const check = mock(async () => NONE);

    const status = await verifyGitHubPermissionsWithRefresh(check, invalidate, {
      attempts: 3,
      sleep: noSleep,
    });

    expect(status.hasPermissions).toBe(false);
    expect(check).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('always runs at least one attempt even with attempts <= 0', async () => {
    const invalidate = mock(() => {});
    const check = mock(async () => CONNECTED);

    const status = await verifyGitHubPermissionsWithRefresh(check, invalidate, {
      attempts: 0,
      sleep: noSleep,
    });

    expect(status.hasPermissions).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
