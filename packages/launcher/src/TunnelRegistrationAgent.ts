import { randomUUID } from 'crypto';
import os from 'os';

import { resolveRelayBaseUrl } from './config.js';

import type { LocalSecretStore } from '@vgit2/shared/secrets';

/**
 * PC-side tunnel registration agent.
 *
 * The launcher OWNS the cloudflared tunnel; this agent is the piece that keeps
 * the hosted relay's {@link TunnelRegistry} pointed at the PC's CURRENT
 * `*.trycloudflare.com` URL so the mobile app can always be routed to the right
 * PC. It plugs into the {@link TunnelRouter}'s `onTunnelUrl` seam:
 *
 *  - On every tunnel (re)start / rotation, {@link onTunnelUrl} fires. When a
 *    {@link TunnelRegistrationAgentOptions.verifyUrl} seam is wired, the agent
 *    FIRST waits for the new URL to be genuinely live from the public internet
 *    (DNS resolves + the health path serves) BEFORE registering — see "Why verify
 *    before registering" below — then `POST`s `/tunnel/register`
 *    `{pcId, currentUrl, label, ttlMs}` to the relay. Registration is
 *    **`pcId`-keyed, with NO `Authorization` header and NO shared secret** —
 *    Clerk is gone from the PC. The `pcId` (a 122-bit uuid) lives only inside
 *    the QR, so possession of the QR is the single capability; the relay hardens
 *    this with a `*.trycloudflare.com` URL allowlist + a register rate-limit.
 *  - A failed register is retried with exponential backoff.
 *  - While a URL is live, the agent periodically `POST`s `/tunnel/heartbeat` to
 *    refresh the short TTL. A heartbeat that 404s (the TTL lapsed) transparently
 *    re-registers.
 *  - A rotation supersedes any in-flight register/heartbeat for the old URL via a
 *    generation token, so a stale retry can never re-publish a dead URL.
 *
 * The relay base is configurable via `PORTABLE_RELAY_URL` (self-host); the
 * agent logs the pcId + the per-PC relay endpoint so it can be surfaced on the
 * QR/pairing page. `fetch`/timer seams are injected so the whole
 * flow is unit-tested against a stubbed gateway (no real network).
 *
 * ## Why verify before registering (the cached-wrong window)
 *
 * A cloudflared quick-tunnel hostname does NOT resolve "instantly": `trycloudflare.com`
 * is NOT a wildcard zone — each tunnel's random hostname only enters DNS once
 * cloudflared registers it — and the zone publishes a **30-minute negative-cache
 * TTL** (SOA minimum 1800s). So if the gateway (the machine that proxies the phone
 * to our tunnel, and thus the machine that RESOLVES the trycloudflare host) queries
 * the hostname in the gap between "cloudflared printed the URL" and "the record is
 * visible to the gateway's resolver", it caches an NXDOMAIN for up to 30 minutes —
 * or, once DNS is up but the edge route isn't, gets a transient Cloudflare 530/1033.
 * Registering the URL the instant it's captured invites exactly that early query.
 *
 * The launcher learns the hostname only AFTER cloudflared registers it, so the
 * launcher itself successfully fetching `https://<url><healthPath>` proves the
 * AUTHORITATIVE record exists and the edge route is live. Gating registration on
 * that (the {@link TunnelRegistrationAgentOptions.verifyUrl} seam) means by the time
 * the gateway is told the URL — and first resolves it — the record is already good,
 * so the gateway gets a positive answer (no poison) on a live route (no 530). The
 * gate is **fail-open**: if verification can't confirm liveness within its own
 * timeout it registers anyway (logging a warning) — never leaving the PC
 * unreachable, since {@link TunnelHealthMonitor} still recovers a dead mapping by
 * cycling to a fresh (un-poisoned) hostname. With no `verifyUrl` wired the agent
 * registers immediately (the pre-existing behavior; all existing tests unchanged).
 */

/** Namespaced LocalSecretStore key for the persisted, stable pcId. */
export const PC_ID_KEY = 'tunnel:pc-id';

/** Default TTL the relay should keep a registration alive for (ms). Mirrors TunnelRegistry. */
export const DEFAULT_REGISTRATION_TTL_MS = 15_000;

