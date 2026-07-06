/**
 * TunnelRegistrationAgent tests.
 *
 * The agent keeps the hosted relay pointed at the PC's current tunnel URL.
 * Registration is pcId-keyed with NO Authorization header and NO shared secret —
 * the gateway is stubbed via the fetch seam (no real network). Backoff/heartbeat
 * use injected sleep/timer seams so the suite is deterministic.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { resolveRelayBaseUrl, resolveReviewerPublish } from '../src/config.js';
import {
  TunnelRegistrationAgent,
  resolvePcId,
  resolvePcLabel,
  PC_ID_KEY,
} from '../src/TunnelRegistrationAgent.js';

interface Recorded {
  url: string;
  method?: string;
  auth?: string;
  body: Record<string, unknown>;
}

/** A stubbed gateway: records every request and replies with the queued status. */
function makeFakeGateway(plan: (req: Recorded) => number) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rec: Recorded = {
      url: input,
      method: init?.method,
      auth: headers.Authorization,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    requests.push(rec);
    const status = plan(rec);
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  };
  return { requests, fetchImpl };
}

/** A manual timer: captures the scheduled callback so the test fires heartbeats on demand. */
function makeManualTimer() {
  let pending: (() => void) | null = null;
  const setTimeoutImpl = (cb: () => void) => {
    pending = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutImpl = () => {
    pending = null;
  };
  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    async fire() {
      const cb = pending;
      pending = null;
      cb?.();
      // let the async heartbeat resolve
      await Promise.resolve();
      await Promise.resolve();
    },
    hasPending() {
      return pending !== null;
    },
  };
}

const RELAY = 'https://relay.example.com';

describe('TunnelRegistrationAgent.onTunnelUrl', () => {
  it('immediately registers the URL with NO Authorization header (pcId-keyed)', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_abc',
      label: 'my-mac',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    expect(gw.requests).toHaveLength(1);
    const req = gw.requests[0];
    expect(req.url).toBe(`${RELAY}/tunnel/register`);
    expect(req.method).toBe('POST');
    // Registration carries NO identity credential.
    expect(req.auth).toBeUndefined();
    expect(req.body).toMatchObject({
      pcId: 'pc_abc',
      currentUrl: 'https://r1.trycloudflare.com',
      label: 'my-mac',
    });
    expect(req.body.ttlMs).toBeGreaterThan(0);
    expect(agent.getCurrentUrl()).toBe('https://r1.trycloudflare.com');
    // A heartbeat is scheduled after a successful register.
    expect(timer.hasPending()).toBe(true);
    agent.stop();
  });

  it('re-registers the new URL on a rotation (still no auth header)', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_rot',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');
    await agent.onTunnelUrl('https://r2.trycloudflare.com'); // cloudflared rotated

    const registers = gw.requests.filter((r) => r.url.endsWith('/tunnel/register'));
    expect(registers).toHaveLength(2);
    expect(registers[0].body.currentUrl).toBe('https://r1.trycloudflare.com');
    expect(registers[1].body.currentUrl).toBe('https://r2.trycloudflare.com');
    expect(registers.every((r) => r.auth === undefined)).toBe(true);
    expect(agent.getCurrentUrl()).toBe('https://r2.trycloudflare.com');
    agent.stop();
  });

  it('retries register with backoff on a transient failure, then succeeds', async () => {
    let calls = 0;
    const gw = makeFakeGateway((r) => {
      if (r.url.endsWith('/tunnel/register')) {
        calls += 1;
        return calls < 3 ? 500 : 200; // fail twice, then succeed
      }
      return 200;
    });
    const slept: number[] = [];
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_retry',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      setTimeoutImpl: makeManualTimer().setTimeoutImpl,
      clearTimeoutImpl: () => {},
      initialBackoffMs: 100,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    expect(calls).toBe(3);
    // Two backoff sleeps with exponential growth (100, 200).
    expect(slept).toEqual([100, 200]);
    agent.stop();
  });

  it('does not retry forever on a 403 (allowlist/rate-limit rejection)', async () => {
    const gw = makeFakeGateway(() => 403);
    const slept: number[] = [];
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_owned',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    expect(gw.requests).toHaveLength(1); // single attempt, no backoff
    expect(slept).toEqual([]);
    agent.stop();
  });
});

