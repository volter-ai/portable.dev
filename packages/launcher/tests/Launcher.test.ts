/**
 * Launcher orchestrator unit tests (QR-pairing).
 *
 * Clerk is GONE from the PC. The launcher mints the data-path JWT itself, brings
 * up the tunnel, renders the terminal QR (Ink), and serves the loopback pairing
 * page — all driven here with fakes (no real api spawn, no real cloudflared, no
 * real Ink/http). Asserts the boot order, the QR payload shape { gatewayBase,
 * pcId, token }, JWT minting, and the shutdown teardown order.
 */
import { describe, expect, it } from 'bun:test';

import type { ApiHealthBody } from '../src/ApiProcess.js';
import { Launcher, type LauncherDeps } from '../src/Launcher.js';
import { resolvePairingIdentity } from '../src/PairingIdentity.js';
import { TunnelRouter } from '../src/TunnelRouter.js';

const HEALTH: ApiHealthBody = { status: 'ok', uptime: 1 };

interface Trace {
  order: string[];
}

function makeDeps(trace: Trace) {
  const apiProcess = {
    started: false,
    alive: false,
    start() {
      this.started = true;
      this.alive = true;
      trace.order.push('api.start');
      return {} as never;
    },
    isAlive() {
      return this.alive;
    },
    waitUntilExit() {
      // Never resolves on its own in these tests (driven by signals).
      return new Promise<number | null>(() => {});
    },
    async stop() {
      this.alive = false;
      trace.order.push('api.stop');
    },
  };

  // Fake cloudflared supervisor so the TunnelRouter never spawns a real binary.
  // Mirrors the real CloudflaredTunnel: onUrl fires (synchronously) BEFORE
  // waitForFirstUrl's promise resolves, so TunnelRouter.handleUrl — and the
  // registration handoff Launcher.boot() now awaits — really runs in these tests
  // instead of only resolving via waitForFirstRegistration's timeout fallback.
  let onUrlCb: ((url: string) => void) | undefined;
  const fakeCloudflared = {
    started: false,
    async start() {
      this.started = true;
      trace.order.push('tunnel.start');
      onUrlCb?.('https://fake-tunnel.trycloudflare.com');
    },
    async waitForFirstUrl() {
      return 'https://fake-tunnel.trycloudflare.com';
    },
    async stop() {
      this.started = false;
      trace.order.push('tunnel.stop');
    },
    getPublicUrl() {
      return 'https://fake-tunnel.trycloudflare.com';
    },
    isRunning() {
      return this.started;
    },
  };

  // Fake loopback pairing server.
  const pairingServer = {
    payload: '',
    async start() {
      trace.order.push('pairing.start');
      return 'http://localhost:54321/';
    },
    async stop() {
      trace.order.push('pairing.stop');
    },
    getUrl() {
      return 'http://localhost:54321/';
    },
  };

  // Fake terminal UI — ONE instance; mounts on booting, ready() switches to the
  // steady screen, showConnected swaps it in place (all via rerender, no remount).
  const connectedStates: Array<{ lastConnectedAt?: string }> = [];
  const deviceUpdates: unknown[][] = [];
  const chatUpdates: unknown[][] = [];
  let readyOpts: Record<string, unknown> | undefined;
  const statuses: string[] = [];
  const ui = {
    setStatus(s: string) {
      statuses.push(s); // not traced (would clutter the boot-order assertion)
    },
    ready(opts: Record<string, unknown>) {
      trace.order.push('ui.ready');
      readyOpts = opts;
    },
    stop() {
      trace.order.push('ui.stop');
    },
    showConnected(state: { lastConnectedAt?: string }) {
      trace.order.push('ui.showConnected');
      connectedStates.push(state);
    },
    setDevices(devices: unknown[]) {
      deviceUpdates.push(devices);
    },
    setChats(chats: unknown[]) {
      chatUpdates.push(chats);
    },
  };

  let tunnel: TunnelRouter | undefined;
  let capturedReviewerToken: string | undefined;
  let lastPayload = '';
  let lastUiOpts: Record<string, unknown> | undefined;
  let watchCb:
    | ((state: { firstConnectedAt?: string; lastConnectedAt?: string }) => void)
    | undefined;
  let presenceCb: ((devices: unknown[]) => void) | undefined;
  let chatsCb: ((chats: unknown[]) => void) | undefined;
  let healthOpts: Record<string, unknown> | undefined;

  const deps: LauncherDeps = {
    apiProcess: apiProcess as never,
    jwtSecret: 'local-secret',
    pcId: 'pc_test123',
    endpoint: 'https://app.portable.dev/t/pc_test123',
    label: 'my-mac',
    gatewayBase: 'https://app.portable.dev',
    githubLogin: 'octocat',
    prepareCredentials: async () => {
      trace.order.push('prepareCredentials');
    },
    mintToken: (secret: string) => {
      trace.order.push('mint');
      return `jwt-for-${secret}`;
    },
    makeTunnelRouter: (apiBaseUrl: string, reviewerToken?: string) => {
      capturedReviewerToken = reviewerToken;
      tunnel = new TunnelRouter({
        apiBaseUrl,
        makeCloudflaredTunnel: (opts) => {
          onUrlCb = opts.onUrl;
          return fakeCloudflared as never;
        },
        log: () => {},
      });
      return tunnel;
    },
    makePairingServer: (payload: string) => {
      lastPayload = payload;
      pairingServer.payload = payload;
      return pairingServer as never;
    },
    startUi: (async (opts) => {
      trace.order.push('ui.start');
      lastUiOpts = opts as unknown as Record<string, unknown>;
      return ui;
    }) as LauncherDeps['startUi'],
    startConnectionWatch: ((onConnected) => {
      trace.order.push('watch.start');
      watchCb = onConnected as typeof watchCb;
      return { stop: () => trace.order.push('watch.stop') };
    }) as LauncherDeps['startConnectionWatch'],
    startPresenceWatch: ((onPresence) => {
      presenceCb = onPresence as typeof presenceCb;
      return { stop: () => trace.order.push('presence.stop') };
    }) as LauncherDeps['startPresenceWatch'],
    startChatsWatch: ((_load, onChats) => {
      chatsCb = onChats as typeof chatsCb;
      return {
        refresh: () => trace.order.push('chats.refresh'),
        stop: () => trace.order.push('chats.stop'),
      };
    }) as LauncherDeps['startChatsWatch'],
    startTunnelHealthMonitor: ((opts) => {
      healthOpts = opts as unknown as Record<string, unknown>;
      return { stop: () => trace.order.push('health.stop') };
    }) as LauncherDeps['startTunnelHealthMonitor'],
    waitForHealthImpl: (async () => {
      trace.order.push('waitForHealth');
      return HEALTH;
    }) as never,
    renderQr: (async () => 'QR') as LauncherDeps['renderQr'],
    env: { VGIT_PORT: '6001' },
    log: () => {},
  };
  return {
    deps,
    apiProcess,
    getTunnel: () => tunnel,
    getReviewerToken: () => capturedReviewerToken,
    getPayload: () => lastPayload,
    getUiOpts: () => lastUiOpts,
    getReadyOpts: () => readyOpts,
    getHealthOpts: () => healthOpts,
    getConnectedStates: () => connectedStates,
    getDeviceUpdates: () => deviceUpdates,
    getChatUpdates: () => chatUpdates,
    fireConnected: (state: { firstConnectedAt?: string; lastConnectedAt?: string }) =>
      watchCb?.(state),
    firePresence: (devices: unknown[]) => presenceCb?.(devices),
    fireChats: (chats: unknown[]) => chatsCb?.(chats),
  };
}

