import type { FC, ReactNode } from 'react';
import { ClerkProvider as RawClerkProvider, type TokenCache } from '@clerk/clerk-expo';

import { useDevModeStore } from '../state/devModeStore';
import { getClerkPublishableKey } from './clerkConfig';
import { tokenCache } from './tokenCache';

// `@clerk/clerk-expo`'s ClerkProvider resolves its `children` type against the
// React 18 type tree it peer-depends, while this package is on React 19 (whose
// `ReactNode` additionally includes `bigint`). Re-typing the component to a React
// 19 `FC` over the subset of props we actually use reconciles the two type trees.
const ClerkProvider = RawClerkProvider as unknown as FC<{
  publishableKey: string;
  tokenCache: TokenCache;
  children: ReactNode;
}>;

/**
 * App-wide Clerk provider for the native app.
 *
 * Wraps the whole Expo Router tree (mounted in `app/_layout.tsx`) so every screen
 * can use the native Clerk hooks (`useSSO`, `useSignIn`, `useAuth`, …). Social and
 * email/password sign-in happen NATIVELY — there is no external web-redirect dance.
 * The session token is persisted via the SecureStore-backed `tokenCache`.
 *
 * Dev mode: the provider subscribes to `devModeStore` and is KEYED on the
 * mode, so flipping it remounts `ClerkProvider` with the mode's publishable key
 * (the dev gateway runs its own Clerk instance) — Clerk's hooks re-initialise
 * against the right instance without an app restart.
 */
export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  const devMode = useDevModeStore((s) => s.enabled);
  return (
    <ClerkProvider
      key={devMode ? 'clerk-dev' : 'clerk-prod'}
      publishableKey={getClerkPublishableKey()}
      tokenCache={tokenCache}
    >
      {children}
    </ClerkProvider>
  );
}