/** Default heartbeat cadence (ms) — ~3 beats per TTL so a missed beat drops fast. */
export const DEFAULT_HEARTBEAT_MS = 5_000;

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number) => Promise<void>;
type SetTimer = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
type ClearTimer = (handle: ReturnType<typeof setTimeout>) => void;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TunnelRegistrationAgentOptions {
  /** Stable PC id — the routing key the relay maps to this PC (resolved via {@link resolvePcId}). */
  pcId: string;
  /** Human-friendly label shown on the PC-picker (defaults to the hostname). */
  label?: string;
  /** Relay base URL. Defaults to {@link resolveRelayBaseUrl} (`PORTABLE_RELAY_URL`). */
  relayBaseUrl?: string;
  /** Registration TTL hint sent to the relay (ms). Default {@link DEFAULT_REGISTRATION_TTL_MS}. */
  ttlMs?: number;
  /**
   * Apple-reviewer opt-in: the launcher-minted data-path JWT to PUBLISH to the
   * gateway on `/tunnel/register` (the wire field is `reviewerToken`). When set,
   * the register body carries it (re-sent on every (re-)register incl. rotation);
   * the heartbeat body NEVER does (the gateway preserves it across heartbeats).
   *
   * ⚠️ OPT-IN, default OFF — left undefined for every NORMAL PC so the register
   * body is byte-unchanged and the gateway holds NO data-path JWTs (invariant).
   * Set ONLY for the disposable Apple-reviewer box, gated upstream by
   * `PORTABLE_REVIEWER_PUBLISH` ({@link resolveReviewerPublish}).
   */
  reviewerToken?: string;
  /**
   * Apple-reviewer opt-in: the E2E pre-shared key (base64) to PUBLISH alongside
   * `reviewerToken` (the wire field is `reviewerE2eKey`). The QR-skip pairing is
   * unusable without it — E2E is mandatory on the relay data path, and the key
   * otherwise travels ONLY inside the pairing QR (portable.dev#15). Same opt-in,
   * default OFF, same re-send-on-register / never-on-heartbeat semantics as
   * `reviewerToken`.
   */
  reviewerE2eKey?: string;
  /** Heartbeat cadence (ms). Default {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** First retry backoff (ms). Default 1000. */
  initialBackoffMs?: number;
  /** Backoff ceiling (ms). Default 30000. */
  maxBackoffMs?: number;
  /** Max register attempts per URL before giving up (until the next rotation). Default 8. */
  maxRegisterAttempts?: number;
  /**
   * Optional public-liveness gate. When set, the agent awaits this on each fresh
   * URL (BEFORE the register POST) and only proceeds once it resolves — `true` =
   * verified live, `false`/throw = could not confirm (the agent registers anyway,
   * fail-open). Wired by the launcher to a `verifyPublicUrl(url, {path:'/api/health'})`
   * call so registration waits out the DNS-propagation + edge-route window (see the
   * class doc's "Why verify before registering"). The seam owns its OWN timeout —
   * the agent does not bound it. Omitted by default → register immediately (the
   * pre-existing behavior). NOT awaited on a heartbeat-driven re-register (the URL
   * was already verified live when it was first registered).
   */
  verifyUrl?: (url: string) => Promise<boolean>;
  /** fetch seam (injected in tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** sleep seam for backoff (injected in tests). Defaults to real setTimeout. */
  sleep?: SleepImpl;
  /** setTimeout seam for the heartbeat schedule (injected in tests). */
  setTimeoutImpl?: SetTimer;
  /** clearTimeout seam (injected in tests). */
  clearTimeoutImpl?: ClearTimer;
  /** Line sink. Defaults to console.log. */
  log?: (line: string) => void;
}

export class TunnelRegistrationAgent {
  private readonly pcId: string;
  private readonly label?: string;
  private readonly relayBaseUrl: string;
  private readonly ttlMs: number;
  private readonly reviewerToken?: string;
  private readonly reviewerE2eKey?: string;
  private readonly heartbeatMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRegisterAttempts: number;
  private readonly verifyUrl?: (url: string) => Promise<boolean>;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: SleepImpl;
  private readonly setTimeoutImpl: SetTimer;
  private readonly clearTimeoutImpl: ClearTimer;
  private readonly log: (line: string) => void;

