/**
 * Sign-in ViewModel (MVVM ViewModel-as-hook) for the native Clerk sign-in screen.
 *
 * Encapsulates ALL sign-in logic so `SignInScreen` stays a thin view. Both paths
 * are NATIVE — no external browser web-redirect:
 *   - Social (GitHub / Google / Apple): Clerk's `useSSO().startSSOFlow` opens an
 *     in-app auth session and returns a `createdSessionId` natively.
 *   - Email/password: `useSignIn().signIn.create({ identifier, password })`.
 *
 * On success we activate the session and read the native Clerk session token via
 * `useAuth().getToken()`, handing it to `onAuthenticated` (exchanged
 * server-side for the Portable JWT).
 */

import { useCallback, useEffect, useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useAuth, useSignIn, useSSO } from '@clerk/clerk-expo';

import { GatewayHttpError } from '../../services/gatewayClient';

// Completes any pending in-app auth session when the app is foregrounded back
// from the native browser (Clerk Expo SSO requirement). No-op on a cold start.
void WebBrowser.maybeCompleteAuthSession();

export type SocialProvider = 'github' | 'google' | 'apple';

/**
 * Pre-warms the Android in-app browser so the SSO sheet opens instantly, and
 * cools it down on unmount (recommended by the Clerk Expo SSO guide). No-op on iOS.
 */
function useWarmUpBrowser(): void {
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

export interface UseSignInViewModelOptions {
  /** Invoked with the native Clerk session token once sign-in completes. */
  onAuthenticated?: (token: string | null) => void | Promise<void>;
}

export interface SignInViewModel {
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  isBusy: boolean;
  error: string | null;
  /** True once Clerk has hydrated (provider ready). */
  isReady: boolean;
  signInWithProvider: (provider: SocialProvider) => Promise<void>;
  signInWithEmail: () => Promise<void>;
}

// Inferred as `oauth_github` | `oauth_google` | `oauth_apple`, a subset of Clerk's
// `OAuthStrategy` — assignable without importing `@clerk/types` directly (which is
// nested under @clerk/clerk-expo, not at this package's resolution root).
function oauthStrategy(provider: SocialProvider) {
  return `oauth_${provider}` as const;
}

/**
 * Human-readable message for a failure in PHASE 2 (Clerk succeeded, but the
 * server-side Portable exchange failed). A `GatewayHttpError` carries the HTTP
 * status + the gateway's own error text, so we surface BOTH — this is the path
 * that was previously swallowed into an indistinguishable generic message.
 */
function describeExchangeError(err: unknown): string {
  if (err instanceof GatewayHttpError) {
    return `Signed in, but the Portable exchange failed (${err.status}): ${err.message}`;
  }
  return 'Signed in, but could not connect to Portable. Please try again.';
}

/**
 * Detects Clerk's `session_exists` error ("You're already signed in"). Clerk
 * surfaces it as a `clerkError` whose `errors[]` array carries the code — the
 * SDK does NOT throw a typed class we can `instanceof`, so we read the shape.
 * It means a Clerk session is already live (e.g. a prior sign-in whose Portable
 * exchange never completed / the Portable authToken was cleared but the Clerk
 * `tokenCache` survived) — NOT a bad credential. We reuse that session instead.
 */
function isSessionExistsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const errors = (err as { errors?: Array<{ code?: string }> }).errors;
  return Array.isArray(errors) && errors.some((e) => e?.code === 'session_exists');
}

export function useSignInViewModel(options: UseSignInViewModelOptions = {}): SignInViewModel {
  const { onAuthenticated } = options;
  useWarmUpBrowser();
  const { startSSOFlow } = useSSO();
  const { isLoaded, signIn, setActive } = useSignIn();
  const { getToken, isSignedIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Phase 1 (shared) ── Ensure a live Clerk session before the server-side
  // exchange. Skipped when one already exists (a prior sign-in whose Portable
  // exchange never completed) — re-running the flow would throw `session_exists`,
  // which we treat as "reuse it", not an error. `createSession` returns false when
  // it already surfaced a specific error (cancel / MFA); any other throw → `failMessage`.
  const ensureClerkSession = useCallback(
    async (createSession: () => Promise<boolean>, failMessage: string): Promise<boolean> => {
      if (isSignedIn) return true;
      try {
        return await createSession();
      } catch (err) {
        if (isSessionExistsError(err)) return true; // "Already signed in" → reuse it.
        console.error('[SignIn] Clerk sign-in failed:', err);
        setError(failMessage);
        return false;
      }
    },
    [isSignedIn]
  );

  // ── Phase 2 (shared) ── Read the freshly-activated native Clerk session token
  // and hand it to `onAuthenticated`, which exchanges it server-side for the
  // Portable authToken.
  const runExchange = useCallback(async () => {
    try {
      const token = await getToken();
      await onAuthenticated?.(token);
    } catch (err) {
      console.error('[SignIn] Clerk→Portable exchange failed:', err);
      setError(describeExchangeError(err));
    }
  }, [getToken, onAuthenticated]);

  const signInWithProvider = useCallback(
    async (provider: SocialProvider) => {
      if (isBusy) return;
      setIsBusy(true);
      setError(null);
      try {
        const ready = await ensureClerkSession(async () => {
          const { createdSessionId, setActive: ssoSetActive } = await startSSOFlow({
            strategy: oauthStrategy(provider),
            // In-app auth-session callback (NOT an external web app redirect).
            // `/sso-callback` has a matching route file (`app/sso-callback.tsx`) ON
            // PURPOSE — on Android the Custom-Tabs redirect arrives as a deep link
            // Expo Router navigates to, so without that route it flashes the
            // "Unmatched Route" screen during the handshake. Do NOT delete it.
            redirectUrl: Linking.createURL('/sso-callback'),
          });
          if (!createdSessionId || !ssoSetActive) {
            // No session means the flow was cancelled or needs extra steps (MFA, etc.).
            setError('Sign-in was not completed.');
            return false;
          }
          await ssoSetActive({ session: createdSessionId });
          return true;
        }, 'Could not sign in. Please try again.');
        if (ready) await runExchange();
      } finally {
        setIsBusy(false);
      }
    },
    [isBusy, ensureClerkSession, startSSOFlow, runExchange]
  );

  const signInWithEmail = useCallback(async () => {
    if (isBusy || !isLoaded || !signIn || !setActive) return;
    setIsBusy(true);
    setError(null);
    try {
      const ready = await ensureClerkSession(async () => {
        const attempt = await signIn.create({ identifier: email.trim(), password });
        if (attempt.status !== 'complete' || !attempt.createdSessionId) {
          setError('Additional verification is required to sign in.');
          return false;
        }
        await setActive({ session: attempt.createdSessionId });
        return true;
      }, 'Invalid email or password.');
      if (ready) await runExchange();
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, isLoaded, signIn, setActive, ensureClerkSession, email, password, runExchange]);

  return {
    email,
    password,
    setEmail,
    setPassword,
    isBusy,
    error,
    isReady: isLoaded ?? false,
    signInWithProvider,
    signInWithEmail,
  };
}
