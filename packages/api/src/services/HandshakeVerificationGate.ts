/**
 * Kill switch for the outdated-native-build block.
 *
 * The block (refuse the Claude run for a pre-handshake native RN build that
 * sends no `appVersion`) is enforced in this in-sandbox api, but its on/off lever
 * lives in the GATEWAY: `GET ${GATEWAY_URL}/api/verify-handshake` reports the
 * gateway's `VERIFY_HANDSHAKE` env (`TF_VAR_VERIFY_HANDSHAKE`, default `false`).
 *
 * Why the gateway and not a sandbox env: the gateway is a single, fast-to-redeploy
 * control point, so the flag can be flipped from GitHub Actions WITHOUT rebuilding
 * or recreating every user sandbox. Running sandboxes pick up the change within
 * {@link HandshakeVerificationGate} `ttlMs`.
 *
 * FAIL-OPEN. Any failure (`GATEWAY_URL` unset, gateway unreachable, non-2xx, bad
 * JSON) resolves to `false` → the block is NOT enforced. Blocking on uncertainty
 * could lock every user out of their chats, so the only safe default is to never
 * block. The negative result is cached for the TTL too, so a down gateway is not
 * hammered on every message.
 */
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

/** Default positive/negative cache window. The kill switch propagates this fast. */
const DEFAULT_TTL_MS = 60_000;
/** Per-request budget — never let a hung gateway stall a chat message. */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface HandshakeVerificationGateDeps {
  /**
   * Resolve the gateway base URL. Read lazily (default `process.env.GATEWAY_URL`)
   * so a value set after construction is still seen; returns `undefined`/empty in
   * dev/tests where no gateway is configured (→ fail-open `false`).
   */
  getGatewayUrl?: () => string | undefined;
  /** Injectable fetch (tests). Defaults to {@link fetchWithTimeout}. */
  fetchImpl?: (url: string, options?: RequestInit, timeoutMs?: number) => Promise<Response>;
  /** Clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Cache TTL in ms (default 60s). */
  ttlMs?: number;
  /** Per-request timeout in ms (default 3s). */
  timeoutMs?: number;
}

export class HandshakeVerificationGate {
  private cached?: { value: boolean; at: number };
  private inFlight?: Promise<boolean>;

  private readonly getGatewayUrl: () => string | undefined;
  private readonly fetchImpl: (
    url: string,
    options?: RequestInit,
    timeoutMs?: number
  ) => Promise<Response>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(deps: HandshakeVerificationGateDeps = {}) {
    this.getGatewayUrl = deps.getGatewayUrl ?? (() => process.env.GATEWAY_URL);
    this.fetchImpl = deps.fetchImpl ?? fetchWithTimeout;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * True when the gateway reports `verifyHandshake: true`. Cached for `ttlMs`;
   * concurrent callers share one in-flight fetch. Never throws (fail-open `false`).
   */
  async isEnabled(): Promise<boolean> {
    const fresh = this.cached && this.now() - this.cached.at < this.ttlMs;
    if (fresh) return this.cached!.value;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchFlag()
      .catch(() => false)
      .then((value) => {
        this.cached = { value, at: this.now() };
        this.inFlight = undefined;
        return value;
      });
    return this.inFlight;
  }

  /**
   * Fire-and-forget warm-up so the FIRST outdated-client check after boot rarely
   * waits on the network. Safe to call any number of times; swallows errors.
   */
  prime(): void {
    void this.isEnabled().catch(() => {});
  }

  private async fetchFlag(): Promise<boolean> {
    const base = this.getGatewayUrl();
    if (!base) return false;
    const url = `${base.replace(/\/+$/, '')}/api/verify-handshake`;
    const res = await this.fetchImpl(url, { method: 'GET' }, this.timeoutMs);
    if (!res.ok) return false;
    const data = (await res.json()) as { verifyHandshake?: unknown };
    return data?.verifyHandshake === true;
  }
}
