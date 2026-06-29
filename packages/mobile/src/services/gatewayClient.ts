/**
 * gatewayClient — typed HTTP surface for the `/auth/mobile/react-native/*`
 * gateway routes.
 *
 * Every call is Header/Bearer only and NEVER sends cookies (`credentials:
 * 'omit'`), matching the gateway contract. Responses are typed via the
 * single-source-of-truth `MobileRn*` interfaces from `@vgit2/shared/types`, so
 * the wire shape cannot drift between the gateway and this client.
 *
 * Later auth/provisioning flows build on top of these
 * primitives; this module intentionally has no React/Expo dependencies so it is
 * trivially unit-testable with a mocked `fetch`.
 */

import type {
  MobileRnAppleReviewerCredentialsResponse,
  MobileRnClerkExchangeResponse,
  MobileRnConfigResponse,
  MobileRnDeleteAccountResponse,
  MobileRnFirstPcConnectionRequest,
  MobileRnFirstPcConnectionResponse,
  MobileRnMeResponse,
  MobileRnRefreshResponse,
  MobileRnScopeUpgradeUrlResponse,
  MobileRnUtmRequest,
  MobileRnUtmResponse,
} from '@vgit2/shared/types';

/** Base path for all React Native gateway routes. */
export const MOBILE_RN_BASE = '/auth/mobile/react-native';

