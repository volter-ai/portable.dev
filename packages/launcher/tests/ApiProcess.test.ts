/**
 * ApiProcess + waitForHealth unit tests.
 *
 * Covers the acceptance criteria:
 *  - The api child env forces local mode + 127.0.0.1 bind + the right port.
 *  - waitForHealth returns a REAL JSON body from a live /api/health server.
 *  - The smoke assertion aborts if the process dies before becoming healthy.
 *  - start() spawns `bun <api server entry>` with the right cwd/env; stop() signals it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { ApiProcess, waitForHealth } from '../src/ApiProcess.js';
import {
  buildApiChildEnv,
  resolveApiPort,
  resolveApiServerEntry,
  resolveOperatorWorkspaceDir,
} from '../src/config.js';

describe('config: buildApiChildEnv / resolveApiPort', () => {
  it('pins loopback bind, the resolved port, and drops DEV_BACKEND_PORT', () => {
    const env = buildApiChildEnv({ VGIT_PORT: '5123', DEV_BACKEND_PORT: '5122', FOO: 'bar' });
    expect(env.API_BIND_HOST).toBe('127.0.0.1');
    expect(env.VGIT_PORT).toBe('5123');
    expect(env.DEV_BACKEND_PORT).toBeUndefined();
    expect(env.FOO).toBe('bar'); // passthrough of the base env
  });

  it('defaults the port when VGIT_PORT is unset', () => {
    expect(resolveApiPort({})).toBe(4200);
    expect(resolveApiPort({ VGIT_PORT: '7000' })).toBe(7000);
  });

  it('preserves HOME and never sets a CLAUDE_*_DIR', () => {
    // The api child + the `claude` CLI it spawns must resolve the host user's REAL
    // ~/.claude so the user's global skills and shared chat transcripts are visible.
    // buildApiChildEnv MUST inherit HOME via the `{ ...base }` spread and MUST NOT
    // isolate the Claude config dir. An env-build refactor that drops the HOME
    // pass-through or sets a CLAUDE_CONFIG_DIR would break global skills + transcripts.
    const env = buildApiChildEnv({ HOME: '/Users/real', VGIT_PORT: '5123' });
    expect(env.HOME).toBe('/Users/real');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CACHE_DIR).toBeUndefined();
    expect(env.CLAUDE_LOG_DIR).toBeUndefined();
  });

  it('sets PORTABLE_DEBUG=1 only when the debug override is on', () => {
    expect(buildApiChildEnv({}, {}).PORTABLE_DEBUG).toBeUndefined();
    expect(buildApiChildEnv({}, { debug: false }).PORTABLE_DEBUG).toBeUndefined();
    expect(buildApiChildEnv({}, { debug: true }).PORTABLE_DEBUG).toBe('1');
  });

  it('forwards chromiumExecutablePath as PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', () => {
    expect(
      buildApiChildEnv({}, { chromiumExecutablePath: '/cache/chromium/chrome' })
        .PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ).toBe('/cache/chromium/chrome');
  });

  it('leaves an inherited PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH intact when the override is empty', () => {
    // Empty/undefined override must not clobber a
    // value the user already exported in the base env.
    expect(
      buildApiChildEnv({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium' }, {})
        .PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ).toBe('/usr/bin/chromium');
    expect(
      buildApiChildEnv(
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium' },
        { chromiumExecutablePath: '' }
      ).PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ).toBe('/usr/bin/chromium');
  });

  it('forwards workspaceDir as WORKSPACE_DIR, leaving base intact when unset', () => {
    // Resolved operator WORKSPACE_DIR reaches the api child via the explicit override.
    expect(buildApiChildEnv({}, { workspaceDir: '/Users/dev/code' }).WORKSPACE_DIR).toBe(
      '/Users/dev/code'
    );
    // Unresolved override must not clobber a value already in the base env.
    expect(buildApiChildEnv({ WORKSPACE_DIR: '/already/set' }, {}).WORKSPACE_DIR).toBe(
      '/already/set'
    );
    expect(
      buildApiChildEnv({ WORKSPACE_DIR: '/already/set' }, { workspaceDir: '' }).WORKSPACE_DIR
    ).toBe('/already/set');
  });

  it('resolves the api server entry to packages/api/src/server.ts', () => {
    expect(resolveApiServerEntry().replace(/\\/g, '/')).toMatch(/packages\/api\/src\/server\.ts$/);
  });
});

describe('config: resolveOperatorWorkspaceDir', () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  function writeEnv(contents: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev9-launcher-env-'));
    const envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, contents);
    return envPath;
  }

  it('prefers a shell-exported WORKSPACE_DIR over the root .env', () => {
    const envPath = writeEnv('WORKSPACE_DIR=/from/file\n');
    expect(resolveOperatorWorkspaceDir({ WORKSPACE_DIR: '/from/shell' }, envPath)).toBe(
      '/from/shell'
    );
  });

  it('reads WORKSPACE_DIR from the root .env when not shell-exported (the propagation bug)', () => {
    // This is the exact gap being fixed: WORKSPACE_DIR set ONLY in .env (not the
    // shell) must still be discovered by the launcher and forwarded to the api child.
    const envPath = writeEnv('# operator config\nWORKSPACE_DIR=~/my-repos\nOTHER=x\n');
    expect(resolveOperatorWorkspaceDir({}, envPath)).toBe('~/my-repos');
  });

  it('returns undefined when WORKSPACE_DIR is set nowhere (api keeps its own default)', () => {
    const envPath = writeEnv('OTHER=x\n');
    expect(resolveOperatorWorkspaceDir({}, envPath)).toBeUndefined();
  });

  it('returns undefined (never throws) when the root .env does not exist', () => {
    expect(
      resolveOperatorWorkspaceDir({}, path.join(os.tmpdir(), 'rev9-nonexistent-xyz', '.env'))
    ).toBeUndefined();
  });
});

describe('waitForHealth', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns the real JSON health body once /api/health reports status=ok', async () => {
    let ready = false;
    server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            ready
              ? { status: 'ok', timestamp: '2026-06-22T00:00:00.000Z', uptime: 1.2 }
              : { status: 'starting' }
          )
        );
        return;
      }
      res.writeHead(404).end();
    });
    const port = await listen(server);
    // Flip to healthy after the first poll.
    setTimeout(() => {
      ready = true;
    }, 30);

    const body = await waitForHealth(`http://127.0.0.1:${port}`, {
      attempts: 20,
      intervalMs: 20,
    });
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('aborts immediately when the process is reported dead', async () => {
    await expect(
      waitForHealth('http://127.0.0.1:1', {
        attempts: 5,
        intervalMs: 1,
        isAlive: () => false,
      })
    ).rejects.toThrow(/exited before becoming healthy/i);
  });

  it('times out with a helpful message when health never comes up', async () => {
    await expect(
      waitForHealth('http://127.0.0.1:1', {
        attempts: 2,
        intervalMs: 1,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      })
    ).rejects.toThrow(/did not become ready/i);
  });
});

/** A fake child process driven by tests. */
class FakeChild extends EventEmitter {
  killed: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    // Simulate a graceful async exit.
    setTimeout(() => this.emit('exit', 0), 5);
    return true;
  }
}