describe('Launcher.boot', () => {
  it('mounts the booting box, then api → health → mint → tunnel → pairing → ready — in order', async () => {
    const trace: Trace = { order: [] };
    const { deps, getPayload, getUiOpts, getReadyOpts } = makeDeps(trace);
    const launcher = new Launcher(deps);

    const result = await launcher.boot();

    // The UI mounts FIRST (booting box), then the runtime comes up, then ready().
    expect(trace.order).toEqual([
      'prepareCredentials',
      'ui.start',
      'api.start',
      'waitForHealth',
      'mint',
      'tunnel.start',
      'pairing.start',
      'ui.ready',
    ]);
    expect(result.apiBaseUrl).toBe('http://127.0.0.1:6001');
    expect(result.health.status).toBe('ok');
    expect(result.token).toBe('jwt-for-local-secret');
    expect(result.loopbackUrl).toBe('http://localhost:54321/');

    // The QR payload carries exactly { gatewayBase, pcId, token }.
    const payload = JSON.parse(getPayload()) as Record<string, unknown>;
    expect(payload).toEqual({
      gatewayBase: 'https://app.portable.dev',
      pcId: 'pc_test123',
      token: 'jwt-for-local-secret',
    });
    expect(result.payload).toBe(getPayload());

    // Mounted on the booting box with the PC identity.
    expect(getUiOpts()).toMatchObject({
      endpoint: 'https://app.portable.dev/t/pc_test123',
      pcId: 'pc_test123',
      label: 'my-mac',
      initialPhase: 'booting',
    });
    // ready() carried the rendered QR + the loopback fallback + the steady phase.
    expect(getReadyOpts()).toMatchObject({
      qr: 'QR',
      phase: 'pairing',
      loopbackUrl: 'http://localhost:54321/',
    });
  });

  it('does NOT show the pairing QR/loopback page until the tunnel registration handoff settles', async () => {
    // Regression test for the premature-QR bug: the launcher used to render the QR
    // and serve the loopback page the instant cloudflared printed a URL, while the
    // registration agent's DNS-verify + /tunnel/register POST was still running in
    // the background — so a user who scanned immediately hit a PC the relay didn't
    // know how to route to yet. boot() must now park on TunnelRouter's first
    // registration handoff before reaching the pairing/ready steps.
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);

    let resolveRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    let onUrlCb: ((url: string) => void) | undefined;
    const fakeCloudflared = {
      started: false,
      async start() {
        this.started = true;
        trace.order.push('tunnel.start');
        onUrlCb?.('https://fake-tunnel.trycloudflare.com');
      },
      async waitForFirstUrl() {
        return 'https://fake-tunnel.trycloudflare.com';
      },
      async stop() {
        this.started = false;
      },
      getPublicUrl() {
        return 'https://fake-tunnel.trycloudflare.com';
      },
      isRunning() {
        return this.started;
      },
    };

    deps.makeTunnelRouter = (apiBaseUrl: string) =>
      new TunnelRouter({
        apiBaseUrl,
        onTunnelUrl: async () => {
          trace.order.push('registration.started');
          await registrationGate;
          trace.order.push('registration.settled');
        },
        makeCloudflaredTunnel: (opts) => {
          onUrlCb = opts.onUrl;
          return fakeCloudflared as never;
        },
        log: () => {},
      });

    const launcher = new Launcher(deps);
    const bootPromise = launcher.boot();

    // Let every pending microtask up to (and including) tunnel.start() flush,
    // WITHOUT letting the still-pending registration settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trace.order).toContain('registration.started');
    expect(trace.order).not.toContain('pairing.start');
    expect(trace.order).not.toContain('ui.ready');

    resolveRegistration();
    await bootPromise;

    expect(trace.order.indexOf('registration.settled')).toBeLessThan(
      trace.order.indexOf('pairing.start')
    );
    expect(trace.order).toContain('ui.ready');
  });

  it('proceeds to show the QR (fail-open) when registration does not confirm within the timeout', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);
    const apiLogLines: string[] = [];
    deps.apiLog = (line) => apiLogLines.push(line);

    let onUrlCb: ((url: string) => void) | undefined;
    const fakeCloudflared = {
      started: false,
      async start() {
        this.started = true;
        onUrlCb?.('https://fake-tunnel.trycloudflare.com');
      },
      async waitForFirstUrl() {
        return 'https://fake-tunnel.trycloudflare.com';
      },
      async stop() {
        this.started = false;
      },
      getPublicUrl() {
        return 'https://fake-tunnel.trycloudflare.com';
      },
      isRunning() {
        return this.started;
      },
    };

    deps.makeTunnelRouter = (apiBaseUrl: string) =>
      new TunnelRouter({
        apiBaseUrl,
        // Never settles — simulates an unreachable relay.
        onTunnelUrl: () => new Promise<void>(() => {}),
        // Keep the fail-open ceiling tiny so this test doesn't wait out the real
        // 45s production default.
        firstRegistrationTimeoutMs: 20,
        makeCloudflaredTunnel: (opts) => {
          onUrlCb = opts.onUrl;
          return fakeCloudflared as never;
        },
        log: () => {},
      });

    const launcher = new Launcher(deps);
    const result = await launcher.boot();

    expect(result.payload).toBeTruthy();
    expect(apiLogLines.some((l) => l.includes('did not confirm within the timeout'))).toBe(true);
  });

  it('readies into the pairing QR by default — a PC that has never connected', async () => {
    const trace: Trace = { order: [] };
    const { deps, getUiOpts, getReadyOpts } = makeDeps(trace);
    // initialConnected is unset → first-run behavior.
    const launcher = new Launcher(deps);

    await launcher.boot();

    expect(getUiOpts()?.initialPhase).toBe('booting');
    expect(getReadyOpts()?.phase).toBe('pairing');
  });

  it('readies into the connected MENU once a device has connected, passing onQuit + lastConnectedAt', async () => {
    const trace: Trace = { order: [] };
    const { deps, getUiOpts, getReadyOpts } = makeDeps(trace);
    deps.initialConnected = true;
    deps.lastConnectedAt = '2026-06-27T10:00:00.000Z';
    const launcher = new Launcher(deps);

    let quitCalls = 0;
    await launcher.boot({ onQuit: () => quitCalls++ });

    expect(trace.order).not.toContain('watch.start');
    expect(getReadyOpts()).toMatchObject({ phase: 'connected', qr: 'QR' });

    // The menu's Quit key is wired to the launcher's finish() via onQuit.
    const opts = getUiOpts();
    expect(opts).toMatchObject({ pcId: 'pc_test123', label: 'my-mac' });
    expect(typeof opts?.onQuit).toBe('function');
    (opts?.onQuit as () => void)();
    expect(quitCalls).toBe(1);
  });

  it('live-swaps the QR for the menu IN PLACE when a device connects mid-session — no remount', async () => {
    const trace: Trace = { order: [] };
    const { deps, getReadyOpts, getConnectedStates, fireConnected } = makeDeps(trace);
    // Never connected before, non-debug → QR + a live watcher.
    deps.watchForConnection = true;
    const launcher = new Launcher(deps);

    await launcher.boot({ onQuit: () => {} });

    // Readies on the QR (single instance), with the watcher armed.
    expect(getReadyOpts()?.phase).toBe('pairing');
    expect(trace.order).toContain('ui.start');
    expect(trace.order).toContain('watch.start');

    // The api stamps the marker → the watcher fires → the SAME instance is
    // re-rendered into the menu (showConnected), NOT a second mount.
    fireConnected({ firstConnectedAt: 'x', lastConnectedAt: '2026-06-27T10:00:00.000Z' });

    expect(trace.order).toContain('ui.showConnected');
    // Exactly ONE ui.start the whole time — no remount, no second Ink instance.
    expect(trace.order.filter((s) => s === 'ui.start')).toHaveLength(1);
    expect(trace.order).not.toContain('ui.stop'); // the QR was NOT unmounted
    expect(getConnectedStates()).toEqual([
      { firstConnectedAt: 'x', lastConnectedAt: '2026-06-27T10:00:00.000Z' },
    ]);
  });

  it('feeds live device presence into the UI (right-hand column)', async () => {
    const trace: Trace = { order: [] };
    const { deps, getDeviceUpdates, firePresence } = makeDeps(trace);
    const launcher = new Launcher(deps);

    await launcher.boot();

    // A phone connects, then disconnects → each update reaches ui.setDevices.
    firePresence([{ id: 'sock1', appVersion: '1.0.27', connectedAt: 'x' }]);
    firePresence([]);

    expect(getDeviceUpdates()).toHaveLength(2);
    expect(getDeviceUpdates()[0]).toHaveLength(1);
    expect(getDeviceUpdates()[1]).toEqual([]);
  });

  it('feeds live recent chats into the UI (chats column)', async () => {
    const trace: Trace = { order: [] };
    const { deps, getChatUpdates, fireChats } = makeDeps(trace);
    const launcher = new Launcher(deps);

    await launcher.boot();

    fireChats([{ id: 'c1', title: 'Fix the bug' }]);
    expect(getChatUpdates()).toHaveLength(1);
    expect(getChatUpdates()[0]).toHaveLength(1);
  });

  it('does NOT watch when the PC has already connected (menu at boot)', async () => {
    const trace: Trace = { order: [] };
    const { deps, getReadyOpts } = makeDeps(trace);
    deps.initialConnected = true; // already connected → menu at boot
    deps.watchForConnection = false;
    const launcher = new Launcher(deps);

    await launcher.boot();

    expect(getReadyOpts()?.phase).toBe('connected');
    expect(trace.order).not.toContain('watch.start');
  });

  it('starts the tunnel self-heal monitor probing the relay + local health, cycle wired to the tunnel', async () => {
    const trace: Trace = { order: [] };
    const { deps, getHealthOpts, getTunnel } = makeDeps(trace);
    const launcher = new Launcher(deps);

    await launcher.boot();

    const opts = getHealthOpts();
    expect(opts).toBeDefined();
    // Probes the PUBLIC relay path the phone uses + the loopback api.
    expect(opts?.relayHealthUrl).toBe('https://app.portable.dev/t/pc_test123/api/health');
    expect(opts?.localHealthUrl).toBe('http://127.0.0.1:6001/api/health');
    // cycle() is wired to the live tunnel router.
    expect(typeof opts?.cycle).toBe('function');
    const tunnel = getTunnel();
    let cycled = false;
    if (tunnel) tunnel.cycle = () => (cycled = true);
    (opts?.cycle as () => void)();
    expect(cycled).toBe(true);
  });

  it('stops the tunnel self-heal monitor on shutdown', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);
    const launcher = new Launcher(deps);

    await launcher.boot();
    await launcher.shutdown();

    expect(trace.order).toContain('health.stop');
  });

  it('continues boot when prepareCredentials throws — a credential failure never blocks boot', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);
    // A corrupt secret store decrypt / fs write failure inside discovery or persist
    // can still throw despite the "never throws" contract; boot must swallow it.
    deps.prepareCredentials = async () => {
      trace.order.push('prepareCredentials');
      throw new Error('secret store decrypt failed');
    };
    const launcher = new Launcher(deps);

    // boot() RESOLVES (does not reject) and the rest of the sequence still ran.
    const result = await launcher.boot();

    expect(result.health.status).toBe('ok');
    expect(trace.order).toContain('api.start');
    expect(trace.order).toContain('ui.start');
    expect(trace.order.indexOf('prepareCredentials')).toBeLessThan(
      trace.order.indexOf('api.start')
    );
  });
});

