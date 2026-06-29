/**
 * CloudflaredTunnel unit + (stubbed-process) integration tests.
 *
 * Covers the acceptance criteria:
 *  - URL parsing: pull the *.trycloudflare.com URL out of cloudflared log lines.
 *  - presence detection + clear install instruction when the binary is missing.
 *  - spawn `cloudflared tunnel --url <localUrl>`, parse the URL, hand it to onUrl.
 *  - supervise + restart on crash, and hand the NEW (rotated) URL to onUrl.
 * The child process is stubbed (no real cloudflared binary, no network).
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  CLOUDFLARED_INSTALL_HINT,
  CloudflaredTunnel,
  detectCloudflared,
  parseTrycloudflareUrl,
  resolveCloudflaredBin,
} from '../src/CloudflaredTunnel.js';

describe('parseTrycloudflareUrl', () => {
  it('extracts the URL from a cloudflared INF log line', () => {
    const line = '2026-06-22T00:00:00Z INF |  https://random-three-words.trycloudflare.com   |';
    expect(parseTrycloudflareUrl(line)).toBe('https://random-three-words.trycloudflare.com');
  });

  it('extracts a bare URL', () => {
    expect(parseTrycloudflareUrl('https://abc-def-ghi.trycloudflare.com')).toBe(
      'https://abc-def-ghi.trycloudflare.com'
    );
  });

  it('returns null for lines without a quick-tunnel URL', () => {
    expect(parseTrycloudflareUrl('INF Starting tunnel')).toBeNull();
    expect(parseTrycloudflareUrl('https://example.com')).toBeNull();
    expect(parseTrycloudflareUrl('')).toBeNull();
  });
});

/** A fake child process driven by tests. */
class FakeChild extends EventEmitter {
  killed: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 7777;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    setTimeout(() => this.emit('exit', 0), 2);
    return true;
  }
}

