import { describe, expect, test } from 'bun:test';

import { majorMinorChanged, isDevSentinelVersion } from '@vgit2/shared/utils/versionUtils';

// Drives the native app's "wipe stored auth on version change" gate:
// the native app forces a re-login when major.minor changes between launches.
describe('majorMinorChanged', () => {
  test('returns false when versions are identical', () => {
    expect(majorMinorChanged('1.4.0', '1.4.0')).toBe(false);
  });

  test('returns false when only the patch differs (no forced wipe)', () => {
    expect(majorMinorChanged('1.4.0', '1.4.1')).toBe(false);
    expect(majorMinorChanged('1.4.9', '1.4.0')).toBe(false);
  });

  test('returns true when the minor bumps (1.4 -> 1.5)', () => {
    expect(majorMinorChanged('1.4.0', '1.5.0')).toBe(true);
    expect(majorMinorChanged('1.4.3', '1.5.0')).toBe(true);
  });

  test('returns true when the minor goes down (downgrade still counts)', () => {
    expect(majorMinorChanged('1.5.0', '1.4.9')).toBe(true);
  });

  test('returns true when the major bumps (1.9 -> 2.0)', () => {
    expect(majorMinorChanged('1.9.0', '2.0.0')).toBe(true);
    expect(majorMinorChanged('2.0.0', '1.0.0')).toBe(true);
  });

  test('treats missing patch as 0 (1.4 == 1.4.0)', () => {
    expect(majorMinorChanged('1.4', '1.4.0')).toBe(false);
  });
});

// VersionGate dev-sentinel:
// When the app version is absent (local dev), the build injects '0.0.0' as a
// sentinel. The gate must fail open for this sentinel regardless of the
// server's minimum app version.
describe('isDevSentinelVersion', () => {
  test('returns true for the 0.0.0 dev sentinel', () => {
    expect(isDevSentinelVersion('0.0.0')).toBe(true);
  });

  test('returns false for a real release version', () => {
    expect(isDevSentinelVersion('1.4.2')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isDevSentinelVersion('')).toBe(false);
  });

  test('returns false for a version below minimum but not the sentinel', () => {
    // Ensures fail-open is ONLY for the sentinel, not for any old version
    expect(isDevSentinelVersion('0.9.0')).toBe(false);
  });
});
