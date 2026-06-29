/**
 * relaySocketTarget — address the Socket.IO handshake through the PC relay.
 *
 * The resolved relay base is the STABLE per-PC endpoint `<gatewayBase>/t/<pcId>`
 * (a path-PREFIXED URL — see `relayBaseForPc` / `getRelayUrl`). The online
 * gateway reverse-proxies ONLY paths that start with `/t/<pcId>` to the PC (it
 * strips the prefix so the PC sees a plain `/socket.io/...`); everything else
 * hits the gateway itself.
 *
 * `socket.io-client` does NOT put a URL's pathname into the engine.io request
 * path — it treats the pathname as the connection NAMESPACE and keeps the
 * engine.io path on the separate `path` option (default `/socket.io`). So
 * passing `<gatewayBase>/t/<pcId>` straight to `io()` is doubly wrong:
 *   1. the handshake is sent to `<gatewayBase>/socket.io/...` (NO `/t/<pcId>`
 *      prefix) → the relay's `pathFilter`/`handleUpgrade` ignore it (they only
 *      route `/t/...`), so it never reaches the PC — it falls through to the
 *      gateway, which answers 200 + HTML / drops the WS upgrade; and
 *   2. the namespace becomes `/t/<pcId>`, which the PC's default-namespace
 *      Socket.IO server would reject.
 * Result: the socket never connects (the symptom in local mode). REST is
 * unaffected because `fetch` appends the path to the URL literally.
 *
 * The fix: connect to the gateway ORIGIN and move the `/t/<pcId>` prefix into
 * the engine.io `path`, so the handshake hits `<gatewayBase>/t/<pcId>/socket.io`
 * — which the relay routes to the PC (stripping `/t/<pcId>` back to a plain
 * `/socket.io`) on the default `/` namespace.
 */
export interface RelaySocketTarget {
  /** Origin to hand `io()` (`<gatewayBase>`), so the namespace stays the default `/`. */
  origin: string;
  /** engine.io `path` carrying the relay prefix: `/t/<pcId>/socket.io`. */
  path: string;
}

/** engine.io path the PC's Socket.IO server listens on (after the relay strips `/t/<pcId>`). */
const SOCKET_PATH = '/socket.io';

/**
 * Split a resolved relay base (`<gatewayBase>/t/<pcId>`) into the Socket.IO
 * `{ origin, path }` connection target. See the file docblock for why this is
 * required.
 */
export function relaySocketTarget(relayUrl: string): RelaySocketTarget {
  // Capture `scheme://host[:port]` as the origin and the `/t/<pcId>` prefix
  // separately. The pcId is already percent-encoded (`relayBaseForPc`) and is
  // kept encoded here — the gateway's `splitRelayPath` decodes it.
  const match = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(relayUrl);
  if (!match) {
    // Defensive: `getRelayUrl` always yields an absolute http(s) URL (and
    // `buildSocket` skips a null), so this never fires in practice.
    return { origin: relayUrl, path: SOCKET_PATH };
  }

  const origin = match[1];
  const prefix = (match[2] ?? '').replace(/\/+$/, ''); // drop any trailing slash
  return { origin, path: `${prefix}${SOCKET_PATH}` };
}
