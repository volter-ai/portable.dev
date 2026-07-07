/**
 * NgrokTunnel unit + (stubbed-process) integration tests.
 *
 * Mirrors CloudflaredTunnel.test.ts for the ngrok provider:
 *  - URL parsing: pull the public ngrok URL out of ngrok's JSON log lines (and a
 *    permissive regex fallback), incl. reserved custom domains via the `url` field.
 *  - presence detection + a clear setup hint when the binary is missing.
 *  - spawn `ngrok http <localUrl> --log stdout --log-format json`, parse the URL,
 *    hand it to onUrl.
 *  - supervise + restart on crash, hand the NEW URL to onUrl; cycle() self-heal.
 * The child process is stubbed (no real ngrok binary, no network).
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  NGROK_SETUP_HINT,
  NgrokTunnel,
  detectNgrok,
  parseNgrokError,
  parseNgrokUrl,
  resolveNgrokBin,
} from '../src/NgrokTunnel.js';
import { TunnelFatalError } from '../src/Tunnel.js';

describe('parseNgrokUrl', () => {
  it('extracts the URL from an ngrok "started tunnel" JSON log line', () => {
    const line =
      '{"lvl":"info","msg":"started tunnel","obj":"tunnels","name":"command_line",' +
      '"addr":"http://127.0.0.1:4200","url":"https://abc-123-def.ngrok-free.app"}';
    expect(parseNgrokUrl(line)).toBe('https://abc-123-def.ngrok-free.app');
  });

  it('extracts a reserved CUSTOM-domain URL via the JSON url field (started tunnel)', () => {
    const line = '{"lvl":"info","msg":"started tunnel","url":"https://portable.example.com"}';
    expect(parseNgrokUrl(line)).toBe('https://portable.example.com');
  });

  it('extracts an ngrok-host url from a non-started-tunnel JSON line', () => {
    const line = '{"lvl":"info","msg":"tunnel session started","url":"https://xyz.ngrok.app"}';
    expect(parseNgrokUrl(line)).toBe('https://xyz.ngrok.app');
  });

  it('extracts a bare ngrok URL from a non-JSON line (regex fallback)', () => {
    expect(parseNgrokUrl('t=... url=https://xyz-987.ngrok.io done')).toBe(
      'https://xyz-987.ngrok.io'
    );
  });

  it('does NOT mis-capture a URL mentioned inside an error line (ERR_NGROK_334)', () => {
    // The err text mentions the endpoint but there's no `url` field — this is a
    // FAILURE, not a live tunnel. Regex-scanning the raw JSON would wrongly return it.
    const errLine =
      '{"lvl":"eror","msg":"session closing","err":"failed to start tunnel: The endpoint ' +
      "'https://mirna.ngrok-free.dev' is already online.\\n\\nERR_NGROK_334\\n\"}";
    expect(parseNgrokUrl(errLine)).toBeNull();
  });

  it('returns null for lines without an ngrok URL', () => {
    expect(parseNgrokUrl('{"lvl":"info","msg":"starting web service"}')).toBeNull();
    // A non-started-tunnel JSON line whose url is NOT an ngrok host is ignored.
    expect(parseNgrokUrl('{"lvl":"info","msg":"noise","url":"https://example.com"}')).toBeNull();
    expect(parseNgrokUrl('https://example.com')).toBeNull();
    expect(parseNgrokUrl('')).toBeNull();
  });
});

describe('parseNgrokError', () => {
  it('classifies ERR_NGROK_334 (endpoint already online) as fatal with the code', () => {
    const line =
      '{"lvl":"eror","msg":"session closing","obj":"tunnels.session","err":"failed to ' +
      "start tunnel: The endpoint 'https://x.ngrok-free.dev' is already online.\\n\\n" +
      'ERR_NGROK_334\\n"}';
    const e = parseNgrokError(line);
    expect(e?.fatal).toBe(true);
    expect(e?.code).toBe('ERR_NGROK_334');
    expect(e?.message).toMatch(/already online/i);
  });

  it('classifies the 1-session-limit (ERR_NGROK_108) as fatal', () => {
    const line = '{"lvl":"crit","msg":"command failed","err":"session limit ERR_NGROK_108"}';
    expect(parseNgrokError(line)?.fatal).toBe(true);
  });

  it('reports an unknown eror-level line but marks it non-fatal (transient)', () => {
    const e = parseNgrokError('{"lvl":"eror","msg":"reconnecting","err":"read: connection reset"}');
    expect(e?.fatal).toBe(false);
    expect(e?.message).toMatch(/connection reset/i);
  });

  it('returns null for info / URL / non-JSON lines', () => {
    expect(
      parseNgrokError('{"lvl":"info","msg":"started tunnel","url":"https://x.ngrok-free.app"}')
    ).toBeNull();
    expect(parseNgrokError('ERROR:  ERR_NGROK_334')).toBeNull(); // non-JSON banner line
    expect(parseNgrokError('')).toBeNull();
  });
});

/** A fake child process driven by tests. */
class FakeChild extends EventEmitter {
  killed: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 8888;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? 'SIGTERM';
    setTimeout(() => this.emit('exit', 0), 2);
    return true;
  }
}