/** Thrown when the gateway responds with a non-2xx status. */
export class GatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export interface GatewayClientOptions {
  /** Fixed Gateway base URL (no trailing slash). */
  gatewayUrl: string;
  /** Injectable fetch (defaults to global fetch) — eases testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Response of the gateway's public `GET /api/min-version-v2`.
 *
 * The route is NOT RN-namespaced — it is an EXISTING gateway endpoint (it reads
 * the gateway `package.json` version, kept
 * in lockstep with the apps via `scripts/bump-version.sh`). Declared locally
 * (not in `@vgit2/shared`) so the version gate is fully self-contained and adds
 * NO gateway/shared changes.
 */
export interface MinVersionResponse {
  /**
   * Minimum required app version, e.g. `"1.5.0"`. Only major.minor are compared
   * (patch is ignored) — see `meetsMinimumVersion` in `features/version-update`.
   */
  minimumVersion: string;
}

export class GatewayClient {
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayClientOptions) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (!this.gatewayUrl) {
      // An empty base URL makes every request hit a relative path and fail with
      // no obvious cause — the #1 silent sign-in failure. Log loudly, don't throw
      // (this is constructed at ~9 sites, incl. the pre-sign-in shell).
      console.error(
        '[GatewayClient] gatewayUrl is empty — is EXPO_PUBLIC_GATEWAY_URL set? ' +
          '(restart Metro with --clear after editing .env)'
      );
    }
  }

  /** Build a fully-qualified URL for an RN route path. */
  url(path: string): string {
    return `${this.gatewayUrl}${MOBILE_RN_BASE}${path}`;
  }

  /** Header/Bearer-only headers — no cookies are ever attached. */
  private headers(authToken?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  }

  private request<T>(
    path: string,
    init: { method: string; authToken?: string; body?: unknown }
  ): Promise<T> {
    return this.send<T>(this.url(path), init);
  }

  /** Issue a request against a fully-qualified URL (cookies always omitted). */
  private async send<T>(
    fullUrl: string,
    init: { method: string; authToken?: string; body?: unknown }
  ): Promise<T> {
    const res = await this.fetchImpl(fullUrl, {
      method: init.method,
      headers: this.headers(init.authToken),
      // CRITICAL: omit credentials so cookies are never sent or stored.
      credentials: 'omit',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err?.error) message = err.error;
      } catch {
        /* non-JSON error body */
      }
      throw new GatewayHttpError(res.status, message);
    }

    return (await res.json()) as T;
  }

  /** POST /clerk-exchange — Clerk session → authToken + identity. */
  clerkExchange(clerkSessionToken: string): Promise<MobileRnClerkExchangeResponse> {
    return this.request<MobileRnClerkExchangeResponse>('/clerk-exchange', {
      method: 'POST',
      body: { clerkSessionToken },
    });
  }

  /** POST /refresh — re-issue a sliding 72h authToken (Bearer-authenticated). */
  refreshAuthToken(authToken: string): Promise<MobileRnRefreshResponse> {
    return this.request<MobileRnRefreshResponse>('/refresh', {
      method: 'POST',
      authToken,
    });
  }

  /** POST /scope-upgrade-url — GitHub scope-upgrade URL (Bearer-authenticated). */
  getScopeUpgradeUrl(
    authToken: string,
    returnTo: string,
    scopes?: string[]
  ): Promise<MobileRnScopeUpgradeUrlResponse> {
    return this.request<MobileRnScopeUpgradeUrlResponse>('/scope-upgrade-url', {
      method: 'POST',
      authToken,
      body: { returnTo, ...(scopes ? { scopes } : {}) },
    });
  }

  /** GET /me — authenticated user identity (Bearer-authenticated). */
  getMe(authToken: string): Promise<MobileRnMeResponse> {
    return this.request<MobileRnMeResponse>('/me', { method: 'GET', authToken });
  }

  /**
   * POST /utm — CLAIM a campaign UTM attribution for the authenticated user
   * (Bearer-only). The gateway derives the userId + email from
   * the VERIFIED token and runs `claimByIp` + (only for a real campaign)
   * `saveAttribution`. This NO LONGER marks `first_use_at` and does
   * NOT insert an empty organic row — the verified-signup activation mark + the
   * organic-row upsert moved to `reportFirstPcConnection` (`POST /first-pc-connection`).
   * An organic install (no campaign) effectively no-ops here.
   */
  reportUtm(authToken: string, payload: MobileRnUtmRequest): Promise<MobileRnUtmResponse> {
    return this.request<MobileRnUtmResponse>('/utm', { method: 'POST', authToken, body: payload });
  }

  /**
   * POST /first-pc-connection — mark the user's FIRST successful PC connection,
   * the local-first activation signal (Bearer-only). The gateway derives the
   * userId + email from the VERIFIED token (NEVER the body), upserts the
   * `user_attribution` row, and stamps `first_use_at` / `first_pc_connection_at`
   * (idempotent server-side). The client fires this once per pcId, fire-and-forget
   * — it must never block the connect, so a failure is simply ignored.
   */
  reportFirstPcConnection(
    authToken: string,
    payload: MobileRnFirstPcConnectionRequest
  ): Promise<MobileRnFirstPcConnectionResponse> {
    return this.request<MobileRnFirstPcConnectionResponse>('/first-pc-connection', {
      method: 'POST',
      authToken,
      body: payload,
    });
  }

  /**
   * POST /apple-reviewer-credentials — fetch the hosted-demo PC pairing triple for
   * the dedicated App-Store reviewer account (Bearer-only). On an `ALLOWED_EMAIL`
   * match the gateway returns `{ gatewayBase, pcId, token }` (the SAME shape the QR
   * carries) so the reviewer connects WITHOUT scanning a physical QR; every other
   * account gets a `403` (→ {@link GatewayHttpError}), which the caller treats as
   * "not a reviewer" and falls through to the normal QR flow (safe degradation).
   */
  getAppleReviewerCredentials(
    authToken: string
  ): Promise<MobileRnAppleReviewerCredentialsResponse> {
    return this.request<MobileRnAppleReviewerCredentialsResponse>('/apple-reviewer-credentials', {
      method: 'POST',
      authToken,
    });
  }

  /** GET /config — env-specific startup config (public, no secrets). */
  getConfig(): Promise<MobileRnConfigResponse> {
    return this.request<MobileRnConfigResponse>('/config', { method: 'GET' });
  }

  /** Build the URL for the EXISTING public min-version route (NOT RN-namespaced). */
  minVersionUrl(): string {
    return `${this.gatewayUrl}/api/min-version-v2`;
  }

  /**
   * GET /api/min-version-v2 — the public minimum-supported-app-version gate
   * (no auth, no cookies). The client
   * compares its own version against `minimumVersion` (major.minor only) and
   * blocks with an "update required" screen when behind. Throws
   * {@link GatewayHttpError} on non-2xx — the version gate treats any failure as
   * fail-open (never blocks on a bad/unreachable response).
   */
  getMinVersion(): Promise<MinVersionResponse> {
    return this.send<MinVersionResponse>(this.minVersionUrl(), { method: 'GET' });
  }

  /** Build the URL for the EXISTING account-deletion route (NOT RN-namespaced). */
  accountUrl(): string {
    return `${this.gatewayUrl}/auth/account`;
  }

  /**
   * DELETE /auth/account — permanently delete the authenticated user's account
   * (Bearer-authenticated, NO cookies). The caller signs out and routes to
   * sign-in on success.
   */
  deleteAccount(authToken: string): Promise<MobileRnDeleteAccountResponse> {
    return this.send<MobileRnDeleteAccountResponse>(this.accountUrl(), {
      method: 'DELETE',
      authToken,
    });
  }

  /**
   * POST /api/theme/save — persist the user's onboarding theme pick so
   * `ThemeSync` reads back the same theme on cold start (server-wins). The
   * gateway maps `themeId` to a full `ThemeOptions` via
   * `themeMapping.ts` and stores it in `user_themes`. A failure is tolerated
   * (fire-and-forget from `useOnboardingFlow.finalize`); the local pick remains.
   *
   * NOTE: `userId` must be the user's EMAIL — the gateway uses email as the
   * `user_themes` row key.
   */
  saveTheme(email: string, themeId: string): Promise<{ success: boolean }> {
    return this.send<{ success: boolean }>(`${this.gatewayUrl}/api/theme/save`, {
      method: 'POST',
      body: { userId: email, themeId },
    });
  }
}
