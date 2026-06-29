import { describe, expect, it } from 'bun:test';

import { loadOperatorEnv } from '../src/config.js';

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
