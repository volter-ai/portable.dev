/**
 * TunnelRouter tests.
 *
 * The TunnelRouter owns the cloudflared supervisor and routes its rotating URL
 * to the registration-agent seam (onTunnelUrl). A fake cloudflared
 * supervisor is injected so no real binary/network is touched.
 */
import { describe, expect, it } from 'bun:test';

import type { CloudflaredTunnel } from '../src/CloudflaredTunnel.js';
import { TunnelRouter } from '../src/TunnelRouter.js';

/** A controllable fake of the CloudflaredTunnel surface TunnelRouter uses. */
function makeFakeCloudflared(opts: {
  firstUrl?: string;
  onUrlRef?: { fn?: (url: string) => void };
}) {
  let started = false;
  let publicUrl: string | null = null;
  const fake = {
    started: false,
    startCalls: 0,
    stopCalls: 0,
    cycleCalls: 0,
    cycle() {
      this.cycleCalls += 1;
    },
    async start() {
      started = true;
      this.started = true;
      this.startCalls += 1;
      // Mirror real cloudflared: capturing the URL fires onUrl (the handoff).
      if (opts.firstUrl) {
        publicUrl = opts.firstUrl;
        opts.onUrlRef?.fn?.(opts.firstUrl);
      }
    },
    async waitForFirstUrl() {
      if (opts.firstUrl) return opts.firstUrl;
      throw new Error('no url');
    },
    async stop() {
      started = false;
      this.started = false;
      this.stopCalls += 1;
    },
    getPublicUrl() {
      return publicUrl;
    },
    isRunning() {
      return started;
    },
    /** test helper to simulate a later rotation pushing a new URL */
    emit(url: string) {
      publicUrl = url;
      opts.onUrlRef?.fn?.(url);
    },
  };
  return fake;
}

describe('TunnelRouter.start', () => {
  it('starts cloudflared and routes the first URL to the registration seam', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const registered: string[] = [];

    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: (u) => registered.push(u),
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl; // capture so we can simulate rotations
        expect(o.localUrl).toBe('http://127.0.0.1:4200');
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });

    await router.start();
    expect(fake.startCalls).toBe(1);
    expect(router.isStarted()).toBe(true);
    expect(router.getPublicUrl()).toBe('https://r1.trycloudflare.com');
    expect(registered).toEqual(['https://r1.trycloudflare.com']);
  });

  it('routes a later rotation URL to the registration seam too', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const registered: string[] = [];
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: (u) => registered.push(u),
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    fake.emit('https://r2.trycloudflare.com'); // cloudflared rotated
    expect(registered).toEqual(['https://r1.trycloudflare.com', 'https://r2.trycloudflare.com']);
    expect(router.getPublicUrl()).toBe('https://r2.trycloudflare.com');
  });

  it('does not throw when the first URL times out — supervision continues', async () => {
    const fake = makeFakeCloudflared({}); // waitForFirstUrl rejects
    const lines: string[] = [];
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () => fake as unknown as CloudflaredTunnel,
      firstUrlTimeoutMs: 10,
      log: (l) => lines.push(l),
    });
    await router.start(); // resolves despite the URL timeout
    expect(fake.startCalls).toBe(1);
    expect(lines.some((l) => l.includes('still waiting'))).toBe(true);
  });

  it('propagates the install-hint error from cloudflared.start()', async () => {
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () =>
        ({
          async start() {
            throw new Error('cloudflared not found on PATH...');
          },
        }) as unknown as CloudflaredTunnel,
      log: () => {},
    });
    await expect(router.start()).rejects.toThrow(/cloudflared not found/i);
  });
});

describe('TunnelRouter.cycle', () => {
  it('delegates a self-heal rotation to the cloudflared supervisor', async () => {
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com' });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () => fake as unknown as CloudflaredTunnel,
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    router.cycle();
    expect(fake.cycleCalls).toBe(1);
  });

  it('is a no-op before start()', () => {
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com' });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () => fake as unknown as CloudflaredTunnel,
      log: () => {},
    });
    router.cycle();
    expect(fake.cycleCalls).toBe(0);
  });
});

describe('TunnelRouter.stop', () => {
  it('stops cloudflared and is idempotent', async () => {
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com' });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () => fake as unknown as CloudflaredTunnel,
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    await router.stop();
    await router.stop(); // no-op
    expect(fake.stopCalls).toBe(1);
    expect(router.isStarted()).toBe(false);
  });

  it('logs that no registration seam is wired', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const lines: string[] = [];
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: (l) => lines.push(l),
    });
    await router.start();
    expect(lines.some((l) => l.includes('no registration agent wired'))).toBe(true);
  });
});

describe('TunnelRouter.waitForFirstRegistration', () => {
  it('resolves true once the registration handoff settles', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    let resolveHandoff!: () => void;
    const handoff = new Promise<void>((resolve) => {
      resolveHandoff = resolve;
    });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: () => handoff,
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();

    const waitPromise = router.waitForFirstRegistration(1000);
    resolveHandoff();
    expect(await waitPromise).toBe(true);
  });

  it('resolves true immediately when no registration agent is wired', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    expect(await router.waitForFirstRegistration(1000)).toBe(true);
  });

  it('fails open: returns false once timeoutMs elapses without the handoff settling', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: () => new Promise<void>(() => {}), // never settles
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    expect(await router.waitForFirstRegistration(10)).toBe(false);
  });

  it('honors the constructor firstRegistrationTimeoutMs default', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com', onUrlRef });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: () => new Promise<void>(() => {}), // never settles
      firstRegistrationTimeoutMs: 10,
      makeCloudflaredTunnel: (o) => {
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    expect(await router.waitForFirstRegistration()).toBe(false);
  });

  it('fails open on timeout when start() was never called — no handoff ever fires', async () => {
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeCloudflaredTunnel: () => {
        throw new Error('should not be constructed — start() is never called');
      },
      log: () => {},
    });
    expect(await router.waitForFirstRegistration(10)).toBe(false);
  });
});

describe('TunnelRouter — provider-agnostic makeTunnel/tunnelBin seam', () => {
  it('uses makeTunnel and forwards tunnelBin as the spawned bin (ngrok path)', async () => {
    const onUrlRef: { fn?: (url: string) => void } = {};
    let receivedBin: string | undefined;
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.ngrok-free.app', onUrlRef });
    const registered: string[] = [];
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      onTunnelUrl: (u) => registered.push(u),
      tunnelBin: '/opt/ngrok',
      makeTunnel: (o) => {
        receivedBin = o.bin;
        onUrlRef.fn = o.onUrl;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    expect(receivedBin).toBe('/opt/ngrok');
    expect(router.getPublicUrl()).toBe('https://r1.ngrok-free.app');
    expect(registered).toEqual(['https://r1.ngrok-free.app']);
  });

  it('makeTunnel takes precedence over the deprecated makeCloudflaredTunnel alias', async () => {
    let usedGeneric = false;
    let usedAlias = false;
    const fake = makeFakeCloudflared({ firstUrl: 'https://r1.trycloudflare.com' });
    const router = new TunnelRouter({
      apiBaseUrl: 'http://127.0.0.1:4200',
      makeTunnel: () => {
        usedGeneric = true;
        return fake as unknown as CloudflaredTunnel;
      },
      makeCloudflaredTunnel: () => {
        usedAlias = true;
        return fake as unknown as CloudflaredTunnel;
      },
      firstUrlTimeoutMs: 1000,
      log: () => {},
    });
    await router.start();
    expect(usedGeneric).toBe(true);
    expect(usedAlias).toBe(false);
  });
});
