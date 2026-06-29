/**
 * Gateway URL configuration for the native app.
 *
 * The fixed Gateway base URL handles auth, the Clerk→Portable exchange, token
 * refresh, and provisioning (the mutable per-user Sandbox base URL is resolved
 * later by provisioning — see the dual base-URL model). Like the
 * Clerk publishable key, the Gateway URL is a non-secret build-time value
 * resolved here in one testable place — this module is the ONLY reader of
 * `EXPO_PUBLIC_GATEWAY_URL` / `EXPO_PUBLIC_GATEWAY_URL_DEV` (ast-grep invariant).
 *
 * Dev mode: the hidden sign-in gesture flips `devModeStore`, and every
 * call re-consults it (no caching — a freshly built `GatewayClient` always sees
 * the current mode):
 *   - prod (default): `EXPO_PUBLIC_GATEWAY_URL` (e.g. localhost for local dev),
 *     falling back to the production gateway.
 *   - dev: `EXPO_PUBLIC_GATEWAY_URL_DEV`, falling back to the deployed dev gateway.
 */

import { isDevModeEnabled } from '../state/devModeStore';

/** Production gateway — the default backend for release builds. */
export const PROD_GATEWAY_URL = 'https://app.portable.dev';

/** Deployed dev/staging gateway — targeted while dev mode is on. */
export const DEV_GATEWAY_URL = 'https://app.portable-dev.com';

/** Env snapshot consumed by the pure resolver (injectable for tests). */
export interface GatewayUrlEnv {
  prodUrl?: string;
  devUrl?: string;
}

function readGatewayUrlEnv(): GatewayUrlEnv {
  return {
    prodUrl: process.env.EXPO_PUBLIC_GATEWAY_URL,
    devUrl: process.env.EXPO_PUBLIC_GATEWAY_URL_DEV,
  };
}

function orFallback(value: string | undefined, fallback: string): string {
  return value && value.trim() !== '' ? value : fallback;
}

/** Pure mode→URL resolution (the testable core of `getGatewayUrl`). */
export function resolveGatewayUrl(
  devMode: boolean,
  env: GatewayUrlEnv = readGatewayUrlEnv()
): string {
  return devMode
    ? orFallback(env.devUrl, DEV_GATEWAY_URL)
    : orFallback(env.prodUrl, PROD_GATEWAY_URL);
}

export function getGatewayUrl(): string {
  return resolveGatewayUrl(isDevModeEnabled());
}
