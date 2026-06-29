/**
 * Canonical CORS origin allow-list shared by the backend Socket.IO server
 * (`packages/api` `SocketIOService`) and the OAuth gateway (`packages/gateway`).
 *
 * Single source of truth so the React Native (Expo) client and the stable
 * online-gateway origin are matched by the same rules. Framework-free (no
 * Node/RN-only imports) so the RN client can import it for tests without pulling
 * in `dotenv` via the bare `@vgit2/shared` entry.
 *
 * Local-first runtime: the runtime is the user's PC behind the online relay.
 * The allow-list covers the stable online-gateway origin + the RN client (plus
 * the legacy mobile-webview origins, kept for regression safety).
 */

/**
 * Expo / React Native origin patterns.
 *
 * A bare RN `fetch` / Socket.IO handshake sends NO `Origin` header (treated as
 * an allowed native request — see {@link isAllowedCorsOrigin}). When an `Origin`
 * IS present it is the app's scheme: `exp://…` (Expo Go / dev client) or a
 * custom standalone scheme such as `exp+portable://`. The exact value must be
 * confirmed on a device build; both shapes are covered here.
 */
export const EXPO_RN_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^exp:\/\//, // Expo Go / dev client
  /^exp\+[\w.-]+:\/\//, // Expo custom dev-client scheme (exp+<slug>://)
];

/** Legacy mobile-webview origins — must remain accepted for regression safety. */
export const CAPACITOR_ORIGINS: readonly string[] = [
  'capacitor://localhost', // iOS mobile-webview origin
  'https://localhost', // Android mobile-webview origin (HTTPS scheme)
];

/**
 * Stable online-gateway / relay origins.
 *
 * Local-first routing sends every client through the hosted relay/gateway at a
 * stable endpoint (`PORTABLE_RELAY_URL`, default `app.portable.dev`). Both prod +
 * dev hosts are listed.
 */
export const ONLINE_GATEWAY_ORIGINS: readonly string[] = [
  'https://app.portable.dev', // production relay/gateway
  'https://app.portable-dev.com', // staging/dev relay/gateway
];

/**
 * Canonical mobile-client allow-list (legacy mobile-webview + online gateway + Expo RN).
 * Used directly by the Socket.IO `cors.origin` array and by the gateway's
 * dynamic origin check.
 */
export const MOBILE_CORS_ORIGINS: ReadonlyArray<string | RegExp> = [
  ...CAPACITOR_ORIGINS,
  ...ONLINE_GATEWAY_ORIGINS,
  ...EXPO_RN_ORIGIN_PATTERNS,
];

/**
 * True when `origin` looks like a request from the native React Native (Expo)
 * client: either no/`null` `Origin` header (the common native case) or an
 * `exp://` / `exp+<slug>://` scheme.
 */
export function isExpoRnOrigin(origin: string | null | undefined): boolean {
  if (origin == null || origin === '' || origin === 'null') return true;
  return EXPO_RN_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

/** Match a concrete `origin` string against an allow-list of strings/RegExps. */
export function originMatches(origin: string, allowList: ReadonlyArray<string | RegExp>): boolean {
  return allowList.some((allowed) =>
    typeof allowed === 'string' ? origin === allowed : allowed.test(origin)
  );
}

/**
 * Predicate over the canonical mobile allow-list.
 *
 * - No/empty/`null` `Origin` (native RN request) → allowed.
 * - `exp://` / `exp+<slug>://` (Expo) → allowed.
 * - `https://app.portable.dev`, `https://app.portable-dev.com` (online gateway),
 *   `capacitor://localhost`, `https://localhost` → still allowed (regression).
 * - Anything else → rejected.
 */
export function isAllowedCorsOrigin(origin: string | null | undefined): boolean {
  if (origin == null || origin === '' || origin === 'null') return true;
  return originMatches(origin, MOBILE_CORS_ORIGINS);
}