  private currentUrl: string | null = null;
  /** Bumped on every URL handoff; a register/heartbeat loop aborts if it's stale. */
  private generation = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: TunnelRegistrationAgentOptions) {
    this.pcId = options.pcId;
    this.label = options.label;
    this.relayBaseUrl = (options.relayBaseUrl ?? resolveRelayBaseUrl()).replace(/\/$/, '');
    this.ttlMs = options.ttlMs ?? DEFAULT_REGISTRATION_TTL_MS;
    this.reviewerToken = options.reviewerToken;
    this.reviewerE2eKey = options.reviewerE2eKey;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxRegisterAttempts = options.maxRegisterAttempts ?? 8;
    this.verifyUrl = options.verifyUrl;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? realSleep;
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((h) => clearTimeout(h));
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The per-PC relay endpoint the mobile app reaches (surfaced on the QR/pairing page). */
  getEndpoint(): string {
    return `${this.relayBaseUrl}/t/${this.pcId}`;
  }

  getPcId(): string {
    return this.pcId;
  }

  /** The current registered URL, or null before the first handoff. */
  getCurrentUrl(): string | null {
    return this.currentUrl;
  }

  /**
   * Registration-agent seam wired into {@link TunnelRouter}'s `onTunnelUrl`. Called
   * with the public URL on first capture AND on every rotation/restart. Supersedes
   * any in-flight work for the previous URL and immediately (re-)registers.
   */
  onTunnelUrl = async (url: string): Promise<void> => {
    if (this.stopped) return;
    this.currentUrl = url;
    const gen = ++this.generation;
    this.cancelHeartbeat();
    // Wait out the DNS-propagation + edge-route window so the gateway's first
    // resolution of this URL lands on a live record (no negative-cache poison, no
    // 530). Fail-open + generation-checked — a rotation mid-verify supersedes us.
    if (this.verifyUrl) {
      await this.verifyPublicLiveness(url, gen);
      if (this.stopped || gen !== this.generation) return; // superseded during verify
    }
    await this.register(url, gen);
  };

  /** Stop heartbeating and abort any in-flight register loop. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.generation++; // invalidate any in-flight loop
    this.cancelHeartbeat();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private cancelHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.clearTimeoutImpl(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Await the {@link verifyUrl} gate for a fresh URL. Never throws and always
   * returns (fail-open): a `false`/throw just logs and lets registration proceed,
   * because NOT registering would strand the PC and the health monitor recovers a
   * genuinely-dead mapping anyway. The seam owns its own timeout.
   */
  private async verifyPublicLiveness(url: string, gen: number): Promise<void> {
    if (!this.verifyUrl) return;
    this.log(`[register] verifying ${url} is publicly live before registering…`);
    let ok = false;
    try {
      ok = await this.verifyUrl(url);
    } catch (err) {
      this.log(
        `[register] public verification errored (registering anyway): ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (this.stopped || gen !== this.generation) return; // superseded — caller bails
    if (ok) {
      this.log(`[register] ✓ ${url} verified publicly live`);
    } else {
      this.log(
        `[register] ⚠ could not verify ${url} publicly live within timeout — ` +
          `registering anyway (self-heal will recover if it's dead)`
      );
    }
  }

  /** Register the URL, retrying with exponential backoff. Starts heartbeating on success. */
  private async register(url: string, gen: number): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRegisterAttempts; attempt++) {
      if (this.stopped || gen !== this.generation) return; // superseded / stopped

      const body: Record<string, unknown> = {
        pcId: this.pcId,
        currentUrl: url,
        label: this.label,
        ttlMs: this.ttlMs,
      };
      // Apple-reviewer opt-in: publish the launcher-minted data-path JWT (and the
      // E2E PSK — mandatory-E2E pairing is unusable without it, portable.dev#15)
      // so the disposable reviewer box can serve them from the reviewer route.
      // Default OFF (both undefined) → a NORMAL PC's register body is
      // byte-unchanged and the gateway holds NO data-path credentials (invariant).
      // Re-sent on every (re-)register incl. rotation; the heartbeat body never
      // carries them.
      if (this.reviewerToken) {
        body.reviewerToken = this.reviewerToken;
      }
      if (this.reviewerE2eKey) {
        body.reviewerE2eKey = this.reviewerE2eKey;
      }

      const result = await this.post('/tunnel/register', body);

      if (gen !== this.generation || this.stopped) return; // a rotation landed mid-flight

      if (result.ok) {
        this.log(`[register] ✓ ${this.pcId} → ${this.getEndpoint()} (registered)`);
        this.scheduleHeartbeat(gen);
        return;
      }

      // Registration is pcId-keyed with no identity, so 401/403 no longer
      // means "bad Clerk sign-in / pcId owned by another account". The relay
      // returns them when the URL is REJECTED by the allowlist (must be
      // *.trycloudflare.com) or the register rate-limit is hit — neither is
      // transient, so backing off forever would spin. Surface and stop until the
      // next rotation.
      if (result.status === 401 || result.status === 403) {
        this.log(
          `[register] ✗ ${this.pcId} rejected (HTTP ${result.status}) — ` +
            `URL not allowlisted (*.trycloudflare.com) or register rate-limited`
        );
        return;
      }

      this.log(
        `[register] register failed (${result.error ?? `HTTP ${result.status}`}); ` +
          `attempt ${attempt}/${this.maxRegisterAttempts}`
      );
      if (attempt < this.maxRegisterAttempts) await this.sleep(this.backoffMs(attempt));
    }
    this.log(
      `[register] gave up registering ${this.pcId} after ${this.maxRegisterAttempts} attempts`
    );
  }

  private scheduleHeartbeat(gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    this.cancelHeartbeat();
    this.heartbeatTimer = this.setTimeoutImpl(() => {
      void this.heartbeat(gen);
    }, this.heartbeatMs);
  }

  private async heartbeat(gen: number): Promise<void> {
    if (this.stopped || gen !== this.generation) return;
    const url = this.currentUrl;
    if (!url) return;

    const result = await this.post('/tunnel/heartbeat', { pcId: this.pcId, ttlMs: this.ttlMs });
    if (this.stopped || gen !== this.generation) return;

    if (result.ok) {
      this.scheduleHeartbeat(gen);
      return;
    }

    // TTL lapsed (or the relay forgot us) — re-publish the current URL.
    if (result.status === 404) {
      this.log(`[register] heartbeat 404 — re-registering ${this.pcId}`);
      await this.register(url, gen);
      return;
    }

    if (result.status === 401 || result.status === 403) {
      // No identity on heartbeat — a 401/403 means the relay rejected the
      // pcId/URL or rate-limited; fall back to a full re-register (which logs the
      // allowlist/rate-limit hint and stops if it persists).
      this.log(
        `[register] heartbeat rejected (HTTP ${result.status}) — re-registering ${this.pcId}`
      );
      await this.register(url, gen);
      return;
    }

    // Transient failure — keep the cadence; the next beat retries.
    this.log(`[register] heartbeat failed (${result.error ?? `HTTP ${result.status}`}); retrying`);
    this.scheduleHeartbeat(gen);
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** (attempt - 1));
  }

  private async post(
    pathname: string,
    body: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; error?: string }> {
    // NO Authorization header — registration is pcId-keyed. The
    // capability is possession of the QR (which carries the pcId); the relay
    // hardens the open registration with a URL allowlist + rate-limit.
    try {
      const res = await this.fetchImpl(`${this.relayBaseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Resolve a stable pcId. Precedence: `PORTABLE_PC_ID` env → persisted value in the
 * shared LocalSecretStore → a freshly generated id (persisted for next time). The
 * pcId is a ROUTING KEY, not a secret (per the threat model), but it is stored in
 * the encrypted store for convenience since the launcher already has it open.
 */
export function resolvePcId(store: LocalSecretStore, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PORTABLE_PC_ID?.trim();
  if (fromEnv) return fromEnv;

  const existing = store.get(PC_ID_KEY)?.trim();
  if (existing) return existing;

  const generated = `pc_${randomUUID().replace(/-/g, '')}`;
  store.set(PC_ID_KEY, generated);
  return generated;
}

/** Resolve the PC label: `PORTABLE_PC_LABEL` env, else the machine hostname. */
export function resolvePcLabel(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PORTABLE_PC_LABEL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return os.hostname();
  } catch {
    return 'portable-pc';
  }
}
