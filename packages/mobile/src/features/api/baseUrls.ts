/**
 * baseUrls — the SINGLE source-of-truth for the RN client's dual base-URL model.
 *
 * The native app talks to two distinct backends:
 *
 *   1. the FIXED **Gateway** URL — a non-secret build-time value
 *      (`EXPO_PUBLIC_GATEWAY_URL`, resolved once in `getGatewayUrl()`) that
 *      handles Clerk identity + PC discovery/link (reached via `GatewayClient`
 *      with ABSOLUTE URLs, not the routing table below). It NEVER changes for the
 *      life of the install.
 *   2. the **Sandbox base** — in the local-first model this is the
 *      STABLE per-PC relay endpoint `<gatewayBase>/t/<pcId>` derived from the
 *      connected PC id ({@link relayBaseForPc}). The gateway reverse-proxies it to
 *      the PC's current cloudflared tunnel and re-points by `pcId`, so the base is
 *      CONSTANT from the app's POV (no rotating URL) — a drop reconnects to the
 *      SAME endpoint. ALL chat/repo/runtime (`/api/*`) traffic and the
 *      Socket.IO handshake route here, over TLS, carrying the per-PC device token.
 *
 * Routing must be deterministic so that a sandbox-URL change can never send a
 * gateway call to the sandbox (or vice versa). {@link targetForPath} encodes the
 * small fixed allow-list of gateway path prefixes; EVERYTHING else routes to the
 * sandbox. {@link BaseUrlResolver} is the one place that maps a path → its
 * concrete base URL.
 *
 * No-stale-cache guarantee: the resolver re-reads the Sandbox URL from
 * SecureStore on EVERY resolution (it holds no cached copy), so after recovery
 * writes a new URL the very next fetch — and any freshly-built Socket.IO client,
 * which calls `getRelayUrl()` at creation time — observes it immediately.
 * `EXPO_PUBLIC_GATEWAY_URL` and the Sandbox SecureStore key each have exactly one
 * reader in the app (`getGatewayUrl` / `getRelayUrl`), verifiable by `ast-grep`.
 *
 * Framework-free (only `expo-secure-store` via the injected readers), so it is
 * trivially unit-testable with a mocked SecureStore + env.
 */

import { getGatewayUrl } from '../auth/gatewayConfig';
import { relayBaseForPc } from '../pc-connect/connectedPcStore';
import { getRelayUrl } from './relayUrlStore';

// Re-export the two canonical readers so every consumer can reach the dual
// base-URL surface from one module (the single source-of-truth). `relayBaseForPc`
// is the stable per-PC relay base `getRelayUrl()` now resolves to.
export { getGatewayUrl, getRelayUrl, relayBaseForPc };

/** Thrown when a sandbox call is attempted before provisioning wrote a URL. */
export class NoRelayUrlError extends Error {
  constructor() {
    super('No sandbox URL is available yet — provisioning has not completed.');
    this.name = 'NoRelayUrlError';
  }
}

/** Thrown when a gateway call is attempted but no Gateway URL is configured. */
export class MissingGatewayUrlError extends Error {
  constructor() {
    super('No Gateway URL is configured (EXPO_PUBLIC_GATEWAY_URL is empty).');
    this.name = 'MissingGatewayUrlError';
  }
}

/** Which backend a request targets. */
export type BaseUrlTarget = 'gateway' | 'sandbox';

/**
 * The allow-list of relative path prefixes that route to the FIXED Gateway.
 *
 * **Local-first: EMPTY.** The pre-pivot provisioning surface — the
 * namespaced RN routes (`/auth/mobile/react-native/*`) and the provisioning-progress
 * polling fallback (`/redis/progress`) — is gone, so NO relative path routes to the
 * gateway anymore. The gateway is reached ONLY via `GatewayClient` with ABSOLUTE URLs
 * (the sign-in `/clerk-exchange`/`/refresh`, account + version routes — `/my-pcs`/`/link-pc`
 * were dropped, the QR carries the PC-minted JWT); everything resolved through
 * this table (notably `/api/*` and the Socket.IO handshake) routes to the per-PC relay
 * base (`<gatewayBase>/t/<pcId>`).
 */
export const GATEWAY_PATH_PREFIXES = [] as const;

/** Decide which backend a (relative) path targets — pure, no I/O. */
export function targetForPath(path: string): BaseUrlTarget {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return GATEWAY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? 'gateway'
    : 'sandbox';
}

const ABSOLUTE_URL = /^https?:\/\//i;

export interface BaseUrlResolverDeps {
  /** Read the FIXED Gateway URL (default: build-time `getGatewayUrl`). */
  getGatewayUrl?: () => string;
  /** Read the MUTABLE Sandbox URL (default: SecureStore `getRelayUrl`). */
  getRelayUrl?: () => Promise<string | null>;
}

/**
 * The one authority that maps a path to its concrete base URL. Holds NO cached
 * URL — every call re-reads its source — so a sandbox re-point is observed by
 * the next request with zero invalidation step.
 */
export class BaseUrlResolver {
  private readonly readGatewayUrl: () => string;
  private readonly readSandboxUrl: () => Promise<string | null>;

  constructor(deps: BaseUrlResolverDeps = {}) {
    this.readGatewayUrl = deps.getGatewayUrl ?? getGatewayUrl;
    this.readSandboxUrl = deps.getRelayUrl ?? getRelayUrl;
  }

  /** Which backend the path routes to (pure). */
  targetForPath(path: string): BaseUrlTarget {
    return targetForPath(path);
  }

  /** Resolve the BASE URL (no path) for a request, fresh — never cached. */
  async baseUrlForPath(path: string): Promise<string> {
    if (targetForPath(path) === 'gateway') {
      const gateway = this.readGatewayUrl();
      if (!gateway) throw new MissingGatewayUrlError();
      return gateway.replace(/\/$/, '');
    }
    const sandbox = await this.readSandboxUrl();
    if (!sandbox) throw new NoRelayUrlError();
    return sandbox.replace(/\/$/, '');
  }

  /**
   * Resolve a relative path to a fully-qualified URL against the correct base
   * (an already-absolute `http(s)://` URL passes straight through).
   */
  async resolveUrl(path: string): Promise<string> {
    if (ABSOLUTE_URL.test(path)) return path;
    const base = await this.baseUrlForPath(path);
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