describe('TunnelRegistrationAgent verifyUrl gate', () => {
  it('waits for verification to pass BEFORE registering the URL', async () => {
    const order: string[] = [];
    const gw = makeFakeGateway((r) => {
      if (r.url.endsWith('/tunnel/register')) order.push('register');
      return 200;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_verify',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: makeManualTimer().setTimeoutImpl,
      clearTimeoutImpl: () => {},
      verifyUrl: async () => {
        order.push('verify-start');
        await gate;
        order.push('verify-done');
        return true;
      },
      log: () => {},
    });

    const done = agent.onTunnelUrl('https://r1.trycloudflare.com');
    await Promise.resolve();
    // Verification has started but registration has NOT happened yet.
    expect(order).toEqual(['verify-start']);
    expect(gw.requests).toHaveLength(0);

    release();
    await done;
    // Only after verification completes does the register POST fire.
    expect(order).toEqual(['verify-start', 'verify-done', 'register']);
    expect(gw.requests).toHaveLength(1);
    agent.stop();
  });

  it('registers anyway (fail-open) when verification returns false', async () => {
    const gw = makeFakeGateway(() => 200);
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_failopen',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: makeManualTimer().setTimeoutImpl,
      clearTimeoutImpl: () => {},
      verifyUrl: async () => false, // could not confirm liveness within timeout
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    expect(gw.requests).toHaveLength(1);
    expect(gw.requests[0].body.currentUrl).toBe('https://r1.trycloudflare.com');
    agent.stop();
  });

  it('registers anyway (fail-open) when verification throws', async () => {
    const gw = makeFakeGateway(() => 200);
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_throw',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: makeManualTimer().setTimeoutImpl,
      clearTimeoutImpl: () => {},
      verifyUrl: async () => {
        throw new Error('verify exploded');
      },
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    expect(gw.requests).toHaveLength(1);
    agent.stop();
  });

  it('does NOT register a URL that was superseded by a rotation mid-verification', async () => {
    const gw = makeFakeGateway(() => 200);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_super',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: makeManualTimer().setTimeoutImpl,
      clearTimeoutImpl: () => {},
      verifyUrl: async (url) => {
        calls += 1;
        // The first URL's verification blocks until a rotation has landed.
        if (url === 'https://r1.trycloudflare.com') await firstGate;
        return true;
      },
      log: () => {},
    });

    const first = agent.onTunnelUrl('https://r1.trycloudflare.com'); // blocks in verify
    await Promise.resolve();
    const second = agent.onTunnelUrl('https://r2.trycloudflare.com'); // rotation supersedes
    await second;
    releaseFirst(); // first URL's verify now resolves, but its generation is stale
    await first;

    const registers = gw.requests.filter((r) => r.url.endsWith('/tunnel/register'));
    // Only the live (r2) URL is registered; the superseded r1 never is.
    expect(registers.map((r) => r.body.currentUrl)).toEqual(['https://r2.trycloudflare.com']);
    expect(calls).toBe(2);
    agent.stop();
  });

  it('does NOT verify on a heartbeat-driven re-register (only on fresh URLs)', async () => {
    const gw = makeFakeGateway((r) => {
      // First register OK; heartbeat 404 → triggers a re-register (also OK).
      if (r.url.endsWith('/tunnel/heartbeat')) return 404;
      return 200;
    });
    const timer = makeManualTimer();
    let verifyCalls = 0;
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_hb',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      verifyUrl: async () => {
        verifyCalls += 1;
        return true;
      },
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com'); // verifies once
    await timer.fire(); // heartbeat → 404 → re-register (must NOT re-verify)

    expect(verifyCalls).toBe(1);
    const registers = gw.requests.filter((r) => r.url.endsWith('/tunnel/register'));
    expect(registers).toHaveLength(2); // initial + heartbeat-404 re-register
    agent.stop();
  });
});

