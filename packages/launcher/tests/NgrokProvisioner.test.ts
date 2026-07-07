/**
 * NgrokProvisioner tests — the `--ngrok` preflight.
 *
 * ngrok is an opt-in the user must have installed + authenticated; ensureNgrok never
 * downloads anything and HARD-FAILS (throws) when either precondition is missing (the
 * launcher surfaces the throw as a fatal — no fallback to cloudflared). All effects
 * are injected seams so no real binary / fs is touched.
 */
import { describe, expect, it } from 'bun:test';
import path from 'path';

import {
  NGROK_AUTH_HINT,
  ensureNgrok,
  isNgrokAuthenticated,
  ngrokConfigCandidates,
} from '../src/NgrokProvisioner.js';
import { NGROK_SETUP_HINT } from '../src/NgrokTunnel.js';

describe('ensureNgrok — hard-fail preflight', () => {
  it('returns the resolved bin when present AND authenticated', async () => {
    const bin = await ensureNgrok({
      env: {},
      log: () => {},
      resolveBin: () => '/usr/local/bin/ngrok',
      detectImpl: async () => true,
      isAuthenticated: () => true,
    });
    expect(bin).toBe('/usr/local/bin/ngrok');
  });

  it('throws the setup hint when the binary is missing (no fallback)', async () => {
    await expect(
      ensureNgrok({
        env: {},
        log: () => {},
        resolveBin: () => 'ngrok',
        detectImpl: async () => false, // not installed
        isAuthenticated: () => true,
      })
    ).rejects.toThrow(NGROK_SETUP_HINT);
  });

  it('throws the auth hint when present but NOT authenticated', async () => {
    await expect(
      ensureNgrok({
        env: {},
        log: () => {},
        resolveBin: () => 'ngrok',
        detectImpl: async () => true,
        isAuthenticated: () => false, // no authtoken
      })
    ).rejects.toThrow(NGROK_AUTH_HINT);
  });

  it('checks the binary BEFORE auth (a missing binary reports the setup hint, not auth)', async () => {
    let authChecked = false;
    await expect(
      ensureNgrok({
        env: {},
        log: () => {},
        resolveBin: () => 'ngrok',
        detectImpl: async () => false,
        isAuthenticated: () => {
          authChecked = true;
          return true;
        },
      })
    ).rejects.toThrow(NGROK_SETUP_HINT);
    expect(authChecked).toBe(false);
  });
});

describe('isNgrokAuthenticated', () => {
  it('is true when NGROK_AUTHTOKEN is set (no fs read needed)', () => {
    expect(
      isNgrokAuthenticated({
        env: { NGROK_AUTHTOKEN: 'tok_123' },
        existsImpl: () => {
          throw new Error('should not read fs when env token is set');
        },
      })
    ).toBe(true);
  });

  it('is true when a config file contains an authtoken', () => {
    const cfgPath = path.join('/home/me', '.config', 'ngrok', 'ngrok.yml');
    expect(
      isNgrokAuthenticated({
        env: {},
        platform: 'linux',
        homedir: () => '/home/me',
        existsImpl: (p) => p === cfgPath,
        readFileImpl: (p) => (p === cfgPath ? 'version: "2"\nauthtoken: abc123\n' : ''),
      })
    ).toBe(true);
  });

  it('is false with no env token and no config authtoken', () => {
    expect(
      isNgrokAuthenticated({
        env: {},
        platform: 'linux',
        homedir: () => '/home/me',
        existsImpl: () => false,
        readFileImpl: () => '',
      })
    ).toBe(false);
  });

  it('is false when the config exists but has no authtoken line', () => {
    const cfgPath = path.join('/home/me', '.config', 'ngrok', 'ngrok.yml');
    expect(
      isNgrokAuthenticated({
        env: {},
        platform: 'linux',
        homedir: () => '/home/me',
        existsImpl: (p) => p === cfgPath,
        readFileImpl: () => 'version: "2"\nregion: us\n',
      })
    ).toBe(false);
  });
});