describe('detectNgrok', () => {
  it('resolves true when `<bin> version` exits 0', async () => {
    const child = new FakeChild();
    const present = detectNgrok('ngrok', (() => {
      setTimeout(() => child.emit('exit', 0), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(true);
  });

  it('resolves false when spawn errors (ENOENT)', async () => {
    const child = new FakeChild();
    const present = detectNgrok('ngrok', (() => {
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(false);
  });

  it('resolves false on a non-zero exit', async () => {
    const child = new FakeChild();
    const present = detectNgrok('ngrok', (() => {
      setTimeout(() => child.emit('exit', 1), 1);
      return child as any;
    }) as any);
    expect(await present).toBe(false);
  });
});

describe('resolveNgrokBin', () => {
  it('honors PORTABLE_NGROK_BIN on any platform', () => {
    const bin = resolveNgrokBin(
      { PORTABLE_NGROK_BIN: 'D:\\tools\\ngrok.exe' },
      'win32',
      () => false
    );
    expect(bin).toBe('D:\\tools\\ngrok.exe');
  });

  it('returns the bare name on non-Windows platforms', () => {
    expect(resolveNgrokBin({}, 'darwin', () => true)).toBe('ngrok');
    expect(resolveNgrokBin({}, 'linux', () => true)).toBe('ngrok');
  });

  it('probes the scoop shims dir on Windows when not on PATH', () => {
    const expected = 'C:\\Users\\me\\scoop\\shims\\ngrok.exe';
    const bin = resolveNgrokBin({ USERPROFILE: 'C:\\Users\\me' }, 'win32', (p) => p === expected);
    expect(bin).toBe(expected);
  });

  it('falls back to the bare name on Windows when no install dir matches', () => {
    expect(resolveNgrokBin({}, 'win32', () => false)).toBe('ngrok');
  });
});

describe('NgrokTunnel.start', () => {
  it('throws the setup hint when ngrok is missing', async () => {
    const tunnel = new NgrokTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => false,
      spawnImpl: (() => {
        throw new Error('should not spawn when missing');
      }) as any,
      log: () => {},
    });
    await expect(tunnel.start()).rejects.toThrow(/ngrok not found/i);
    expect(NGROK_SETUP_HINT).toMatch(/ngrok config add-authtoken/);
  });

  it('spawns `ngrok http <localUrl> --log stdout --log-format json` and hands the parsed URL to onUrl', async () => {
    const child = new FakeChild();
    const spawnArgs: { cmd: string; args: string[] } = { cmd: '', args: [] };
    const urls: string[] = [];
    const tunnel = new NgrokTunnel({
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
    expect(spawnArgs.cmd).toBe('ngrok');
    expect(spawnArgs.args).toContain('http');
    expect(spawnArgs.args).toContain('http://127.0.0.1:4200');
    expect(spawnArgs.args).toContain('--log-format');
    expect(spawnArgs.args).toContain('json');

    // ngrok prints the URL to stdout (--log stdout).
    child.stdout.write(
      '{"lvl":"info","msg":"started tunnel","url":"https://first.ngrok-free.app"}\n'
    );
    const url = await tunnel.waitForFirstUrl(1000);
    expect(url).toBe('https://first.ngrok-free.app');
    expect(urls).toEqual(['https://first.ngrok-free.app']);
    expect(tunnel.getPublicUrl()).toBe('https://first.ngrok-free.app');
  });

  it('does not re-fire onUrl for the same URL printed twice', async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const tunnel = new NgrokTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      onUrl: (u) => urls.push(u),
      log: () => {},
      spawnImpl: (() => child as any) as any,
    });
    await tunnel.start();
    child.stdout.write('{"msg":"started tunnel","url":"https://same.ngrok-free.app"}\n');
    child.stdout.write('noise\n{"msg":"started tunnel","url":"https://same.ngrok-free.app"}\n');
    await tunnel.waitForFirstUrl(1000);
    expect(urls).toEqual(['https://same.ngrok-free.app']);
  });
});

describe('NgrokTunnel supervision', () => {
  it('restarts on crash and hands the NEW rotated URL to onUrl', async () => {
    const children: FakeChild[] = [];
    const urls: string[] = [];
    let spawnCount = 0;
    const tunnel = new NgrokTunnel({
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
    children[0].stdout.write('{"msg":"started tunnel","url":"https://first.ngrok-free.app"}\n');
    await tunnel.waitForFirstUrl(1000);

    // Simulate ngrok crashing — the supervisor must respawn.
    children[0].emit('exit', 1);
    await waitFor(() => spawnCount === 2);
    expect(tunnel.getPublicUrl()).toBeNull(); // stale URL dropped on restart

    children[1].stdout.write('{"msg":"started tunnel","url":"https://second.ngrok-free.app"}\n');
    await waitFor(() => urls.length === 2);
    expect(urls).toEqual(['https://first.ngrok-free.app', 'https://second.ngrok-free.app']);
    expect(tunnel.getPublicUrl()).toBe('https://second.ngrok-free.app');
  });

  it('cycle() kills the child so the supervisor respawns with a NEW URL', async () => {
    const children: FakeChild[] = [];
    const urls: string[] = [];
    let spawnCount = 0;
    const tunnel = new NgrokTunnel({
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
    children[0].stdout.write('{"msg":"started tunnel","url":"https://stale.ngrok-free.app"}\n');
    await tunnel.waitForFirstUrl(1000);

    tunnel.cycle();
    expect(children[0].killed).toBe('SIGTERM');
    expect(tunnel.getPublicUrl()).toBeNull();

    await waitFor(() => spawnCount === 2);
    children[1].stdout.write('{"msg":"started tunnel","url":"https://fresh.ngrok-free.app"}\n');
    await waitFor(() => urls.length === 2);
    expect(urls).toEqual(['https://stale.ngrok-free.app', 'https://fresh.ngrok-free.app']);
    expect(tunnel.getPublicUrl()).toBe('https://fresh.ngrok-free.app');
  });

  it('on a fatal ngrok error: rejects waitForFirstUrl with TunnelFatalError and does NOT restart', async () => {
    let spawnCount = 0;
    const child = new FakeChild();
    const logs: string[] = [];
    const tunnel = new NgrokTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      restartDelayMs: 0,
      sleep: async () => {},
      log: (l) => logs.push(l),
      spawnImpl: (() => {
        spawnCount += 1;
        return child as any;
      }) as any,
    });

    await tunnel.start();
    const wait = tunnel.waitForFirstUrl(1000);
    // ngrok's real ERR_NGROK_334 output: the reserved/free domain is already online.
    child.stdout.write(
      '{"lvl":"eror","msg":"session closing","err":"failed to start tunnel: The endpoint ' +
        "'https://x.ngrok-free.dev' is already online.\\n\\nERR_NGROK_334\\n\"}\n"
    );

    await expect(wait).rejects.toThrow(TunnelFatalError);
    expect(logs.some((l) => /already online/i.test(l))).toBe(true);

    // ngrok now exits — the supervisor must NOT respawn into the same collision.
    child.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnCount).toBe(1);
    expect(logs.some((l) => /not restarting ngrok/i.test(l))).toBe(true);
  });

  it('does NOT capture a phantom URL from the error banner a dead session keeps echoing', async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const tunnel = new NgrokTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      restartDelayMs: 0,
      sleep: async () => {},
      onUrl: (u) => urls.push(u),
      log: () => {},
      spawnImpl: (() => child as any) as any,
    });
    await tunnel.start();
    // ngrok's real failure output: a JSON `eror` line FIRST (latches fatal), then the
    // non-JSON `ERROR:` banner that MENTIONS the endpoint URL. Neither is a live tunnel.
    child.stdout.write(
      '{"lvl":"eror","msg":"session closing","err":"failed to start tunnel: The endpoint ' +
        "'https://mirna.ngrok-free.dev' is already online.\\n\\nERR_NGROK_334\\n\"}\n"
    );
    child.stdout.write(
      "ERROR:  failed to start tunnel: The endpoint 'https://mirna.ngrok-free.dev' is already online.\n"
    );
    child.stdout.write('ERROR:  ERR_NGROK_334\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(urls).toEqual([]); // no phantom capture → no spurious registration/DNS probe
    expect(tunnel.getPublicUrl()).toBeNull();
  });

  it('a live URL after a prior error clears the fatal state (recovers)', async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const tunnel = new NgrokTunnel({
      localUrl: 'http://127.0.0.1:4200',
      detectImpl: async () => true,
      restartDelayMs: 0,
      sleep: async () => {},
      onUrl: (u) => urls.push(u),
      log: () => {},
      spawnImpl: (() => child as any) as any,
    });
    await tunnel.start();
    // A transient (non-fatal) error must not block a subsequent URL.
    child.stdout.write('{"lvl":"eror","msg":"reconnecting","err":"read: connection reset"}\n');
    child.stdout.write('{"msg":"started tunnel","url":"https://ok.ngrok-free.app"}\n');
    const url = await tunnel.waitForFirstUrl(1000);
    expect(url).toBe('https://ok.ngrok-free.app');
    expect(urls).toEqual(['https://ok.ngrok-free.app']);
  });

  it('does NOT restart after an intentional stop()', async () => {
    let spawnCount = 0;
    const child = new FakeChild();
    const tunnel = new NgrokTunnel({
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