describe('TunnelRegistrationAgent heartbeat', () => {
  it('heartbeats after register and re-registers when the TTL has lapsed (404)', async () => {
    const gw = makeFakeGateway((r) => (r.url.endsWith('/tunnel/heartbeat') ? 404 : 200));
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_hb',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');
    expect(gw.requests.filter((r) => r.url.endsWith('/register'))).toHaveLength(1);

    await timer.fire(); // heartbeat fires -> 404 -> re-register

    const heartbeats = gw.requests.filter((r) => r.url.endsWith('/tunnel/heartbeat'));
    const registers = gw.requests.filter((r) => r.url.endsWith('/tunnel/register'));
    expect(heartbeats).toHaveLength(1);
    // Heartbeat carries no identity credential either.
    expect(heartbeats[0].auth).toBeUndefined();
    expect(heartbeats[0].body).toMatchObject({ pcId: 'pc_hb' });
    expect(registers).toHaveLength(2); // initial + re-register after 404
    agent.stop();
  });

  it('stop() cancels the heartbeat schedule', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_stop',
      relayBaseUrl: RELAY,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });
    await agent.onTunnelUrl('https://r1.trycloudflare.com');
    expect(timer.hasPending()).toBe(true);
    agent.stop();
    expect(timer.hasPending()).toBe(false);
  });
});

describe('TunnelRegistrationAgent reviewerToken (Apple-reviewer opt-in)', () => {
  const REVIEWER_JWT = 'header.payload.signature';
  const REVIEWER_PSK = 'reviewer-psk-base64';

  it('includes reviewerToken + reviewerE2eKey in the register body when opted in (re-sent on rotation)', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_reviewer',
      label: 'reviewer-box',
      relayBaseUrl: RELAY,
      reviewerToken: REVIEWER_JWT,
      reviewerE2eKey: REVIEWER_PSK,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');
    await agent.onTunnelUrl('https://r2.trycloudflare.com'); // rotation re-registers

    const registers = gw.requests.filter((r) => r.url.endsWith('/tunnel/register'));
    expect(registers).toHaveLength(2);
    // The published token + E2E key ride on EVERY register, including the rotation
    // re-register (the QR-skip path needs BOTH — a keyless triple is unusable under
    // mandatory E2E, portable.dev#15).
    expect(registers[0].body.reviewerToken).toBe(REVIEWER_JWT);
    expect(registers[1].body.reviewerToken).toBe(REVIEWER_JWT);
    expect(registers[0].body.reviewerE2eKey).toBe(REVIEWER_PSK);
    expect(registers[1].body.reviewerE2eKey).toBe(REVIEWER_PSK);
    // The rest of the body is unchanged.
    expect(registers[0].body).toMatchObject({
      pcId: 'pc_reviewer',
      currentUrl: 'https://r1.trycloudflare.com',
      label: 'reviewer-box',
    });
    agent.stop();
  });

  it('does NOT include reviewerToken/reviewerE2eKey by default (the invariant — a NORMAL PC never publishes its credentials)', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_normal',
      label: 'my-mac',
      relayBaseUrl: RELAY,
      // reviewerToken/reviewerE2eKey intentionally unset.
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');

    const register = gw.requests.find((r) => r.url.endsWith('/tunnel/register'));
    expect(register).toBeDefined();
    expect('reviewerToken' in register!.body).toBe(false);
    expect(register!.body.reviewerToken).toBeUndefined();
    expect('reviewerE2eKey' in register!.body).toBe(false);
    expect(register!.body.reviewerE2eKey).toBeUndefined();
    agent.stop();
  });

  it('NEVER includes reviewerToken in the heartbeat body, even when opted in', async () => {
    const gw = makeFakeGateway(() => 200);
    const timer = makeManualTimer();
    const agent = new TunnelRegistrationAgent({
      pcId: 'pc_reviewer_hb',
      relayBaseUrl: RELAY,
      reviewerToken: REVIEWER_JWT,
      fetchImpl: gw.fetchImpl,
      setTimeoutImpl: timer.setTimeoutImpl,
      clearTimeoutImpl: timer.clearTimeoutImpl,
      log: () => {},
    });

    await agent.onTunnelUrl('https://r1.trycloudflare.com');
    await timer.fire(); // heartbeat fires (200 → stays registered)

    const heartbeats = gw.requests.filter((r) => r.url.endsWith('/tunnel/heartbeat'));
    expect(heartbeats).toHaveLength(1);
    // The gateway preserves the token across heartbeats — the body must not carry it.
    expect('reviewerToken' in heartbeats[0].body).toBe(false);
    expect(heartbeats[0].body).toMatchObject({ pcId: 'pc_reviewer_hb' });
    agent.stop();
  });
});

