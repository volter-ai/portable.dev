/**
 * ChromiumProvisioner unit tests (local-first Playwright fix).
 *
 * Covers `ensureChromium`:
 *  - cache hit → no install, returns the resolved path.
 *  - missing → runs `playwright install chromium`, returns the now-present path.
 *  - install failure → HARD-FAILS with CHROMIUM_INSTALL_HINT (Playwright is required).
 *  - resolve failure → HARD-FAILS.
 *  - still-missing after install → HARD-FAILS.
 *  - explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override (exists) → used as-is, no install.
 * Every effect is an injected seam — no real `playwright install`, no real fs.
 */
import { describe, expect, it } from 'bun:test';

import { CHROMIUM_INSTALL_HINT, ensureChromium } from '../src/ChromiumProvisioner.js';

const RESOLVED = '/cache/ms-playwright/chromium-1223/chrome-mac/Chromium';

/** Build deps with sensible test defaults; override per case. */
function deps(overrides: Parameters<typeof ensureChromium>[0] = {}) {
  return {
    env: {},
    apiCwd: '/repo/packages/api',
    log: () => {},
    existsImpl: () => true,
    resolveExecutablePath: () => RESOLVED,
    installChromium: () => {
      throw new Error('install should not run in this case');
    },
    ...overrides,
  };
}

describe('ensureChromium', () => {
  it('returns the resolved path without installing when Chromium is already present', () => {
    let installs = 0;
    const result = ensureChromium(
      deps({
        existsImpl: () => true,
        installChromium: () => {
          installs++;
        },
      })
    );
    expect(result.executablePath).toBe(RESOLVED);
    expect(result.installed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(installs).toBe(0);
  });

  it('installs once when the browser is missing, then returns the now-present path', () => {
    let installed = false;
    const result = ensureChromium(
      deps({
        // Missing before install, present after.
        existsImpl: () => installed,
        installChromium: () => {
          installed = true;
        },
      })
    );
    expect(result.installed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.executablePath).toBe(RESOLVED);
  });

  it('hard-fails with the install hint when `playwright install` throws', () => {
    expect(() =>
      ensureChromium(
        deps({
          existsImpl: () => false,
          installChromium: () => {
            throw new Error('network down');
          },
        })
      )
    ).toThrow(/Playwright Chromium could not be installed/);
  });

  it('hard-fails when the executable path cannot be resolved', () => {
    expect(() =>
      ensureChromium(
        deps({
          resolveExecutablePath: () => {
            throw new Error('playwright not found');
          },
        })
      )
    ).toThrow(new RegExp(CHROMIUM_INSTALL_HINT.split('\n')[0]));
  });

  it('hard-fails when Chromium is still missing after a "successful" install', () => {
    expect(() =>
      ensureChromium(
        deps({
          existsImpl: () => false, // never becomes present
          installChromium: () => {
            /* pretends to succeed but installs nothing */
          },
        })
      )
    ).toThrow(/still not found after install/);
  });

  it('uses an explicit PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH override (when it exists) without installing', () => {
    let installs = 0;
    let resolves = 0;
    const result = ensureChromium(
      deps({
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/opt/chrome/chrome' },
        existsImpl: (p) => p === '/opt/chrome/chrome',
        resolveExecutablePath: () => {
          resolves++;
          return RESOLVED;
        },
        installChromium: () => {
          installs++;
        },
      })
    );
    expect(result.executablePath).toBe('/opt/chrome/chrome');
    expect(result.installed).toBe(false);
    expect(installs).toBe(0);
    expect(resolves).toBe(0); // override short-circuits before resolution
  });

  it('falls through to install when the override path does not exist', () => {
    let installed = false;
    const result = ensureChromium(
      deps({
        env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/does/not/exist' },
        existsImpl: (p) => (p === '/does/not/exist' ? false : installed),
        installChromium: () => {
          installed = true;
        },
      })
    );
    expect(result.executablePath).toBe(RESOLVED);
    expect(result.installed).toBe(true);
  });
});