describe('ApiProcess', () => {
  it('spawns `bun <api entry>` with the api cwd + local-mode env', () => {
    const child = new FakeChild();
    const spawnArgs: { cmd: string; args: string[]; opts: any } = { cmd: '', args: [], opts: {} };
    const proc = new ApiProcess({
      env: { VGIT_PORT: '5500' },
      bun: 'bun',
      log: () => {},
      spawnImpl: ((cmd: string, args: string[], opts: any) => {
        spawnArgs.cmd = cmd;
        spawnArgs.args = args;
        spawnArgs.opts = opts;
        return child as any;
      }) as any,
    });

    proc.start();
    expect(spawnArgs.cmd).toBe('bun');
    expect(spawnArgs.args[0].replace(/\\/g, '/')).toMatch(/packages\/api\/src\/server\.ts$/);
    expect(spawnArgs.opts.cwd.replace(/\\/g, '/')).toMatch(/packages\/api$/);
    expect(spawnArgs.opts.env.API_BIND_HOST).toBe('127.0.0.1');
    expect(spawnArgs.opts.env.VGIT_PORT).toBe('5500');
    expect(proc.isAlive()).toBe(true);
    expect(proc.pid).toBe(4242);
  });

  it('stop() sends SIGTERM and resolves once the child exits', async () => {
    const child = new FakeChild();
    const proc = new ApiProcess({
      env: {},
      log: () => {},
      killGraceMs: 1000,
      spawnImpl: (() => child as any) as any,
    });
    proc.start();
    await proc.stop();
    expect(child.killed).toBe('SIGTERM');
    expect(proc.isAlive()).toBe(false);
    expect(await proc.waitUntilExit()).toBe(0);
  });

  it('isAlive flips to false when the child exits on its own', async () => {
    const child = new FakeChild();
    const proc = new ApiProcess({ env: {}, log: () => {}, spawnImpl: (() => child as any) as any });
    proc.start();
    expect(proc.isAlive()).toBe(true);
    child.emit('exit', 1);
    await proc.waitUntilExit();
    expect(proc.isAlive()).toBe(false);
  });
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}