describe('detectCloudflared', () => {
  it('resolves true when `<bin> --version` exits 0', async () => {
    const child = new FakeChild();
    const present = detectCloudflared('cloudflared', (() => {
      setTimeout(() => child.emit('exit', 0), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(true);
  });

  it('resolves false when spawn errors (ENOENT)', async () => {
    const child = new FakeChild();
    const present = detectCloudflared('cloudflared', (() => {
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(false);
  });

  it('resolves false on a non-zero exit', async () => {
    const child = new FakeChild();
    const present = detectCloudflared('cloudflared', (() => {
      setTimeout(() => child.emit('exit', 127), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(false);
  });
});

describe('resolveCloudflaredBin', () => {
  it('honors PORTABLE_CLOUDFLARED_BIN on any platform', () => {
    const bin = resolveCloudflaredBin(
      { PORTABLE_CLOUDFLARED_BIN: 'D:\\tools\\cloudflared.exe' },
      'win32',
      () => false
    );
    expect(bin).toBe('D:\\tools\\cloudflared.exe');
  });

  it('returns the bare name on non-Windows platforms', () => {
    expect(resolveCloudflaredBin({}, 'darwin', () => true)).toBe('cloudflared');
    expect(resolveCloudflaredBin({}, 'linux', () => true)).toBe('cloudflared');
  });

  it('probes the Program Files install dir on Windows when not on PATH', () => {
    const expected = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
    const bin = resolveCloudflaredBin(
      { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      'win32',
      (p) => p === expected
    );
    expect(bin).toBe(expected);
  });

  it('falls back to the bare name on Windows when no install dir matches', () => {
    expect(resolveCloudflaredBin({}, 'win32', () => false)).toBe('cloudflared');
  });
});

describe('CloudflaredTunnel.start', () => {
  it('throws the install hint when cloudflared is missing', async () => {
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => false,
      spawnImpl: (() => {
        throw new Error('should not spawn when missing');
      }) as any,
      log: () => {},
    });
    await expect(tunnel.start()).rejects.toThrow(/cloudflared not found/i);
    expect(CLOUDFLARED_INSTALL_HINT).toMatch(/brew install cloudflared/);
  });

  it('spawns `cloudflared tunnel --url <localUrl>` and hands the parsed URL to onUrl', async () => {
    const child = new FakeChild();
    const spawnArgs: { cmd: string; args: string[] } = { cmd: '', args: [] };
    const urls: string[] = [];
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      onUrl: (u) => urls.push(u),
      log: () => {},
      spawnImpl: ((cmd: string, args: string[]) => {
        spawnArgs.cmd = cmd;
        spawnArgs.args = args;
        return child as any;
      }) as any,
    });

    await tunnel.start();
    expect(spawnArgs.cmd).toBe('cloudflared');
    expect(spawnArgs.args).toContain('tunnel');
    expect(spawnArgs.args).toContain('--url');
    expect(spawnArgs.args).toContain('http://127.0.0.1:4200');

    // cloudflared prints the URL to stderr.
    child.stderr.write('INF |  https://first-tunnel.trycloudflare.com  |\n');
    const url = await tunnel.waitForFirstUrl(1000);
    expect(url).toBe('https://first-tunnel.trycloudflare.com');
    expect(urls).toEqual(['https://first-tunnel.trycloudflare.com']);
    expect(tunnel.getPublicUrl()).toBe('https://first-tunnel.trycloudflare.com');
  });

  it('does not re-fire onUrl for the same URL printed twice', async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      onUrl: (u) => urls.push(u),
      log: () => {},
      spawnImpl: (() => child as any) as any,
    });
    await tunnel.start();
    child.stderr.write('https://same.trycloudflare.com\n');
    child.stderr.write('noise\nhttps://same.trycloudflare.com\n');
    await tunnel.waitForFirstUrl(1000);
    expect(urls).toEqual(['https://same.trycloudflare.com']);
  });
});

describe('CloudflaredTunnel supervision', () => {
  it('restarts on crash and hands the NEW rotated URL to onUrl', async () => {
    const children: FakeChild[] = [];
    const urls: string[] = [];
    let spawnCount = 0;
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      onUrl: (u) => urls.push(u),
      restartDelayMs: 0,
      sleep: async () => {},
      log: () => {},
      spawnImpl: (() => {
        spawnCount += 1;
        const c = new FakeChild();
        children.push(c);
        return c as any;
      }) as any,
    });

    await tunnel.start();
    children[0].stderr.write('https://first.trycloudflare.com\n');
    await tunnel.waitForFirstUrl(1000);

    // Simulate cloudflared crashing — the supervisor must respawn.
    children[0].emit('exit', 1);
    await waitFor(() => spawnCount === 2);
    expect(tunnel.getPublicUrl()).toBeNull(); // stale URL dropped on restart

    // The new process prints a different (rotated) hostname.
    children[1].stderr.write('https://second.trycloudflare.com\n');
    await waitFor(() => urls.length === 2);
    expect(urls).toEqual(['https://first.trycloudflare.com', 'https://second.trycloudflare.com']);
    expect(tunnel.getPublicUrl()).toBe('https://second.trycloudflare.com');
  });

  it('cycle() kills the child so the supervisor respawns with a NEW URL', async () => {
    const children: FakeChild[] = [];
    const urls: string[] = [];
    let spawnCount = 0;
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      onUrl: (u) => urls.push(u),
      restartDelayMs: 0,
      sleep: async () => {},
      log: () => {},
      spawnImpl: (() => {
        spawnCount += 1;
        const c = new FakeChild();
        children.push(c);
        return c as any;
      }) as any,
    });

    await tunnel.start();
    children[0].stderr.write('https://stale.trycloudflare.com\n');
    await tunnel.waitForFirstUrl(1000);

    // Self-heal: the public ingress is broken though cloudflared is alive — cycle it.
    tunnel.cycle();
    expect(children[0].killed).toBe('SIGTERM');
    expect(tunnel.getPublicUrl()).toBeNull(); // stale URL dropped immediately

    await waitFor(() => spawnCount === 2);
    children[1].stderr.write('https://fresh.trycloudflare.com\n');
    await waitFor(() => urls.length === 2);
    expect(urls).toEqual(['https://stale.trycloudflare.com', 'https://fresh.trycloudflare.com']);
    expect(tunnel.getPublicUrl()).toBe('https://fresh.trycloudflare.com');
  });

  it('cycle() is a no-op after stop() (does not resurrect a stopped tunnel)', async () => {
    let spawnCount = 0;
    const child = new FakeChild();
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      restartDelayMs: 0,
      sleep: async () => {},
      log: () => {},
      spawnImpl: (() => {
        spawnCount += 1;
        return child as any;
      }) as any,
    });
    await tunnel.start();
    await tunnel.stop();
    tunnel.cycle();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCount).toBe(1); // no respawn
  });

  it('does NOT restart after an intentional stop()', async () => {
    let spawnCount = 0;
    const child = new FakeChild();
    const tunnel = new CloudflaredTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      restartDelayMs: 0,
      sleep: async () => {},
      log: () => {},
      spawnImpl: (() => {
        spawnCount += 1;
        return child as any;
      }) as any,
    });
    await tunnel.start();
    expect(spawnCount).toBe(1);
    await tunnel.stop();
    expect(child.killed).toBe('SIGTERM');
    // Give any erroneous restart a chance to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCount).toBe(1);
    expect(tunnel.isRunning()).toBe(false);
  });
});

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 2);
    };
    tick();
  });
}
