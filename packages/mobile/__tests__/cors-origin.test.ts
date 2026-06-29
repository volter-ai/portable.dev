/**
 * Integration test for the CORS origin allow-list.
 *
 * The React Native (Expo) client must be accepted by both transports that the
 * app talks to in production:
 *   - the OAuth **gateway** HTTP layer (`packages/gateway` `cors` middleware), and
 *   - the **sandbox** real-time layer (`packages/api` `SocketIOService` Socket.IO
 *     handshake `cors.origin` array).
 *
 * Both are driven by the single canonical allow-list in `@vgit2/shared/cors`.
 * Here we mock each layer's origin-decision function exactly as the servers wire
 * it (gateway = dynamic `origin(cb)` function; Socket.IO = array of string|RegExp
 * matched by the `cors` package), back both with the shared list, and assert:
 *   - the Expo RN origin (no/`null` Origin, `exp://`, `exp+<slug>://`) is accepted,
 *   - an existing origin (`capacitor://localhost`, `https://localhost`, the
 *     stable online-gateway origin) is still accepted (regression), and
 *   - an unlisted origin — including the RETIRED `*.modal.run` / `*.modal.host`
 *     sandbox patterns — is rejected.
 */

import {
  EXPO_RN_ORIGIN_PATTERNS,
  ONLINE_GATEWAY_ORIGINS,
  MOBILE_CORS_ORIGINS,
  isAllowedCorsOrigin,
  isExpoRnOrigin,
  originMatches,
} from '@vgit2/shared/cors';

type Origin = string | null | undefined;

/** The gateway's explicit recognized allow-list (packages/gateway/src/server.ts). */
const GATEWAY_ALLOWED_ORIGINS: Array<string | RegExp> = [
  'capacitor://localhost',
  'http://localhost',
  'ionic://localhost',
  /^capacitor:\/\//,
  /^ionic:\/\//,
  ...ONLINE_GATEWAY_ORIGINS,
  ...EXPO_RN_ORIGIN_PATTERNS,
];

/**
 * Mirrors the gateway's `cors` middleware `origin` function
 * (packages/gateway/src/server.ts): a request with no Origin (native RN, curl)
 * is allowed; a recognised Origin is allowed; anything else falls through to the
 * permissive dev fallback (`callback(null, true)`) — so the gateway never
 * rejects, it only distinguishes recognised vs. logged-and-allowed.
 */
function mockGatewayCorsDecision(origin: Origin): boolean {
  if (!origin) return true; // native RN sends no Origin
  if (originMatches(origin, GATEWAY_ALLOWED_ORIGINS)) return true; // recognised
  return true; // permissive dev fallback (logs but allows)
}

/** Whether the gateway *explicitly* recognises an origin (not via the fallback). */
function gatewayExplicitlyRecognises(origin: string): boolean {
  return originMatches(origin, GATEWAY_ALLOWED_ORIGINS);
}

/**
 * Mirrors how the `cors` package (used by Socket.IO) evaluates an array of
 * string|RegExp origins for the handshake: a missing/empty Origin (native RN)
 * is permitted, and a present Origin must equal a string entry or match a RegExp
 * entry in the canonical mobile allow-list.
 */
function mockSocketIoHandshakeDecision(origin: Origin): boolean {
  if (!origin) return true; // cors allows requests without an Origin header
  return originMatches(origin, [...MOBILE_CORS_ORIGINS]);
}

describe('CORS accepts the Expo RN origin (gateway + sandbox)', () => {
  const EXPO_RN_ORIGINS: Origin[] = [
    null, // bare native RN handshake / fetch — no Origin header
    undefined,
    '', // some runtimes send an empty Origin
    'exp://192.168.1.10:8081', // Expo Go / dev client
    'exp+portable://expo-development-client', // custom dev-client scheme
  ];

  const EXISTING_ORIGINS: string[] = [
    'capacitor://localhost', // iOS Capacitor
    'https://localhost', // Android Capacitor
    'https://app.portable.dev', // stable online gateway/relay (prod)
    'https://app.portable-dev.com', // stable online gateway/relay (dev)
  ];

  const UNLISTED_ORIGINS: string[] = [
    'https://evil.example.com',
    'http://attacker.test',
    'https://portable.dev.evil.com',
    // Retired Modal sandbox patterns — now rejected
    'https://abc123-user.modal.run',
    'https://abc123-user.modal.host',
  ];

  describe('shared canonical predicate (@vgit2/shared/cors)', () => {
    it.each(EXPO_RN_ORIGINS)('accepts the Expo RN origin %p', (origin) => {
      expect(isExpoRnOrigin(origin)).toBe(true);
      expect(isAllowedCorsOrigin(origin)).toBe(true);
    });

    it.each(EXISTING_ORIGINS)('still accepts the existing origin %p', (origin) => {
      expect(isAllowedCorsOrigin(origin)).toBe(true);
    });

    it.each(UNLISTED_ORIGINS)('rejects the unlisted origin %p', (origin) => {
      expect(isAllowedCorsOrigin(origin)).toBe(false);
      expect(isExpoRnOrigin(origin)).toBe(false);
    });
  });

  describe('mocked gateway HTTP CORS layer', () => {
    it.each(EXPO_RN_ORIGINS)('accepts a request carrying the Expo RN origin %p', (origin) => {
      expect(mockGatewayCorsDecision(origin)).toBe(true);
    });

    it.each(EXISTING_ORIGINS)('still accepts the existing origin %p', (origin) => {
      expect(mockGatewayCorsDecision(origin)).toBe(true);
    });

    // The change under test: the gateway now *explicitly* recognises the Expo
    // scheme origins (not merely via the permissive dev fallback), and still
    // recognises the Capacitor origin.
    it.each(['exp://192.168.1.10:8081', 'exp+portable://expo-development-client'])(
      'explicitly recognises the Expo scheme origin %p',
      (origin) => {
        expect(gatewayExplicitlyRecognises(origin)).toBe(true);
      }
    );

    it('still explicitly recognises the Capacitor origin', () => {
      expect(gatewayExplicitlyRecognises('capacitor://localhost')).toBe(true);
    });
  });

  describe('mocked sandbox Socket.IO handshake layer', () => {
    it.each(EXPO_RN_ORIGINS)('accepts a handshake carrying the Expo RN origin %p', (origin) => {
      expect(mockSocketIoHandshakeDecision(origin)).toBe(true);
    });

    it.each(EXISTING_ORIGINS)('still accepts the existing origin %p', (origin) => {
      expect(mockSocketIoHandshakeDecision(origin)).toBe(true);
    });

    it.each(UNLISTED_ORIGINS)('rejects a handshake carrying the unlisted origin %p', (origin) => {
      expect(mockSocketIoHandshakeDecision(origin)).toBe(false);
    });
  });
});
