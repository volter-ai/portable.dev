/**
 * Public-URL readiness: block until a tunnel's public hostname actually resolves
 * over PUBLIC DNS and then serves HTTP. Ported from volter-twin's world-runtime
 * (`waitForPublicDns` / `verifyPublicUrl`), but rewritten to pure `node:dns` +
 * `fetch` instead of shelling out to `dig` / `curl`, so it stays seam-injected and
 * unit-testable with no external binaries, no real network, and no real clock.
 *
 * WHY this exists. A cloudflared *quick* tunnel (`*.trycloudflare.com`) does NOT
 * resolve instantly: the zone is NOT a wildcard — each tunnel's random hostname
 * only enters DNS once cloudflared registers it — and it publishes a 30-min
 * negative-cache TTL (SOA minimum 1800s). So a resolver that queries the hostname
 * in the gap before the record propagates caches an NXDOMAIN for up to half an hour
 * (or, once DNS is up but the edge route isn't, gets a transient Cloudflare
 * 530/1033). A *named* tunnel with a CUSTOM hostname (`cloudflared tunnel route dns`)
 * has the same shape but a longer CNAME-propagation window. The readiness ladder
 * here closes that gap — DNS resolves → HTTPS health endpoint returns 2xx/3xx —
 * before the URL is handed out (the launcher uses it to gate tunnel registration;
 * see {@link TunnelRegistrationAgent}).
 *
 * The two pieces are independently useful:
 *  - {@link waitForPublicDns} — poll DNS until an A record appears. The default
 *    uses the host's OWN configured resolvers (NOT pinned public ones — see
 *    {@link defaultResolve4} for why), via `node:dns`'s `resolve4`. Callers who want
 *    GLOBAL-propagation semantics can pass {@link makePinnedResolver}.
 *  - {@link verifyPublicUrl} — wait for DNS, then GET the health path until it
 *    returns a success status, recording a {@link PublicVerification} receipt.
 *
 * All effects (`resolveImpl` / `fetchImpl` / `sleep` / `now` / `nowIso`) are
 * injected seams; the real defaults use `node:dns` + global `fetch` + the wall
 * clock.
 */

import { promises as dns } from 'node:dns';

/** Resolve a hostname's A records. Defaults to the system resolver's `resolve4`. */
export type ResolveImpl = (hostname: string) => Promise<string[]>;
/** fetch seam (injected in tests). */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number) => Promise<void>;

/**
 * Public recursive resolvers, exported for callers who explicitly want
 * global-propagation semantics (build a pinned resolver via {@link makePinnedResolver}).
 * NOT the default — see {@link defaultResolve4} for why the PC uses the SYSTEM resolver.
 */
export const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

