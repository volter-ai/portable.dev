/**
 * Clerk configuration for the native app.
 *
 * The publishable key is a PUBLIC value (safe to embed in the client bundle).
 * Expo exposes build-time env vars prefixed `EXPO_PUBLIC_` to the JS runtime; we
 * resolve them explicitly here so the value has a single, testable source — this
 * module is the ONLY reader of `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` /
 * `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV`.
 *
 * Dev mode: the dev gateway runs its own Clerk instance, so while dev
 * mode is on the optional `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV` wins (falling
 * back to the main key when unset — harmless when both environments share one
 * Clerk instance). `ClerkAuthProvider` remounts `ClerkProvider` on a mode flip so
 * the new key takes effect.
 */

import { isDevModeEnabled } from '../state/devModeStore';

/** Env snapshot consumed by the pure resolver (injectable for tests). */
export interface ClerkKeyEnv {
  prodKey?: string;
  devKey?: string;
}

function readClerkKeyEnv(): ClerkKeyEnv {
  return {
    prodKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    devKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY_DEV,
  };
}

/** Pure mode→key resolution (the testable core of `getClerkPublishableKey`). */
export function resolveClerkPublishableKey(
  devMode: boolean,
  env: ClerkKeyEnv = readClerkKeyEnv()
): string {
  const prodKey = env.prodKey ?? '';
  if (!devMode) return prodKey;
  return env.devKey && env.devKey.trim() !== '' ? env.devKey : prodKey;
}

export function getClerkPublishableKey(): string {
  return resolveClerkPublishableKey(isDevModeEnabled());
}
