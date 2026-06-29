/**
 * CloudflaredProvisioner unit tests (cross-platform auto-provision).
 *
 * Covers `ensureCloudflared`:
 *  - PORTABLE_CLOUDFLARED_BIN override → returned as-is, package never loaded.
 *  - managed binary already present → returned, no download.
 *  - managed binary missing → install() runs once, returns the now-present path.
 *  - package unavailable (loadModule throws) → falls back to the PATH resolver.
 *  - install runs but binary still missing → falls back to the PATH resolver.
 * Every effect is an injected seam — no real download, no real fs, no real package.
 */
import { describe, expect, it } from 'bun:test';

import { ensureCloudflared } from '../src/CloudflaredProvisioner.js';

const BIN = '/cache/cloudflared/bin/cloudflared';
const FALLBACK = '/usr/local/bin/cloudflared';

function deps(overrides: Parameters<typeof ensureCloudflared>[0] = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    log: () => {},
    existsImpl: () => true,
    resolveFallback: () => FALLBACK,
    loadModule: async () => ({ bin: BIN, install: () => BIN }),
    ...overrides,
  };
}

describe('ensureCloudflared', () => {
  it('returns PORTABLE_CLOUDFLARED_BIN override without loading the package', async () => {
    let loaded = 0;
    const result = await ensureCloudflared(
      deps({
        env: { PORTABLE_CLOUDFLARED_BIN: '/opt/cloudflared' },
        loadModule: async () => {
          loaded++;
          return { bin: BIN, install: () => BIN };
        },
      })
    );
    expect(result).toBe('/opt/cloudflared');
    expect(loaded).toBe(0);
  });

  it('returns the managed binary when it is already present (no download)', async () => {
    let installs = 0;
    const result = await ensureCloudflared(
      deps({
        existsImpl: (p) => p === BIN,
        loadModule: async () => ({
          bin: BIN,
          install: () => {
            installs++;
            return BIN;
          },
        }),
      })
    );
    expect(result).toBe(BIN);
    expect(installs).toBe(0);
  });

  it('downloads once when the managed binary is missing, then returns it', async () => {
    let installed = false;
    const result = await ensureCloudflared(
      deps({
        existsImpl: () => installed, // missing before install, present after
        loadModule: async () => ({
          bin: BIN,
          install: async () => {
            installed = true;
            return BIN;
          },
        }),
      })
    );
    expect(result).toBe(BIN);
  });

  it('falls back to the PATH resolver when the package is unavailable', async () => {
    const result = await ensureCloudflared(
      deps({
        loadModule: async () => {
          throw new Error('cannot find package cloudflared');
        },
      })
    );
    expect(result).toBe(FALLBACK);
  });

  it('falls back when install runs but the binary is still missing', async () => {
    const result = await ensureCloudflared(
      deps({
        existsImpl: () => false, // never becomes present
        loadModule: async () => ({ bin: BIN, install: async () => BIN }),
      })
    );
    expect(result).toBe(FALLBACK);
  });
});