describe('Launcher.boot — reviewerToken publish (PORTABLE_REVIEWER_PUBLISH opt-in)', () => {
  it('does NOT thread the minted JWT to makeTunnelRouter by default (the invariant)', async () => {
    const trace: Trace = { order: [] };
    const { deps, getReviewerToken } = makeDeps(trace);
    // Default env (no PORTABLE_REVIEWER_PUBLISH) — a NORMAL PC never publishes its JWT.
    const launcher = new Launcher(deps);

    await launcher.boot();

    expect(getReviewerToken()).toBeUndefined();
  });

  it('threads the minted JWT to makeTunnelRouter when opted in', async () => {
    const trace: Trace = { order: [] };
    const { deps, getReviewerToken } = makeDeps(trace);
    deps.env = { VGIT_PORT: '6001', PORTABLE_REVIEWER_PUBLISH: 'true' };
    const launcher = new Launcher(deps);

    const result = await launcher.boot();

    // The published reviewerToken is exactly the launcher-minted data-path JWT.
    expect(getReviewerToken()).toBe(result.token);
    expect(getReviewerToken()).toBe('jwt-for-local-secret');
  });

  it('stays OFF for a non-truthy flag value', async () => {
    const trace: Trace = { order: [] };
    const { deps, getReviewerToken } = makeDeps(trace);
    deps.env = { VGIT_PORT: '6001', PORTABLE_REVIEWER_PUBLISH: 'false' };
    const launcher = new Launcher(deps);

    await launcher.boot();

    expect(getReviewerToken()).toBeUndefined();
  });
});