describe('ngrokConfigCandidates', () => {
  it('honors an explicit NGROK_CONFIG override first', () => {
    const list = ngrokConfigCandidates(
      { NGROK_CONFIG: '/custom/ngrok.yml' },
      'linux',
      () => '/home/me'
    );
    expect(list[0]).toBe('/custom/ngrok.yml');
  });

  it('includes the macOS Application Support path on darwin', () => {
    const list = ngrokConfigCandidates({}, 'darwin', () => '/Users/me');
    expect(list).toContain(
      path.join('/Users/me', 'Library', 'Application Support', 'ngrok', 'ngrok.yml')
    );
    // Legacy path is always included too.
    expect(list).toContain(path.join('/Users/me', '.ngrok2', 'ngrok.yml'));
  });

  it('uses the XDG config dir on linux', () => {
    const list = ngrokConfigCandidates({}, 'linux', () => '/home/me');
    expect(list).toContain(path.join('/home/me', '.config', 'ngrok', 'ngrok.yml'));
  });

  it('includes the classic %LOCALAPPDATA% path on win32', () => {
    const local = path.join('C:', 'Users', 'me', 'AppData', 'Local');
    const list = ngrokConfigCandidates({ LOCALAPPDATA: local }, 'win32', () =>
      path.join('C:', 'Users', 'me')
    );
    expect(list).toContain(path.join(local, 'ngrok', 'ngrok.yml'));
  });

  it('includes the MSIX-virtualized LocalCache path on win32 (winget/Store ngrok)', () => {
    const local = path.join('C:', 'Users', 'me', 'AppData', 'Local');
    const packagesDir = path.join(local, 'Packages');
    const list = ngrokConfigCandidates(
      { LOCALAPPDATA: local },
      'win32',
      () => path.join('C:', 'Users', 'me'),
      (dir) =>
        dir === packagesDir ? ['ngrok.ngrok_1g87z0zv29zzc', 'Microsoft.WindowsTerminal_8wekyb'] : []
    );
    expect(list).toContain(
      path.join(
        packagesDir,
        'ngrok.ngrok_1g87z0zv29zzc',
        'LocalCache',
        'Local',
        'ngrok',
        'ngrok.yml'
      )
    );
    // Unrelated MSIX packages are not probed.
    expect(list.some((p) => p.includes('WindowsTerminal'))).toBe(false);
  });

  it('keeps the classic win32 candidates when the Packages dir is unreadable', () => {
    const local = path.join('C:', 'Users', 'me', 'AppData', 'Local');
    const list = ngrokConfigCandidates(
      { LOCALAPPDATA: local },
      'win32',
      () => path.join('C:', 'Users', 'me'),
      () => {
        throw new Error('EPERM');
      }
    );
    expect(list).toContain(path.join(local, 'ngrok', 'ngrok.yml'));
  });

  it('does not enumerate MSIX packages on non-win32 platforms', () => {
    let readdirCalled = false;
    ngrokConfigCandidates(
      {},
      'linux',
      () => '/home/me',
      () => {
        readdirCalled = true;
        return [];
      }
    );
    expect(readdirCalled).toBe(false);
  });
});

describe('isNgrokAuthenticated — MSIX-virtualized config (win32)', () => {
  it('is true when only the MSIX LocalCache config has the authtoken (nested v3 agent form)', () => {
    const local = path.join('C:', 'Users', 'me', 'AppData', 'Local');
    const packagesDir = path.join(local, 'Packages');
    const msixCfg = path.join(
      packagesDir,
      'ngrok.ngrok_1g87z0zv29zzc',
      'LocalCache',
      'Local',
      'ngrok',
      'ngrok.yml'
    );
    expect(
      isNgrokAuthenticated({
        env: { LOCALAPPDATA: local },
        platform: 'win32',
        homedir: () => path.join('C:', 'Users', 'me'),
        readdirImpl: (dir) => (dir === packagesDir ? ['ngrok.ngrok_1g87z0zv29zzc'] : []),
        existsImpl: (p) => p === msixCfg,
        readFileImpl: (p) =>
          p === msixCfg ? 'version: "3"\nagent:\n    authtoken: 2abcDEF_secret\n' : '',
      })
    ).toBe(true);
  });
});
