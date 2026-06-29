/**
 * @vgit2/shared/types/mobileReactNative
 *
 * Typed request/response contracts for the new namespaced gateway routes used
 * exclusively by the Expo React Native client:
 *
 *   /auth/mobile/react-native/*
 *
 * These types are the single source of truth shared between the gateway route
 * handlers (`packages/gateway/src/routes/mobile-react-native.ts`) and the RN
 * client (`packages/mobile/src/services/gatewayClient.ts`). Keeping them here
 * guarantees the wire shape cannot drift between the two packages.
 *
 * Auth model: every route is Header/Bearer-only — NO cookies are accepted.
 * The bootstrap route (`clerk-exchange`) authenticates via a Clerk session
 * token in the JSON body; all other authenticated routes via
 * `Authorization: Bearer <authToken>`.
 */

/** Standard error envelope returned by every RN gateway route on failure. */
export interface MobileRnErrorResponse {
  error: string;
}

// ── POST /auth/mobile/react-native/clerk-exchange ──────────────────────────

/** Body for the Clerk session → authToken exchange (no cookies). */
export interface MobileRnClerkExchangeRequest {
  /** The native Clerk session token obtained via @clerk/clerk-expo. */
  clerkSessionToken: string;
}

/** Result of exchanging a Clerk session for a Portable authToken. */
export interface MobileRnClerkExchangeResponse {
  authToken: string;
  userId: string;
  username: string;
  email: string;
}

// ── POST /auth/mobile/react-native/refresh ─────────────────────────────────

/** Result of re-issuing a sliding 72h authToken (Bearer-authenticated). */
export interface MobileRnRefreshResponse {
  authToken: string;
}

// ── POST /auth/mobile/react-native/scope-upgrade-url ───────────────────────

/** Body requesting a GitHub scope-upgrade URL with an RN deep-link returnTo. */
export interface MobileRnScopeUpgradeUrlRequest {
  /** RN deep-link target the GitHub callback should ultimately return to. */
  returnTo: string;
  /** Optional GitHub scopes to request (defaults applied server-side). */
  scopes?: string[];
}

/** URL to open via expo-web-browser for the GitHub scope upgrade. */
export interface MobileRnScopeUpgradeUrlResponse {
  url: string;
}

// ── GET /auth/mobile/react-native/sandbox/status ───────────────────────────

/** Authoritative sandbox liveness (mirrors gateway UserService data shape). */
export interface MobileRnSandboxStatusResponse {
  running: boolean;
  url?: string;
  sandboxId?: string;
  state?: 'running' | 'stopped' | 'creating';
}

// ── POST /auth/mobile/react-native/sandbox/terminate ───────────────────────

/**
 * Result of the user-initiated "Restart sandbox" terminate (Bearer-only).
 *
 * A 200 ALWAYS means the restart may proceed: `hadSandbox:false` is the
 * idempotent no-op terminate (there was no active sandbox — re-provisioning
 * creates a fresh one regardless). Failures are returned as
 * {@link MobileRnErrorResponse} with a 4xx/5xx status (the RN
 * `GatewayClient.send` throws `GatewayHttpError` on any non-2xx), so a real
 * terminate failure surfaces to the user instead of becoming a silent no-op.
 */
export interface MobileRnSandboxTerminateResponse {
  success: true;
  /** false = no active sandbox existed (idempotent no-op terminate). */
  hadSandbox: boolean;
  /** Sandbox id that was terminated (present only when `hadSandbox`). */
  sandboxId?: string;
}

// ── GET /auth/mobile/react-native/config ───────────────────────────────────

/**
 * Env-specific startup configuration resolved by the gateway (NO secrets).
 * Lets the RN bundle stay environment-agnostic across dev/staging/prod.
 */
export interface MobileRnConfigResponse {
  /** Fixed Gateway base URL the RN client should target. */
  gatewayUrl: string;
  /** Logical environment name (e.g. "development", "staging", "production"). */
  environment: string;
  /** Non-secret Clerk publishable key for @clerk/clerk-expo. */
  clerkPublishableKey: string;
}

// ── GET /auth/mobile/react-native/me ───────────────────────────────────────

/** Authenticated user identity (mirrors gateway UserService getMe data). */
export interface MobileRnMeResponse {
  id: string;
  email: string;
  username: string;
  created_at: string;
}

// ── DELETE /auth/account (NOT under the RN namespace) ───────────────────────

/**
 * Response from the EXISTING gateway route `DELETE /auth/account` (Bearer-only).
 * The RN settings screen deletes the account, then signs out and routes to
 * sign-in — parity with the web `ProfilePage`. A `success:false` carries the
 * gateway `error` message for surfacing in the confirmation modal.
 */
export interface MobileRnDeleteAccountResponse {
  success: boolean;
  error?: string;
}

// ── POST /auth/mobile/react-native/utm ─────────────────────────────────────

/**
 * Body for the RN UTM attribution report (Bearer-authenticated — the userId +
 * email come from the VERIFIED authToken, NEVER the body, so a caller can only
 * ever attribute their OWN account). Every field is optional: an organic install
 * (no campaign deep link) sends an EMPTY body, which still ensures the user's
 * `user_attribution` row exists so they count as a "verified signup" (the
 * native app never visited the web landing page that creates the
 * fingerprint precapture row, and a missing row makes the UPDATE-only
 * `first_use_at` writer a no-op).
 */
export interface MobileRnUtmRequest {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  /** The deep-link URL the campaign UTM was captured from (debugging/parity). */
  landing_url?: string;
}

/**
 * Result of the RN UTM attribution report. The endpoint is best-effort (it
 * upserts the attribution row + marks `first_use_at`), so it ALWAYS returns
 * `{ ok: true }` on a 200 — the client never blocks on it.
 */
export interface MobileRnUtmResponse {
  ok: true;
}

// ── POST /auth/mobile/react-native/first-pc-connection ─────────────────────

/**
 * Body for the RN "first PC connection" report (Bearer-authenticated — the
 * userId comes from the VERIFIED authToken, never the body). The client reports
 * the `pcId` it has just successfully paired with so the gateway can mark the
 * account as having completed its first PC connection.
 */
export interface MobileRnFirstPcConnectionRequest {
  pcId: string;
}

/**
 * Result of the RN first-PC-connection report. Best-effort — it ALWAYS returns
 * `{ ok: true }` on a 200; the client never blocks on it.
 */
export interface MobileRnFirstPcConnectionResponse {
  ok: true;
}

// ── POST /auth/mobile/react-native/apple-reviewer-credentials ──────────────

/**
 * Pairing credentials for an Apple App Review reviewer account — lets the app
 * reviewer connect to a hosted demo PC without scanning a physical QR code.
 * Mirrors the QR payload shape (`{ gatewayBase, pcId, token }`) so the client
 * can feed it straight into the same `linkPc` save-only path.
 */
export interface MobileRnAppleReviewerCredentialsResponse {
  gatewayBase: string;
  pcId: string;
  token: string;
}