describe('config + pc identity resolvers', () => {
  const saved = {
    relay: process.env.PORTABLE_RELAY_URL,
    pcId: process.env.PORTABLE_PC_ID,
    label: process.env.PORTABLE_PC_LABEL,
  };
  afterEach(() => {
    process.env.PORTABLE_RELAY_URL = saved.relay;
    process.env.PORTABLE_PC_ID = saved.pcId;
    process.env.PORTABLE_PC_LABEL = saved.label;
    if (saved.relay === undefined) delete process.env.PORTABLE_RELAY_URL;
    if (saved.pcId === undefined) delete process.env.PORTABLE_PC_ID;
    if (saved.label === undefined) delete process.env.PORTABLE_PC_LABEL;
  });

  it('resolveRelayBaseUrl honours PORTABLE_RELAY_URL (self-host) and strips trailing slash', () => {
    process.env.PORTABLE_RELAY_URL = 'https://my-relay.example.com/';
    expect(resolveRelayBaseUrl()).toBe('https://my-relay.example.com');
  });

  it('resolveRelayBaseUrl falls back to the default online gateway', () => {
    delete process.env.PORTABLE_RELAY_URL;
    expect(resolveRelayBaseUrl()).toBe('https://app.portable.dev');
  });

  it('resolvePcLabel honours PORTABLE_PC_LABEL, else the hostname', () => {
    process.env.PORTABLE_PC_LABEL = 'my-laptop';
    expect(resolvePcLabel()).toBe('my-laptop');
    delete process.env.PORTABLE_PC_LABEL;
    expect(resolvePcLabel().length).toBeGreaterThan(0);
  });

  it('resolvePcId prefers env, else persists a generated id in the store', () => {
    const map = new Map<string, string>();
    const store = {
      get: (k: string) => map.get(k),
      set: (k: string, v: string) => {
        map.set(k, v);
      },
    } as unknown as Parameters<typeof resolvePcId>[0];

    process.env.PORTABLE_PC_ID = 'pc_fromenv';
    expect(resolvePcId(store, process.env)).toBe('pc_fromenv');

    delete process.env.PORTABLE_PC_ID;
    const generated = resolvePcId(store, process.env);
    expect(generated.startsWith('pc_')).toBe(true);
    expect(map.get(PC_ID_KEY)).toBe(generated);
    // Stable across calls (reads the persisted value).
    expect(resolvePcId(store, process.env)).toBe(generated);
  });

  it('resolveReviewerPublish is ON only for true/1 (default OFF — Apple-reviewer opt-in)', () => {
    expect(resolveReviewerPublish({})).toBe(false); // unset → OFF (the invariant)
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: 'true' })).toBe(true);
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: '1' })).toBe(true);
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: 'TRUE' })).toBe(true);
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: 'false' })).toBe(false);
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: '0' })).toBe(false);
    expect(resolveReviewerPublish({ PORTABLE_REVIEWER_PUBLISH: 'yes' })).toBe(false);
  });
});