/** Default overall budget for {@link waitForPublicDns} (ms). */
export const DEFAULT_DNS_TIMEOUT_MS = 60_000;
/** Default poll cadence between DNS attempts (ms). */
export const DEFAULT_DNS_INTERVAL_MS = 1_000;
/** Default overall budget for {@link verifyPublicUrl} (ms). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;
/** Default poll cadence between health GETs (ms). */
export const DEFAULT_VERIFY_INTERVAL_MS = 2_000;
/** Default per-request network timeout for a single health GET (ms). */
export const DEFAULT_VERIFY_REQUEST_TIMEOUT_MS = 10_000;

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const realSleep: SleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The default DNS resolver: query the host's OWN configured resolvers via `resolve4`.
 *
 * WHY the system resolver, not pinned public ones (1.1.1.1/8.8.8.8): this check runs
 * on the PC, and the thing it's a proxy for is "can the tunnel host be reached" — so
 * it must succeed wherever `cloudflared` itself works. Pinning to public resolvers
 * breaks on networks that block outbound DNS to them (locked-down corp / captive
 * Wi-Fi) even though the tunnel is perfectly fine there (the PC is the tunnel ORIGIN
 * — it makes OUTBOUND connections and never needs to resolve its own public hostname;
 * the GATEWAY is what resolves it). The negative-cache-bypass rationale for pinning
 * (volter-twin's `dig @1.1.1.1`, for verifying a custom hostname propagated GLOBALLY)
 * doesn't apply here: the PC's own resolver is never pre-poisoned — the quick-tunnel
 * hostname is random and the PC is the first thing to learn it. `resolve4` still does
 * a real DNS query against the configured servers (respecting split-horizon/corporate
 * DNS), and the subsequent health `fetch` uses the same system path. Callers who DO
 * want global-propagation semantics can pass {@link makePinnedResolver}.
 */
function defaultResolve4(hostname: string): Promise<string[]> {
  return dns.resolve4(hostname);
}

/**
 * Build a {@link ResolveImpl} pinned to specific recursive resolvers (default
 * {@link PUBLIC_DNS_SERVERS}). Opt-in — use when you specifically want to observe
 * GLOBAL public propagation (bypassing the host's resolver + caches), e.g. verifying
 * a named tunnel's custom hostname has propagated. NOT the launcher's default; see
 * {@link defaultResolve4}.
 */
export function makePinnedResolver(servers: string[] = PUBLIC_DNS_SERVERS): ResolveImpl {
  return (hostname: string) => {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    return resolver.resolve4(hostname);
  };
}

export interface WaitForPublicDnsOptions {
  /** Overall budget (ms). Default {@link DEFAULT_DNS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Poll cadence between attempts (ms). Default {@link DEFAULT_DNS_INTERVAL_MS}. */
  intervalMs?: number;
  /** DNS resolution seam. Default: the system resolver's `resolve4`. */
  resolveImpl?: ResolveImpl;
  /** sleep seam (injected in tests). */
  sleep?: SleepImpl;
  /** clock seam (injected in tests). Default `Date.now`. */
  now?: () => number;
  /** Line sink. Default: no-op (this is a polled inner loop). */
  log?: (line: string) => void;
}

/**
 * Poll public DNS until `hostname` resolves to an IPv4 address, or `timeoutMs`
 * elapses. Resolves with the first valid A record, or `undefined` on timeout
 * (never throws — a resolution error is just "not yet" and is retried).
 */
export async function waitForPublicDns(
  hostname: string,
  options: WaitForPublicDnsOptions = {}
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_DNS_INTERVAL_MS;
  const resolveImpl = options.resolveImpl ?? defaultResolve4;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  const started = now();
  for (;;) {
    let ip: string | undefined;
    try {
      const records = await resolveImpl(hostname);
      ip = records.find((record) => IPV4_RE.test(record.trim()))?.trim();
    } catch (err) {
      // NXDOMAIN / SERVFAIL / transient — just "not propagated yet"; retry.
      log(
        `[dns] ${hostname} not resolving yet: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (ip) return ip;
    if (now() - started >= timeoutMs) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * A receipt that a public URL was verified live: the host it resolved to + the
 * health response that confirmed it. Mirrors volter-twin's `publicVerification`.
 */
export interface PublicVerification {
  /** The health path that was probed (e.g. `/health`). */
  path: string;
  /** ISO timestamp of the successful check. */
  checkedAt: string;
  /** The hostname extracted from the public URL. */
  hostname: string;
  /** The IPv4 it resolved to over public DNS. */
  resolvedIp: string;
  /** The HTTP status that passed (2xx/3xx). */
  status: number;
  /** The response body, truncated to 500 chars. */
  body: string;
}

export interface VerifyPublicUrlOptions {
  /** Health path to probe. Default `/health`. */
  path?: string;
  /** Overall budget for the whole verification (ms). Default {@link DEFAULT_VERIFY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Budget for the DNS-propagation wait specifically (ms). Capped at the overall
   * `timeoutMs`. Default `min(timeoutMs, {@link DEFAULT_DNS_TIMEOUT_MS})`.
   */
  dnsTimeoutMs?: number;
  /** Poll cadence between health GETs (ms). Default {@link DEFAULT_VERIFY_INTERVAL_MS}. */
  intervalMs?: number;
  /** Poll cadence for the DNS wait (ms). Default {@link DEFAULT_DNS_INTERVAL_MS}. */
  dnsIntervalMs?: number;
  /** Per-request network timeout for one health GET (ms). Default {@link DEFAULT_VERIFY_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** fetch seam (injected in tests). Defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** DNS resolution seam. Default: the system resolver's `resolve4`. */
  resolveImpl?: ResolveImpl;
  /** sleep seam (injected in tests). */
  sleep?: SleepImpl;
  /** clock seam (injected in tests). Default `Date.now`. */
  now?: () => number;
  /** ISO-timestamp seam for `checkedAt` (injected in tests). Default `new Date().toISOString()`. */
  nowIso?: () => string;
  /** Line sink. Defaults to console.log. */
  log?: (line: string) => void;
}

/** Build the health URL: same origin as `publicUrl`, with `path` and no query/hash. */
export function publicHealthUrl(publicUrl: string, path: string): string {
  const url = new URL(publicUrl);
  url.pathname = path.startsWith('/') ? path : `/${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** GET a URL with an abort-timeout, returning the status + body text. Throws on network error. */
async function fetchStatusBody(
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const abortTimer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (abortTimer && typeof abortTimer.unref === 'function') abortTimer.unref();
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller?.signal });
    const body = await res.text().catch(() => '');
    return { status: res.status, body };
  } finally {
    if (abortTimer !== null) clearTimeout(abortTimer);
  }
}

/**
 * Verify a public URL is genuinely reachable from the internet: wait for its
 * hostname to resolve over public DNS, then GET its health path until it returns a
 * success status (>=200 <400) — recording the {@link PublicVerification} receipt.
 *
 * Throws if DNS never resolves within the DNS budget, or if the health endpoint
 * never returns a success status within the overall `timeoutMs` (the message
 * carries the last error / status seen).
 */
export async function verifyPublicUrl(
  publicUrl: string,
  options: VerifyPublicUrlOptions = {}
): Promise<PublicVerification> {
  const path = options.path ?? '/health';
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_VERIFY_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_VERIFY_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const log = options.log ?? ((line) => console.log(line));

  const hostname = new URL(publicUrl).hostname;
  const started = now();

  const dnsTimeoutMs = Math.min(options.dnsTimeoutMs ?? timeoutMs, DEFAULT_DNS_TIMEOUT_MS);
  log(`[verify] waiting for public DNS to resolve ${hostname} (≤${dnsTimeoutMs}ms)`);
  const resolvedIp = await waitForPublicDns(hostname, {
    timeoutMs: dnsTimeoutMs,
    intervalMs: options.dnsIntervalMs,
    resolveImpl: options.resolveImpl,
    sleep,
    now,
    log,
  });
  if (!resolvedIp) {
    throw new Error(
      `Public URL did not resolve through public DNS within ${dnsTimeoutMs}ms: ${hostname}`
    );
  }
  log(`[verify] ${hostname} → ${resolvedIp}; probing ${path} until healthy`);

  const target = publicHealthUrl(publicUrl, path);
  let lastError = '';
  while (now() - started < timeoutMs) {
    try {
      const { status, body } = await fetchStatusBody(fetchImpl, target, requestTimeoutMs);
      if (status >= 200 && status < 400) {
        return {
          path,
          checkedAt: nowIso(),
          hostname,
          resolvedIp,
          status,
          body: body.slice(0, 500),
        };
      }
      lastError = `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const remaining = Math.max(timeoutMs - (now() - started), 0);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(
    `Public URL did not pass health verification at ${target}: ${lastError || 'timed out'}`
  );
}