describe('Launcher.boot — GitHub login resolved at MINT TIME', () => {
  /** Decode a JWT's payload (middle segment) without verifying — username check. */
  const decodeUsername = (token: string) =>
    (
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
        username: string;
      }
    ).username;

  it('mints the JWT with the login persisted DURING prepareCredentials (not the createLauncher-time value)', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);

    // Simulate a FIRST-EVER boot: no login in the store at createLauncher time, so
    // the static dep is absent; prepareCredentials persists it, and resolveGithubLogin
    // reads the store AT MINT TIME (after prepareCredentials).
    let persistedLogin: string | undefined; // absent until prepareCredentials runs
    deps.githubLogin = undefined; // createLauncher-time read = absent (the bug's source)
    deps.resolveGithubLogin = () => persistedLogin;
    deps.prepareCredentials = async () => {
      trace.order.push('prepareCredentials');
      persistedLogin = 'octocat'; // the device-flow/discovery just wrote .login
    };
    // Use the REAL mint path so resolvePairingIdentity sees the resolved login.
    delete deps.mintToken;

    const result = await launcherBoot(deps);

    // prepareCredentials ran BEFORE the mint, so the login is present at mint time.
    expect(decodeUsername(result.token)).toBe('octocat');
  });

  it('falls back to the sanitized hostname when no login is ever resolved', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);
    deps.githubLogin = undefined;
    deps.resolveGithubLogin = () => undefined;
    delete deps.mintToken;

    const result = await launcherBoot(deps);

    // Same fallback resolvePairingIdentity uses (os.hostname → sanitized token).
    const expected = resolvePairingIdentity({ pcId: deps.pcId }).username;
    expect(decodeUsername(result.token)).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  /** Run boot() and return its result (small helper to keep the cases terse). */
  async function launcherBoot(deps: LauncherDeps) {
    const launcher = new Launcher(deps);
    return launcher.boot();
  }
});

describe('Launcher.shutdown', () => {
  it('tears down ui → pairing → tunnel → api, and is idempotent', async () => {
    const trace: Trace = { order: [] };
    const { deps } = makeDeps(trace);
    const launcher = new Launcher(deps);

    await launcher.boot();
    await launcher.shutdown();
    await launcher.shutdown(); // second call is a no-op

    const teardown = trace.order.filter((s) =>
      ['ui.stop', 'pairing.stop', 'tunnel.stop', 'api.stop'].includes(s)
    );
    expect(teardown).toEqual(['ui.stop', 'pairing.stop', 'tunnel.stop', 'api.stop']);
  });
});
