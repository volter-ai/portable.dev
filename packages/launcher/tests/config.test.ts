import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import {
  loadOperatorEnv,
  resolveCliVersion,
  resolveTunnelProvider,
  resolveUseNgrok,
} from '../src/config.js';

describe('loadOperatorEnv — the operator .env → process.env loader (fix: applePC was ignored)', () => {
  it('loads every var from the .env into the env object (not just WORKSPACE_DIR)', () => {
    const env: NodeJS.ProcessEnv = {};
    loadOperatorEnv(
      env,
      ['/x/.env'],
      () =>
        'PORTABLE_PC_ID=applePC\nPORTABLE_REVIEWER_PUBLISH=true\nWORKSPACE_DIR=/home/ubuntu/workspace\n'
    );
    expect(env.PORTABLE_PC_ID).toBe('applePC');
    expect(env.PORTABLE_REVIEWER_PUBLISH).toBe('true');
    expect(env.WORKSPACE_DIR).toBe('/home/ubuntu/workspace');
  });

  it('NEVER overrides an already-exported var (export wins over .env)', () => {
    const env: NodeJS.ProcessEnv = { PORTABLE_PC_ID: 'exported-wins' };
    loadOperatorEnv(env, ['/x/.env'], () => 'PORTABLE_PC_ID=fromFile');
    expect(env.PORTABLE_PC_ID).toBe('exported-wins');
  });

  it('the FIRST candidate path wins over the second for the same key, but both contribute', () => {
    const env: NodeJS.ProcessEnv = {};
    const files: Record<string, string> = {
      '/cwd/.env': 'PORTABLE_PC_ID=fromCwd',
      '/root/.env': 'PORTABLE_PC_ID=fromRoot\nWORKSPACE_DIR=/w',
    };
    loadOperatorEnv(env, ['/cwd/.env', '/root/.env'], (p) => files[p]);
    expect(env.PORTABLE_PC_ID).toBe('fromCwd'); // first candidate wins
    expect(env.WORKSPACE_DIR).toBe('/w'); // only in the second file, still loaded
  });

  it('a missing / unreadable .env is skipped — never throws', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() =>
      loadOperatorEnv(env, ['/missing/.env'], () => {
        throw new Error('ENOENT');
      })
    ).not.toThrow();
    expect(Object.keys(env)).toHaveLength(0);
  });
});

describe('resolveCliVersion — the `portable --version` resolver', () => {
  it('returns the version from the FIRST readable candidate (packaged: the sibling package.json)', () => {
    const files: Record<string, string> = {
      '/dist/package.json': '{"name":"@volter-ai/portable.dev","version":"3.4.0"}',
      '/repo/package.json': '{"version":"9.9.9"}',
    };
    const v = resolveCliVersion(['/dist/package.json', '/repo/package.json'], (p) => files[p]);
    expect(v).toBe('3.4.0');
  });

  it('falls through to the next candidate when the first is missing (dev: the monorepo root)', () => {
    const v = resolveCliVersion(['/src/package.json', '/repo/package.json'], (p) => {
      if (p === '/repo/package.json') return '{"version":"3.4.0"}';
      throw new Error('ENOENT');
    });
    expect(v).toBe('3.4.0');
  });

  it('skips a package.json without a version string', () => {
    const v = resolveCliVersion(['/a/package.json', '/b/package.json'], (p) =>
      p === '/a/package.json' ? '{"name":"no-version"}' : '{"version":"1.2.3"}'
    );
    expect(v).toBe('1.2.3');
  });

  it("never throws — every candidate unreadable/invalid degrades to 'unknown'", () => {
    const v = resolveCliVersion(['/x/package.json', '/y/package.json'], (p) => {
      if (p === '/x/package.json') throw new Error('ENOENT');
      return 'not json';
    });
    expect(v).toBe('unknown');
  });

  it('default candidates resolve the monorepo root version in a source checkout', () => {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '../../../package.json'), 'utf8')
    ) as { version: string };
    expect(resolveCliVersion()).toBe(rootPkg.version);
  });
});

describe('resolveTunnelProvider — cloudflared (default) vs ngrok', () => {
  it("defaults to 'cloudflare' when PORTABLE_TUNNEL_PROVIDER is unset", () => {
    expect(resolveTunnelProvider({})).toBe('cloudflare');
  });

  it("is 'ngrok' when PORTABLE_TUNNEL_PROVIDER=ngrok (case-insensitive)", () => {
    expect(resolveTunnelProvider({ PORTABLE_TUNNEL_PROVIDER: 'ngrok' })).toBe('ngrok');
    expect(resolveTunnelProvider({ PORTABLE_TUNNEL_PROVIDER: '  NGROK ' })).toBe('ngrok');
  });

  it("anything else falls back to 'cloudflare'", () => {
    expect(resolveTunnelProvider({ PORTABLE_TUNNEL_PROVIDER: 'cloudflare' })).toBe('cloudflare');
    expect(resolveTunnelProvider({ PORTABLE_TUNNEL_PROVIDER: 'tailscale' })).toBe('cloudflare');
  });
});

describe('resolveUseNgrok — the --ngrok flag layered on PORTABLE_TUNNEL_PROVIDER', () => {
  it('is false by default (no flag, no env)', () => {
    expect(resolveUseNgrok({}, false)).toBe(false);
  });

  it('the --ngrok flag forces ngrok even without the env', () => {
    expect(resolveUseNgrok({}, true)).toBe(true);
  });

  it('PORTABLE_TUNNEL_PROVIDER=ngrok enables ngrok without the flag', () => {
    expect(resolveUseNgrok({ PORTABLE_TUNNEL_PROVIDER: 'ngrok' }, false)).toBe(true);
  });
});
